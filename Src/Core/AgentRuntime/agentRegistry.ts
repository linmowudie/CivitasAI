/**
 * @module AgentRuntime/agentRegistry
 * @description
 * Agent 注册表——Docs/Agent/02 §6。
 * 管理所有 Agent 实例的生命周期，提供 CRUD + 查询。
 */

import type { Result } from '../../Infra/types.js';
import { logger } from '../../Infra/Logging/logger.js';
import { denyReasonForAgentRole, isGovernanceActor } from '../../Infra/Roles/roleVocabulary.js';
import { ok, err } from '../../Infra/types.js';
import * as agentRepository from '../../Infra/Db/Repositories/agentRepository.js';

import type { AgentInstance, AgentStatus, AgentRole } from './types.js';

// ── 内部状态 ────────────────────────────────────────────────────────

const agents: Map<string, AgentInstance> = new Map();

/**
 * 父 Agent 关系（多 Agent 核心）。
 *
 * `AgentInstance` 类型里没有 parent 字段（历史原因），但 `agents` 表有 `parent_agent_id`，
 * 招募/编排都需要父子关系做归属与审计，故在此旁挂一份索引，并在落库时写入。
 */
const parentAgentIds: Map<string, string> = new Map();

/** 记录父子关系（招募时由 recruiter 调用） */
export function setAgentParent(agentId: string, parentAgentId: string): void {
  parentAgentIds.set(agentId, parentAgentId);
}

/** 读取父 Agent ID */
export function getAgentParent(agentId: string): string | undefined {
  return parentAgentIds.get(agentId);
}

/**
 * 把库中的 Agent 行还原为运行时实例（供启动期 `hydrateAgents` 使用）。
 *
 * 说明：`AgentInstance` 类型未定义 parent 字段（历史原因），父子关系由注册表旁挂索引维护，
 * 因此这里只还原实例本身，父关系在 hydrate 时另行回填。
 * （2026-10-04 分层修正：该映射原位于 Infra 侧 AgentRepository，会形成 Infra→Core 上行依赖，
 * 故迁至运行时侧——映射本就是运行时职责。）
 */
function rowToAgentInstance(row: agentRepository.AgentRow): AgentInstance {
  return {
    agentId: row.agent_id,
    role: row.role as AgentInstance['role'],
    status: row.status as AgentInstance['status'],
    traceId: row.trace_id,
    model: 'restored',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.created_at),
    consecutiveFailures: Number(row.failure_count ?? 0),
    awaitingApproval: false,
  };
}

/**
 * 启动期从库中恢复 Agent（多 Agent 核心）。
 *
 * 修复前：注册表纯内存 → 重启后 `getAllAgents()` 为空，历史招募的 Agent 凭空消失，
 * 前端 Agent 面板与审计都无法回溯。现在按 owner 载入**未销毁**的 Agent。
 *
 * 崩溃恢复语义：库中状态为 `running` / `creating` 的 Agent 在进程重启后已无执行实体，
 * 统一降级为 `suspended`（挂起，等待重新调度），避免"看起来在跑其实没人跑"。
 */
export function hydrateAgents(): number {
  const rows = agentRepository.loadAgents(false);
  let restored = 0;
  for (const row of rows) {
    // ★ G-11（2026-10-04）：回灌是**只读恢复**路径，不因角色异常中断恢复；
    //   但治理角色 Agent **不应由招募/执行层产生** → 若库中出现，视为可疑并告警（供审计追溯）。
    if (isGovernanceActor(row.role)) {
      logger.warn('回灌发现治理角色 Agent（可疑：治理身份不应由招募/执行层产生）', {
        source: 'agentRegistry/hydrateAgents',
        agentId: row.agent_id,
        role: row.role,
      });
    }
    const status = (row.status === 'running' || row.status === 'creating' ? 'suspended' : row.status) as AgentStatus;
    if (!agents.has(row.agent_id)) {
      agents.set(row.agent_id, { ...rowToAgentInstance(row), status });
      restored++;
    }
    const parent = agentRepository.parentOf(row.agent_id);
    if (parent) parentAgentIds.set(row.agent_id, parent);
    if (status !== row.status) agentRepository.updateAgentRow(row.agent_id, { status });
  }
  return restored;
}

// ── 注册 ────────────────────────────────────────────────────────────

