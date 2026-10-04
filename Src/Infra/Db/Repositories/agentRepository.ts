/**
 * @module Repositories/agentRepository
 * @description Agent 注册表落库（多 Agent 核心，2026-10-03 新增）。
 *
 * 背景：`agents` 表自早期迁移就存在，但全仓**无任何 SQL 读写** —— 招募出的 Agent 只存在内存 Map，
 * 进程重启即消失，也无法按账号隔离，导致"多 Agent"实际上不可持久、不可审计。
 *
 * 职责：
 *  - 写入/更新 Agent 行（含父子关系、角色、Token 预算、迭代上限、工具白名单、任务提示词）；
 *  - 启动时按 owner 载入（`hydrateAgents`），使重启后 `getAllAgents()` 仍能看到既有 Agent；
 *  - 软销毁（`destroyed_at`），保留审计痕迹而不是直接删行。
 *
 * 注意：所有读写都按 `owner_user_id` 收敛（与项目其余个人数据一致）。
 */

import { getMainDb } from '../index.js';
import { getActiveOwner } from '../../AccountScope/activeAccount.js';
import { logger } from '../../Logging/logger.js';

/** Agent 行（`agents` 表） */
export interface AgentRow {
  agent_id: string;
  trace_id: string;
  parent_agent_id: string | null;
  role: string;
  system_prompt: string;
  task_prompt: string | null;
  allowed_tools: string | null;
  denied_tools: string | null;
  token_budget: number | null;
  max_iterations: number | null;
  timeout_ms: number | null;
  trust_level: string;
  sandbox_enabled: number;
  status: string;
  failure_count: number;
  created_at: number;
  destroyed_at: number | null;
  owner_user_id: string;
}

/** 落库所需的最小字段（未提供的用库默认值） */
export interface AgentPersistInput {
  agentId: string;
  traceId: string;
  parentAgentId?: string | null;
  role: string;
  systemPrompt?: string;
  taskPrompt?: string | null;
  allowedTools?: string[] | null;
  deniedTools?: string[] | null;
  tokenBudget?: number | null;
  maxIterations?: number | null;
  timeoutMs?: number | null;
  trustLevel?: string;
  status?: string;
  createdAt?: number;
}

