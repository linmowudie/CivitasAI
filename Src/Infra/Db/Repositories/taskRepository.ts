/**
 * @module Repositories/taskRepository
 * @description 任务落库（`tasks` 表，FE-050 编排链路接线，2026-10-04 新增）。
 *
 * 背景：`tasks` 表自迁移 v3 就存在（且被 `subtasks.task_id` 外键引用），但全仓无写入方 ——
 * 编排器 `receiveTask` 完成"规划"后不留任何持久痕迹，`subtasks` 派发也因外键缺行无法落库。
 *
 * 职责：
 *  - 幂等写入/更新任务行（路由模式、复杂度评估结果、终态结果）；
 *  - 自动补齐 `sessions` 运行基座行（`tasks.session_key` 外键依赖）——每次编排运行
 *    对应一条 `run-<traceId>` 会话行；
 *  - 所有读写按 `owner_user_id` 收敛（与项目其余个人数据一致）；
 *  - 落库失败**不阻断编排**，仅留痕（与 agentRepository 同策略）。
 */

import { getMainDb } from '../database.js';
import { getActiveOwner } from '../../AccountScope/activeAccount.js';
import { logger } from '../../Logging/logger.js';

/** 任务行（`tasks` 表） */
export interface TaskRow {
  task_id: string;
  session_key: string;
  trace_id: string;
  user_request: string;
  route_mode: string;
  status: string;
  estimated_tokens: number | null;
  required_domains: string | null;
  coupling_score: number | null;
  final_result: string | null;
  quality_score: number | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  owner_user_id: string;
}

/** 落库所需的最小字段（未提供的用库默认值） */
export interface TaskPersistInput {
  taskId: string;
  traceId: string;
  userRequest: string;
  routeMode: string;
  /** 运行基座会话键；缺省 `run-<traceId>`（一次编排运行 = 一条会话行） */
  sessionKey?: string;
  estimatedTokens?: number;
  requiredDomains?: string[];
  couplingScore?: number;
  status?: string;
  finalResult?: string;
  qualityScore?: number;
  createdAt?: number;
}

/**
 * 新增或更新一个任务（按 task_id 幂等）。
 *
 * 首次写入时自动补齐运行基座会话行（sessions 表），保证
 * `tasks.session_key` 外键链完整；更新分支不覆盖已产生的执行痕迹。
 */
export function upsertTask(input: TaskPersistInput): void {
  try {
    const db = getMainDb();
    const sessionKey = input.sessionKey ?? `run-${input.traceId}`;
    const now = input.createdAt ?? Date.now();
    const status = input.status ?? 'pending';
    const startedAt = status === 'running' || status === 'in_progress' ? now : null;

    // 运行基座会话行（FK: tasks.session_key → sessions.session_key）
    db.prepare(
      `INSERT OR IGNORE INTO sessions (session_key, trace_id, description, status, created_at, last_active_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).run(sessionKey, input.traceId, `orchestrator run ${input.traceId}`, now, now);

    db.prepare(
      `INSERT INTO tasks (
         task_id, session_key, trace_id, user_request, route_mode, status,
         estimated_tokens, required_domains, coupling_score,
         final_result, quality_score, created_at, started_at, owner_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         route_mode = excluded.route_mode,
         status = excluded.status,
         estimated_tokens = COALESCE(excluded.estimated_tokens, tasks.estimated_tokens),
         required_domains = COALESCE(excluded.required_domains, tasks.required_domains),
         coupling_score = COALESCE(excluded.coupling_score, tasks.coupling_score)`,
    ).run(
      input.taskId,
      sessionKey,
      input.traceId,
      input.userRequest,
      input.routeMode,
      status,
      input.estimatedTokens ?? null,
      input.requiredDomains ? JSON.stringify(input.requiredDomains) : null,
      input.couplingScore ?? null,
      input.finalResult ?? null,
      input.qualityScore ?? null,
      now,
      startedAt,
      getActiveOwner(),
    );
  } catch (e) {
    // 落库失败不应阻断编排运行（内存态仍是权威运行时视图），但必须留痕
    logger.error('任务落库失败（不阻断编排）', {
      source: 'taskRepository/upsertTask',
      taskId: input.taskId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 部分更新任务行（终态回写：status / final_result / completed_at 等） */
export function updateTaskRow(
  taskId: string,
  updates: {
    status?: string;
    finalResult?: string;
    qualityScore?: number;
    completedAt?: number;
  },
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.finalResult !== undefined) { sets.push('final_result = ?'); params.push(updates.finalResult); }
  if (updates.qualityScore !== undefined) { sets.push('quality_score = ?'); params.push(updates.qualityScore); }
  if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(updates.completedAt); }
  if (sets.length === 0) return;
  params.push(taskId, getActiveOwner());
  try {
    getMainDb().prepare(
      `UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ? AND owner_user_id = ?`,
    ).run(...params);
  } catch (e) {
    logger.error('任务更新落库失败', {
      source: 'taskRepository/updateTaskRow',
      taskId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 读取任务行（按当前属主过滤） */
export function getTaskRow(taskId: string): TaskRow | undefined {
  try {
    return getMainDb().prepare(
      'SELECT * FROM tasks WHERE task_id = ? AND owner_user_id = ?',
    ).get(taskId, getActiveOwner()) as TaskRow | undefined;
  } catch {
    return undefined;
  }
}
