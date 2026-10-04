/**
 * @module Decision/Orchestrator/subtaskDispatcher
 * @description 子任务派发器（FE-050 派发链路接线，2026-10-04 新增）。
 *
 * 背景：`subtasks` 表（迁移 v4）此前无任何写入方 —— 编排器把 assignment 交给
 * Worker/Partner 后只存在于内存（progressTracker），进程重启即丢失；
 * `agent.recruit` 的 `dispatch: 'pending'` 残留边界（FE-006）与本链路同源。
 *
 * 统一 ID 空间（三条链路对齐的基础）：
 *  - `subtask_id` = `assignmentId`（编排器拆解产出的任务书 ID）
 *  - Agent 被指派时 `lastTaskId` = `assignmentId`
 *  - 评审提交 / 待审记录的 `taskId` = `assignmentId`
 *  因此 subtasks 台账、Agent 状态、评审记录三者可按同一 ID 关联。
 */

import type { TaskAssignment } from '../types.js';
import {
  upsertSubtask,
  updateSubtaskStatus,
} from '../../../Infra/Db/Repositories/subtaskRepository.js';

/**
 * 把已分配的编排任务书落库为子任务行（幂等）。
 *
 * 调用时机：编排器创建执行 Agent 并 `assignTask` 之后（DELEGATION / ASSEMBLY_LINE /
 * CONSORTIUM 三模式统一调用）。
 */
export function dispatchSubtask(assignment: TaskAssignment): void {
  upsertSubtask({
    subtaskId: assignment.assignmentId,
    taskId: assignment.taskId,
    traceId: assignment.traceId,
    description: assignment.description,
    inputContext: assignment.inputContext,
    outputSchema: assignment.outputSchema,
    assignedAgentId: assignment.assignedAgentId ?? null,
    maxIterations: assignment.maxIterations,
    timeoutMs: assignment.timeLimitMs,
    tokenBudget: assignment.tokenBudget,
    status: assignment.status,
    dependsOn: assignment.dependsOn,
    requiredTools: assignment.requiredTools,
  });
}

/**
 * 评审结论回写子任务台账（FE-050 评审链路）。
 *
 * - 通过 → `completed`；
 * - 拒绝 → `failed` + 失败原因（Agent 侧仍由 stateMachine 驱动"继续工作"，
 *   本表只记录该次提交的审核结论，供聚合与审计）。
 */
export function markSubtaskReviewed(subtaskId: string, accepted: boolean, comment?: string): void {
  updateSubtaskStatus(subtaskId, accepted ? 'completed' : 'failed', {
    failureReason: accepted ? undefined : (comment ?? '评审未通过'),
    incrementFailureCount: !accepted,
  });
}
