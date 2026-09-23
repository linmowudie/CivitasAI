/**
 * @module AgentRuntime/agentRuntime
 * @description
 * Agent 运行时——Docs/02 §6 + Docs/14 §S9。
 * 核心规则：Worker 不可自行宣告完成，必须走 submitForReview。
 * Director 侧只有在收到 review 通过后才能标记任务成功。
 */

import { EventType } from '../../Services/EventBus/eventTypes.js';
import { createEvent, publish } from '../../Services/EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import type { AgentInstance, AgentStatus, SubmitResult, AgentEvent } from './types.js';
import { transition } from './stateMachine.js';
import { getAgent, updateAgent, updateAgentStatus } from './agentRegistry.js';

// ── 任务提交队列 ────────────────────────────────────────────────────

interface PendingReview {
  taskId: string;
  workerAgentId: string;
  submittedAt: number;
  payload: Record<string, unknown>;
  status: 'pending' | 'accepted' | 'rejected';
  reviewerComment?: string;
}

const pendingReviews: Map<string, PendingReview> = new Map(); // taskId → review

// ── Worker 提交审核 ─────────────────────────────────────────────────

/**
 * Worker 调用 submitForReview——Worker 不可自行宣告完成。
 * 提交后进入 awaiting_approval（Loop 级），Agent 态不变。
 */
export function submitForReview(params: {
  taskId: string;
  workerAgentId: string;
  payload: Record<string, unknown>;
}): Result<SubmitResult> {
  const agent = getAgent(params.workerAgentId);
  if (!agent) return err(`Agent ${params.workerAgentId} 不存在`);
  if (agent.role !== 'worker') return err(`Agent ${params.workerAgentId} 不是 Worker`);
  if (agent.status !== 'running') return err(`Agent ${params.workerAgentId} 状态 ${agent.status}，不可提交`);

  // 创建待审记录
  const review: PendingReview = {
    taskId: params.taskId,
    workerAgentId: params.workerAgentId,
    submittedAt: Date.now(),
    payload: { ...params.payload },
    status: 'pending',
  };
  pendingReviews.set(params.taskId, review);

  // 标记 Agent 正在等待审批（Loop 级）
  updateAgent(params.workerAgentId, { awaitingApproval: true });

  // 发布事件
  publish(createEvent({
    eventType: EventType.APPROVAL_REQUESTED,
    source: 'AgentRuntime/submitForReview',
    traceId: agent.traceId,
    payload: { taskId: params.taskId, workerAgentId: params.workerAgentId },
  }));

  return ok({
    taskId: params.taskId,
    agentId: params.workerAgentId,
    status: 'submitted',
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
  if (review.status !== 'pending') return err(`Task ${params.taskId} 已审核`);

  const reviewer = getAgent(params.reviewerAgentId);
  if (!reviewer) return err(`Reviewer ${params.reviewerAgentId} 不存在`);
  if (reviewer.role !== 'reviewer') return err(`Agent ${params.reviewerAgentId} 不是 Reviewer`);

  const now = Date.now();
  review.status = params.accepted ? 'accepted' : 'rejected';
  review.reviewerComment = params.comment;

  // 更新 Worker 状态
  const worker = getAgent(review.workerAgentId);
  if (worker) {
    updateAgent(review.workerAgentId, { awaitingApproval: false });

    if (params.accepted) {
      // 审核通过 → Worker 任务完成 → running → ready
      const event: AgentEvent = { type: 'TASK_COMPLETED' };
      const transResult = transition(worker.status, event);
      if (transResult.ok) {
        updateAgentStatus(review.workerAgentId, transResult.value);
      }

      publish(createEvent({
        eventType: EventType.TASK_COMPLETED,
        source: 'AgentRuntime/reviewSubmission',
        traceId: worker.traceId,
        payload: { taskId: params.taskId, workerAgentId: review.workerAgentId },
      }));
    } else {
      // 审核拒绝 → Worker 需继续工作
      worker.consecutiveFailures++;
      updateAgent(review.workerAgentId, { consecutiveFailures: worker.consecutiveFailures });
    }
  }

  // 发布审核结果事件
  publish(createEvent({
    eventType: EventType.APPROVAL_DECIDED,
    source: 'AgentRuntime/reviewSubmission',
    payload: {
      taskId: params.taskId,
      accepted: params.accepted,
      reviewerAgentId: params.reviewerAgentId,
    },
  }));

  return ok({
    taskId: params.taskId,
    agentId: review.workerAgentId,
    status: params.accepted ? 'accepted' : 'rejected',
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
  return review !== undefined && review.status === 'accepted';
}

export function getPendingReview(taskId: string): PendingReview | undefined {
  const review = pendingReviews.get(taskId);
  return review ? { ...review } : undefined;
}

export function getPendingReviewCount(): number {
  let count = 0;
  for (const r of pendingReviews.values()) {
    if (r.status === 'pending') count++;
  }
  return count;
}

// ── Agent 事件处理 ──────────────────────────────────────────────────

/**
 * 触发 Agent 状态转换（统一入口）
 */
export function handleAgentEvent(agentId: string, event: AgentEvent): Result<AgentStatus> {
  const agent = getAgent(agentId);
  if (!agent) return err(`Agent ${agentId} 不存在`);

  const result = transition(agent.status, event);
  if (!result.ok) return result;

  updateAgentStatus(agentId, result.value);

  // 发布生命周期事件
  const eventType = result.value === 'running' ? EventType.AGENT_READY
    : result.value === 'destroyed' ? EventType.AGENT_DESTROYED
    : result.value === 'expelled' ? EventType.AGENT_EXPELLED
    : null;

  if (eventType) {
    publish(createEvent({
      eventType,
      source: 'AgentRuntime/handleAgentEvent',
      traceId: agent.traceId,
      payload: { agentId, fromStatus: agent.status, toStatus: result.value },
    }));
  }

  return result;
}

// ── 任务分配 ────────────────────────────────────────────────────────

/**
 * 分配任务给 Worker：ready → running
 */
export function assignTask(agentId: string, taskId: string, traceId: string): Result<AgentInstance> {
  const agent = getAgent(agentId);
  if (!agent) return err(`Agent ${agentId} 不存在`);
  if (agent.status !== 'ready') return err(`Agent ${agentId} 状态 ${agent.status}，不可分配任务`);

  const event: AgentEvent = { type: 'TASK_ASSIGNED', taskId };
  const result = transition(agent.status, event);
  if (!result.ok) return err(result.error);

  updateAgent(agentId, {
    status: result.value,
    currentLoopId: `loop-${taskId}`,
    lastTaskId: taskId,
    traceId,
  });

  publish(createEvent({
    eventType: EventType.TASK_ASSIGNED,
    source: 'AgentRuntime/assignTask',
    traceId,
    payload: { agentId, taskId },
  }));

  const updated = getAgent(agentId);
  return ok(updated!);
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetAgentRuntime(): void {
  pendingReviews.clear();
}
