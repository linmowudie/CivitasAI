/**
 * @module AgentRuntime/agentRuntime
 * @description
 * Agent 运行时——Docs/Agent/02 §6 + Docs/Agent/13 §S9。
 * 核心规则：Worker 不可自行宣告完成，必须走 submitForReview。
 * Director 侧只有在收到 review 通过后才能标记任务成功。
 */

import { EventType } from "../../Services/EventBus/eventTypes.js";
import { createEvent, publish } from "../../Services/EventBus/eventBus.js";
import { getActiveOwner } from "../../Services/AccountScope/activeAccount.js";
import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

import type {
  AgentInstance,
  AgentStatus,
  SubmitResult,
  AgentEvent,
} from "./types.js";
import { transition } from "./stateMachine.js";
import { getAgent, updateAgent, updateAgentStatus } from "./agentRegistry.js";

// ── 任务提交队列 ────────────────────────────────────────────────────

export interface PendingReview {
  /** 评审记录 ID（FE-050：贯穿提交/审核/工具返回值） */
  reviewId: string;
  taskId: string;
  workerAgentId: string;
  submittedAt: number;
  payload: Record<string, unknown>;
  status: "pending" | "accepted" | "rejected";
  reviewerComment?: string;
  /** 实际裁决的 Reviewer Agent（未裁决时为空） */
  reviewerAgentId?: string;
  /** 属主账号（查询端点按当前账号过滤，与审批队列同口径） */
  owner: string;
}

const pendingReviews: Map<string, PendingReview> = new Map(); // taskId → review

/**
 * 可提交评审的执行级角色（FE-050）。
 *
 * 修复前硬编码仅 `'worker'` —— CONSORTIUM 的 partner、流水线的 assembly_node
 * 执行完子任务后无评审通道，核心规则"不得自行宣告完成"对其名存实亡。
 * 治理三权与 Director 不在此列：它们的"完成"不走 Maker-Checker 评审。
 */
const SUBMITTABLE_ROLES: readonly string[] = [
  "worker",
  "partner",
  "assembly_node",
];

// ── Worker 提交审核 ─────────────────────────────────────────────────

/**
 * 执行级 Agent 调用 submitForReview——不得自行宣告完成。
 * 提交后进入 awaiting_approval（Loop 级），Agent 态不变。
 */
export function submitForReview(params: {
  taskId: string;
  workerAgentId: string;
  payload: Record<string, unknown>;
}): Result<SubmitResult> {
  const agent = getAgent(params.workerAgentId);
  if (!agent) return err(`Agent ${params.workerAgentId} 不存在`);
  if (!SUBMITTABLE_ROLES.includes(agent.role)) {
    return err(
      `Agent ${params.workerAgentId} 角色 ${agent.role} 不可提交评审（仅执行级角色 worker/partner/assembly_node）`,
    );
  }
  if (agent.status !== "running")
    return err(`Agent ${params.workerAgentId} 状态 ${agent.status}，不可提交`);

  // 创建待审记录
  const review: PendingReview = {
    reviewId: `review-${params.taskId}-${Date.now().toString(36)}`,
    taskId: params.taskId,
    workerAgentId: params.workerAgentId,
    submittedAt: Date.now(),
    payload: { ...params.payload },
    status: "pending",
    owner: getActiveOwner(),
  };
  pendingReviews.set(params.taskId, review);

  // 标记 Agent 正在等待审批（Loop 级）
  updateAgent(params.workerAgentId, { awaitingApproval: true });

  // 发布事件（载荷与工具安全门同构，REV-317：前端按 approvalId 关联，
  // 此前只带 taskId/reviewId → 事件被丢弃，评审类审批在 UI 上完全不可见）
  publish(
    createEvent({
      eventType: EventType.APPROVAL_REQUESTED,
      source: "AgentRuntime/submitForReview",
      traceId: agent.traceId,
      payload: {
        approvalId: review.reviewId,
        reviewId: review.reviewId,
        taskId: params.taskId,
        workerAgentId: params.workerAgentId,
        loopId: agent.currentLoopId,
        requestedBy: params.workerAgentId,
        requestedAt: review.submittedAt,
        kind: "task_review",
        riskLevel: "HIGH",
      },
    }),
  );

  return ok({
    taskId: params.taskId,
    agentId: params.workerAgentId,
    status: "submitted",
    reviewId: review.reviewId,
  });
}