/** 新增或更新一个 Agent（按 agent_id 幂等） */
export function upsertAgent(input: AgentPersistInput): void {
  const run = (parentAgentId: string | null) => getMainDb().prepare(
    `INSERT INTO agents (
       agent_id, trace_id, parent_agent_id, role, system_prompt, task_prompt,
       allowed_tools, denied_tools, token_budget, max_iterations, timeout_ms,
       trust_level, sandbox_enabled, status, failure_count, created_at, owner_user_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       trace_id = excluded.trace_id,
       parent_agent_id = COALESCE(excluded.parent_agent_id, agents.parent_agent_id),
       role = excluded.role,
       task_prompt = COALESCE(excluded.task_prompt, agents.task_prompt),
       allowed_tools = COALESCE(excluded.allowed_tools, agents.allowed_tools),
       denied_tools = COALESCE(excluded.denied_tools, agents.denied_tools),
       token_budget = COALESCE(excluded.token_budget, agents.token_budget),
       max_iterations = COALESCE(excluded.max_iterations, agents.max_iterations),
       timeout_ms = COALESCE(excluded.timeout_ms, agents.timeout_ms),
       status = excluded.status`,
  ).run(
    input.agentId,
    input.traceId,
    parentAgentId,
    input.role,
    input.systemPrompt ?? '',
    input.taskPrompt ?? null,
    input.allowedTools ? JSON.stringify(input.allowedTools) : null,
    input.deniedTools ? JSON.stringify(input.deniedTools) : null,
    input.tokenBudget ?? null,
    input.maxIterations ?? null,
    input.timeoutMs ?? null,
    input.trustLevel ?? 'L1',
    input.status ?? 'creating',
    input.createdAt ?? Date.now(),
    getActiveOwner(),
  );

  try {
    run(input.parentAgentId ?? null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // `agents.parent_agent_id` 有外键约束：父 Agent 尚未登记时会 FK 失败。
    // 运行时**不能被持久化阻断**，故降级为"无父"写入并告警（父子关系缺失是可观测的、可后补）。
    if (input.parentAgentId && message.includes('FOREIGN KEY')) {
      try {
        run(null);
        logger.warn('父 Agent 未登记，父子关系降级为无父写入', {
          source: 'agentRepository/upsertAgent',
          agentId: input.agentId,
          parentAgentId: input.parentAgentId,
        });
        return;
      } catch (e2) {
        logger.error('Agent 落库失败（降级后仍失败）', {
          source: 'agentRepository/upsertAgent',
          agentId: input.agentId,
          error: e2 instanceof Error ? e2.message : String(e2),
        });
        return;
      }
    }
    // 落库失败不应阻断 Agent 运行（内存注册表仍是权威运行时视图），但必须留痕
    logger.error('Agent 落库失败', {
      source: 'agentRepository/upsertAgent',
      agentId: input.agentId,
      error: message,
    });
  }
}

/** 部分更新（status / 失败计数 / 销毁时间等） */
export function updateAgentRow(
  agentId: string,
  updates: {
    status?: string;
    failureCount?: number;
    destroyedAt?: number | null;
    walletId?: string;
    taskPrompt?: string;
    tokenBudget?: number;
    maxIterations?: number;
  },
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.failureCount !== undefined) { sets.push('failure_count = ?'); params.push(updates.failureCount); }
  if (updates.destroyedAt !== undefined) { sets.push('destroyed_at = ?'); params.push(updates.destroyedAt); }
  if (updates.taskPrompt !== undefined) { sets.push('task_prompt = ?'); params.push(updates.taskPrompt); }
  if (updates.tokenBudget !== undefined) { sets.push('token_budget = ?'); params.push(updates.tokenBudget); }
  if (updates.maxIterations !== undefined) { sets.push('max_iterations = ?'); params.push(updates.maxIterations); }
  if (sets.length === 0) return;
  params.push(agentId, getActiveOwner());
  try {
    getMainDb().prepare(`UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ? AND owner_user_id = ?`).run(...params);
  } catch (e) {
    logger.error('Agent 更新落库失败', {
      source: 'agentRepository/updateAgentRow',
      agentId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 载入当前 owner 名下的全部 Agent（含已销毁，供审计） */
export function loadAgents(includeDestroyed = true): AgentRow[] {
  try {
    const sql = includeDestroyed
      ? 'SELECT * FROM agents WHERE owner_user_id = ? ORDER BY created_at ASC'
      : 'SELECT * FROM agents WHERE owner_user_id = ? AND destroyed_at IS NULL ORDER BY created_at ASC';
    return getMainDb().prepare(sql).all(getActiveOwner()) as AgentRow[];
  } catch (e) {
    logger.error('Agent 载入失败', {
      source: 'agentRepository/loadAgents',
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/** 统计：某 trace 下存活（未销毁）的子 Agent 数 —— 用于招募上限保护 */
export function countLiveAgentsByTrace(traceId: string): number {
  try {
    const row = getMainDb().prepare(
      'SELECT COUNT(*) AS n FROM agents WHERE owner_user_id = ? AND trace_id = ? AND destroyed_at IS NULL',
    ).get(getActiveOwner(), traceId) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 注：库行 → 运行时实例的映射（`rowToAgentInstance`）已迁至 `Core/AgentRuntime/agentRegistry.ts`——
 * Infra 层不得引用 Core 类型（分层红线），映射属于运行时侧职责。
 */

/** 读取某 Agent 的父 Agent ID（hydrate 回填父子关系用） */
export function parentOf(agentId: string): string | null {
  try {
    const row = getMainDb().prepare(
      'SELECT parent_agent_id FROM agents WHERE agent_id = ? AND owner_user_id = ?',
    ).get(agentId, getActiveOwner()) as { parent_agent_id: string | null } | undefined;
    return row?.parent_agent_id ?? null;
  } catch {
    return null;
  }
}
