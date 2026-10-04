/**
 * @module Repositories/subtaskRepository
 * @description 子任务落库（`subtasks` 表，FE-050 派发链路接线，2026-10-04 新增）。
 *
 * 背景：`subtasks` 表（迁移 v4）此前无任何写入方 —— 编排器把任务书交给 Worker 后
 * 只存在于内存（progressTracker），进程重启即丢失；`agent.recruit` 的
 * `dispatch: 'pending'` 残留边界与此同源（FE-006）。
 *
 * 职责：
 *  - 幂等写入子任务行（subtask_id = assignmentId，全链路统一 ID 空间：
 *    Agent 的 lastTaskId / 评审 taskId / 本表主键同值）；
 *  - 状态回写（in_progress / completed / failed，含评审结论与失败原因）；
 *  - 所有读写按 `owner_user_id` 收敛；
 *  - 落库失败**不阻断编排**，仅留痕（与 agentRepository 同策略）。
 */

import { getMainDb } from '../database.js';
import { getActiveOwner } from '../../AccountScope/activeAccount.js';
import { logger } from '../../Logging/logger.js';

/** 子任务行（`subtasks` 表） */
export interface SubtaskRow {
  subtask_id: string;
  task_id: string;
  trace_id: string;
  description: string;
  input_context: string | null;
  output_schema: string | null;
  assigned_agent_id: string | null;
  max_iterations: number;
  timeout_ms: number | null;
  token_budget: number | null;
  status: string;
  result: string | null;
  quality_score: number | null;
  failure_count: number;
  failure_reason: string | null;
  depends_on: string | null;
  required_tools: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  owner_user_id: string;
}

/** 派发落库所需字段（来自编排器的 TaskAssignment） */
export interface SubtaskPersistInput {
  subtaskId: string;
  taskId: string;
  traceId: string;
  description: string;
  inputContext?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  assignedAgentId?: string | null;
  maxIterations?: number;
  timeoutMs?: number | null;
  tokenBudget?: number | null;
  status?: string;
  dependsOn?: string[];
  requiredTools?: string[];
  createdAt?: number;
}

/** 新增或更新一个子任务（按 subtask_id 幂等） */
export function upsertSubtask(input: SubtaskPersistInput): void {
  try {
    getMainDb().prepare(
      `INSERT INTO subtasks (
         subtask_id, task_id, trace_id, description, input_context, output_schema,
         assigned_agent_id, max_iterations, timeout_ms, token_budget, status,
         depends_on, required_tools, created_at, owner_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subtask_id) DO UPDATE SET
         assigned_agent_id = COALESCE(excluded.assigned_agent_id, subtasks.assigned_agent_id),
         status = excluded.status,
         input_context = COALESCE(excluded.input_context, subtasks.input_context),
         output_schema = COALESCE(excluded.output_schema, subtasks.output_schema),
         depends_on = COALESCE(excluded.depends_on, subtasks.depends_on),
         required_tools = COALESCE(excluded.required_tools, subtasks.required_tools)`,
    ).run(
      input.subtaskId,
      input.taskId,
      input.traceId,
      input.description,
      input.inputContext ? JSON.stringify(input.inputContext) : null,
      input.outputSchema ? JSON.stringify(input.outputSchema) : null,
      input.assignedAgentId ?? null,
      input.maxIterations ?? 30,
      input.timeoutMs ?? null,
      input.tokenBudget ?? null,
      input.status ?? 'pending',
      input.dependsOn ? JSON.stringify(input.dependsOn) : null,
      input.requiredTools ? JSON.stringify(input.requiredTools) : null,
      input.createdAt ?? Date.now(),
      getActiveOwner(),
    );
  } catch (e) {
    logger.error('子任务落库失败（不阻断编排）', {
      source: 'subtaskRepository/upsertSubtask',
      subtaskId: input.subtaskId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 子任务状态回写（含可选的结果/失败原因/失败计数） */
export function updateSubtaskStatus(
  subtaskId: string,
  status: string,
  extra?: {
    result?: string;
    qualityScore?: number;
    failureReason?: string;
    incrementFailureCount?: boolean;
  },
): void {
  const sets: string[] = ['status = ?'];
  const params: unknown[] = [status];
  const now = Date.now();
  if (status === 'in_progress') {
    sets.push('started_at = COALESCE(started_at, ?)');
    params.push(now);
  }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    sets.push('completed_at = ?');
    params.push(now);
  }
  if (extra?.result !== undefined) { sets.push('result = ?'); params.push(extra.result); }
  if (extra?.qualityScore !== undefined) { sets.push('quality_score = ?'); params.push(extra.qualityScore); }
  if (extra?.failureReason !== undefined) { sets.push('failure_reason = ?'); params.push(extra.failureReason); }
  if (extra?.incrementFailureCount) { sets.push('failure_count = failure_count + 1'); }
  params.push(subtaskId, getActiveOwner());
  try {
    getMainDb().prepare(
      `UPDATE subtasks SET ${sets.join(', ')} WHERE subtask_id = ? AND owner_user_id = ?`,
    ).run(...params);
  } catch (e) {
    logger.error('子任务状态回写失败', {
      source: 'subtaskRepository/updateSubtaskStatus',
      subtaskId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 读取单个子任务（按当前属主过滤） */
export function getSubtask(subtaskId: string): SubtaskRow | undefined {
  try {
    return getMainDb().prepare(
      'SELECT * FROM subtasks WHERE subtask_id = ? AND owner_user_id = ?',
    ).get(subtaskId, getActiveOwner()) as SubtaskRow | undefined;
  } catch {
    return undefined;
  }
}

/** 列出某任务的全部子任务（按创建顺序） */
export function listSubtasksByTask(taskId: string): SubtaskRow[] {
  try {
    return getMainDb().prepare(
      'SELECT * FROM subtasks WHERE task_id = ? AND owner_user_id = ? ORDER BY created_at ASC',
    ).all(taskId, getActiveOwner()) as SubtaskRow[];
  } catch {
    return [];
  }
}