// ── Reviewer 审核 ───────────────────────────────────────────────────

/**
 * Reviewer 审核提交——只有通过审核，Director 才能标记成功。
 */
export function reviewSubmission(params: {
  taskId: string;
  reviewerAgentId: string;
  accepted: boolean;
  comment?: string;
}): Result<SubmitResult> {
  const review = pendingReviews.get(params.taskId);
  if (!review) return err(`Task ${params.taskId} 无待审记录`);
  if (review.status !== "pending") return err(`Task ${params.taskId} 已审核`);

  const reviewer = getAgent(params.reviewerAgentId);
  if (!reviewer) return err(`Reviewer ${params.reviewerAgentId} 不存在`);
  if (reviewer.role !== "reviewer")
    return err(`Agent ${params.reviewerAgentId} 不是 Reviewer`);

  const now = Date.now();
  review.status = params.accepted ? "accepted" : "rejected";
  review.reviewerAgentId = params.reviewerAgentId;
  review.reviewerComment = params.comment;

  // 更新 Worker 状态
  const worker = getAgent(review.workerAgentId);
  if (worker) {
    updateAgent(review.workerAgentId, { awaitingApproval: false });

    if (params.accepted) {
      // 审核通过 → Worker 任务完成 → running → ready
      const event: AgentEvent = { type: "TASK_COMPLETED" };
      const transResult = transition(worker.status, event);
      if (transResult.ok) {
        updateAgentStatus(review.workerAgentId, transResult.value);
      }

      // FE-050：payload 携带 assignmentId（= 提交时的 taskId，统一 ID 空间），
      // 使进度追踪器与编排聚合能以同一键消费完成事件。
      publish(
        createEvent({
          eventType: EventType.TASK_COMPLETED,
          source: "AgentRuntime/reviewSubmission",
          traceId: worker.traceId,
          payload: {
            taskId: params.taskId,
            assignmentId: review.taskId,
            workerAgentId: review.workerAgentId,
            reviewId: review.reviewId,
          },
        }),
      );
    } else {
      // 审核拒绝 → Worker 需继续工作
      worker.consecutiveFailures++;
      updateAgent(review.workerAgentId, {
        consecutiveFailures: worker.consecutiveFailures,
      });

      // REV-339：拒绝侧必须与通过侧对称地发布子任务级事件。此前只有 APPROVAL_DECIDED，
      // 编排聚合（`handleAssignmentTerminal` 依赖 payload.assignmentId）与进度追踪器都收不到
      // 终态信号，`subtasks` 已记 failed 而 `tasks` 行长期停在 running、Agent 也不回收。
      publish(
        createEvent({
          eventType: EventType.TASK_FAILED,
          source: "AgentRuntime/reviewSubmission",
          traceId: worker.traceId,
          payload: {
            taskId: params.taskId,
            assignmentId: review.taskId,
            workerAgentId: review.workerAgentId,
            reviewId: review.reviewId,
            reason: params.comment ?? "评审未通过",
          },
        }),
      );
    }
  }

  // 发布审核结果事件（与工具安全门同构：approvalId + 落定状态 + 裁决者，REV-317）
  publish(
    createEvent({
      eventType: EventType.APPROVAL_DECIDED,
      source: "AgentRuntime/reviewSubmission",
      payload: {
        approvalId: review.reviewId,
        reviewId: review.reviewId,
        taskId: params.taskId,
        workerAgentId: review.workerAgentId,
        status: params.accepted ? "APPROVED" : "REJECTED",
        decidedBy: `reviewer:${params.reviewerAgentId}`,
        reviewerAgentId: params.reviewerAgentId,
        accepted: params.accepted,
      },
    }),
  );

  return ok({
    taskId: params.taskId,
    agentId: review.workerAgentId,
    status: params.accepted ? "accepted" : "rejected",
    reviewId: review.reviewId,
    reviewerComment: params.comment,
    reviewedAt: now,
  });
}