export function registerAgent(
  agent: AgentInstance,
  /** 系统播种/回灌开关（G-11）：回灌历史数据时允许，否则治理角色注册会被拒 */
  options: { allowGovernance?: boolean } = {},
): Result<void> {
  // ★ 防御纵深（G-11）：注册表是**所有** Agent 进入运行时的唯一入口，此处再校验一次角色赋权，
  //   防止有人绕过 agentFactory 直接注册伪造实例（如从 IPC/测试构造 AgentInstance）。
  const denied = denyReasonForAgentRole(String(agent.role), options.allowGovernance ?? false);
  if (denied) return err(denied);

  if (agents.has(agent.agentId)) {
    return err(`Agent ${agent.agentId} 已注册`);
  }
  agents.set(agent.agentId, { ...agent });
  // 写透到 `agents` 表：内存注册表是**运行时视图**，数据库是**持久/审计视图**。
  // 修复前只存内存 → 进程重启后招募出的 Agent 全部消失，且无法按账号隔离（多 Agent 不可持久）。
  agentRepository.upsertAgent({
    agentId: agent.agentId,
    traceId: agent.traceId ?? '',
    parentAgentId: parentAgentIds.get(agent.agentId) ?? null,
    role: String(agent.role),
    // FE-052：角色提示词随实体落库（覆盖所有创建路径：工厂→注册表→写透）
    systemPrompt: agent.systemPrompt,
    status: agent.status,
    createdAt: agent.createdAt,
  });
  return ok(undefined);
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getAgent(agentId: string): AgentInstance | undefined {
  const agent = agents.get(agentId);
  return agent ? { ...agent } : undefined;
}

export function getAllAgents(): AgentInstance[] {
  return [...agents.values()].map(a => ({ ...a }));
}

export function getAgentsByStatus(status: AgentStatus): AgentInstance[] {
  return getAllAgents().filter(a => a.status === status);
}

export function getAgentsByRole(role: AgentRole): AgentInstance[] {
  return getAllAgents().filter(a => a.role === role);
}

export function getReadyWorkers(): AgentInstance[] {
  return getAllAgents().filter(a => a.role === 'worker' && a.status === 'ready');
}

// ── 更新 ────────────────────────────────────────────────────────────

export function updateAgentStatus(
  agentId: string,
  status: AgentStatus,
): Result<AgentInstance> {
  const agent = agents.get(agentId);
  if (!agent) return err(`Agent ${agentId} 不存在`);

  agent.status = status;
  agent.updatedAt = Date.now();
  // 写透状态变更（审计与重启恢复都依赖库里的状态）
  agentRepository.updateAgentRow(agentId, { status });
  return ok({ ...agent });
}

export function updateAgent(agentId: string, updates: Partial<AgentInstance>): Result<AgentInstance> {
  const agent = agents.get(agentId);
  if (!agent) return err(`Agent ${agentId} 不存在`);

  Object.assign(agent, updates, { updatedAt: Date.now() });
  agentRepository.updateAgentRow(agentId, {
    ...(updates.status ? { status: updates.status } : {}),
    ...(updates.consecutiveFailures !== undefined ? { failureCount: updates.consecutiveFailures } : {}),
  });
  return ok({ ...agent });
}

// ── 注销 ────────────────────────────────────────────────────────────

export function unregisterAgent(agentId: string): Result<void> {
  if (!agents.has(agentId)) return err(`Agent ${agentId} 不存在`);
  agents.delete(agentId);
  // 软销毁：保留审计痕迹（设计上 Agent 销毁需可追溯，不做物理删除）
  agentRepository.updateAgentRow(agentId, { destroyedAt: Date.now() });
  return ok(undefined);
}

// ── 测试辅助 ────────────────────────────────────────────────────────

/**
 * 清空内存注册表（测试用）。
 *
 * 必要性：注册表是模块级单例，跨测试用例会**残留**上一用例的 Agent，
 * 导致依赖"当前 trace 存活子 Agent 数"的用例（如招募上限）出现串扰。
 * 与其他模块（`resetLongTermMemory` / `resetGlobalWorkspace` / `resetRecruiter`）保持一致。
 */
export function resetAgentRegistry(): void {
  agents.clear();
  parentAgentIds.clear();
}

// ── 统计 ────────────────────────────────────────────────────────────

export function getAgentCount(): number {
  return agents.size;
}

export function getStatusSummary(): Record<AgentStatus, number> {
  const summary: Record<AgentStatus, number> = {
    creating: 0, ready: 0, running: 0,
    suspended: 0, expelled: 0, destroyed: 0,
  };
  for (const agent of agents.values()) {
    summary[agent.status]++;
  }
  return summary;
}
