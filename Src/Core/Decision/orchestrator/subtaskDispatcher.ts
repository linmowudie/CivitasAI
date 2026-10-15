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

import type { TaskAssignment } from "../types.js";
import {
  upsertSubtask,
  updateSubtaskStatus,
  getSubtask,
} from "../../../Infra/Db/Repositories/subtaskRepository.js";

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
export function markSubtaskReviewed(
  subtaskId: string,
  accepted: boolean,
  comment?: string,
): void {
  updateSubtaskStatus(subtaskId, accepted ? "completed" : "failed", {
    failureReason: accepted ? undefined : (comment ?? "评审未通过"),
    incrementFailureCount: !accepted,
  });
}

/**
 * 失败侧台账回写（REV-344）。
 *
 * 此前 `subtasks` 只有评审路径会写状态：子任务因"循环结束未提交评审 / Loop 失败 / 预算耗尽"
 * 进终态时，`tasks` 行已 `failed` 而 `subtasks` 行仍停在 `assigned`、`completed_at` 为 `null`
 * （2026-10-09 真实进程取证 `.tmp/p18-driver-evidence.out` 21 段实测）。
 * 台账与任务行的终态口径必须一致，否则子任务列表永远显示"已派发"。
 */
export function markSubtaskFailed(subtaskId: string, reason: string): void {
  // 幂等护栏：评审拒绝路径已把该行写成 failed，同一子任务随后再收到 task:failed 时
  // 不得重复累加 failure_count（同一事件的两次发布是真实存在的——评审拒绝 + 循环收尾）。
  const current = getSubtask(subtaskId);
  if (current && ["completed", "failed", "cancelled"].includes(current.status))
    return;
  updateSubtaskStatus(subtaskId, "failed", {
    failureReason: reason,
    incrementFailureCount: true,
  });
}

/**
 * 执行开始时回写台账（REV-347）。
 *
 * `updateSubtaskStatus` 一直支持用 `in_progress` 写 `started_at`，但全库**没有任何调用点写过这个状态**
 * （只有 `assigned` → `completed`/`failed`），于是 `subtasks.started_at` 恒为 `null`：
 * 2026-10-09 真实取证里两行子任务都已进/近终态而 `started_at` 全空，实际耗时无法审计，
 * 也就无从判断执行是否超出 `timeout_ms`。
 * 只在台账里真实存在且仍处派发态时升级——已终态的行不能被"复活"。
 */
export function markSubtaskStarted(subtaskId: string): void {
  const current = getSubtask(subtaskId);
  if (!current || !["pending", "assigned"].includes(current.status)) return;
  updateSubtaskStatus(subtaskId, "in_progress");
}