// ── 检查任务是否已通过审核 ──────────────────────────────────────────

/**
 * Director 侧查询：任务是否已通过 Reviewer 审核？
 * 未调用 submitForReview → 永远不会标记成功。
 */
export function isTaskApproved(taskId: string): boolean {
  const review = pendingReviews.get(taskId);
  return review !== undefined && review.status === "accepted";
}

export function getPendingReview(taskId: string): PendingReview | undefined {
  const review = pendingReviews.get(taskId);
  return review ? { ...review } : undefined;
}

export function getPendingReviewCount(): number {
  let count = 0;
  for (const r of pendingReviews.values()) {
    if (r.status === "pending") count++;
  }
  return count;
}

/**
 * 评审记录（含已决）——按提交时间倒序（REV-317）。
 *
 * 此前 `pendingReviews` 只有 `getPendingReview(taskId)` 这一条按键读取路径，
 * 既无列表也无 HTTP 端点 → 评审类审批在 UI 上完全不可见、也不可回溯。
 */
export function listReviews(limit = 50): PendingReview[] {
  return [...pendingReviews.values()]
    .sort((a, b) => b.submittedAt - a.submittedAt)
    .slice(0, limit)
    .map((r) => ({ ...r, payload: { ...r.payload } }));
}

// ── Agent 事件处理 ──────────────────────────────────────────────────

/**
 * 触发 Agent 状态转换（统一入口）
 */
export function handleAgentEvent(
  agentId: string,
  event: AgentEvent,
): Result<AgentStatus> {
  const agent = getAgent(agentId);
  if (!agent) return err(`Agent ${agentId} 不存在`);

  const result = transition(agent.status, event);
  if (!result.ok) return result;

  updateAgentStatus(agentId, result.value);

  // 发布生命周期事件
  const eventType =
    result.value === "running"
      ? EventType.AGENT_READY
      : result.value === "destroyed"
        ? EventType.AGENT_DESTROYED
        : result.value === "expelled"
          ? EventType.AGENT_EXPELLED
          : null;

  if (eventType) {
    publish(
      createEvent({
        eventType,
        source: "AgentRuntime/handleAgentEvent",
        traceId: agent.traceId,
        payload: { agentId, fromStatus: agent.status, toStatus: result.value },
      }),
    );
  }

  return result;
}

// ── 任务分配 ────────────────────────────────────────────────────────

/**
 * 分配任务给 Worker：ready → running
 */
export function assignTask(
  agentId: string,
  taskId: string,
  traceId: string,
): Result<AgentInstance> {
  const agent = getAgent(agentId);
  if (!agent) return err(`Agent ${agentId} 不存在`);
  if (agent.status !== "ready")
    return err(`Agent ${agentId} 状态 ${agent.status}，不可分配任务`);

  const event: AgentEvent = { type: "TASK_ASSIGNED", taskId };
  const result = transition(agent.status, event);
  if (!result.ok) return err(result.error);

  updateAgent(agentId, {
    status: result.value,
    currentLoopId: `loop-${taskId}`,
    lastTaskId: taskId,
    traceId,
  });

  publish(
    createEvent({
      eventType: EventType.TASK_ASSIGNED,
      source: "AgentRuntime/assignTask",
      traceId,
      payload: { agentId, taskId },
    }),
  );

  const updated = getAgent(agentId);
  return ok(updated!);
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetAgentRuntime(): void {
  pendingReviews.clear();
}
