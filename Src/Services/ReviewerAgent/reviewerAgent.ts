/**
 * @module ReviewerAgent/reviewerAgent
 * @description
 * 审核 Agent——Docs/14 §S9。
 * Maker-Checker 模式的 Checker 实例。
 * 审核 Worker 提交的成果，决定接受或拒绝。
 */

import { reviewSubmission } from '../../Core/AgentRuntime/agentRuntime.js';
import { getAgent } from '../../Core/AgentRuntime/agentRegistry.js';
import { getPendingReview } from '../../Core/AgentRuntime/agentRuntime.js';
import type { SubmitResult } from '../../Core/AgentRuntime/types.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 审核策略 ────────────────────────────────────────────────────────

export type ReviewPolicy = 'strict' | 'moderate' | 'lenient';

export interface ReviewConfig {
  policy: ReviewPolicy;
  maxReviewTimeMs?: number;
  autoRejectOnTimeout?: boolean;
}

let currentConfig: ReviewConfig = {
  policy: 'moderate',
  maxReviewTimeMs: 30000,
  autoRejectOnTimeout: true,
};

export function configureReviewer(config: Partial<ReviewConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

// ── 审核执行 ────────────────────────────────────────────────────────

/**
 * Reviewer Agent 执行审核。
 * Phase 0-2：基于规则的简单审核（后续接 LLM Judge）。
 */
export function performReview(params: {
  taskId: string;
  reviewerAgentId: string;
  criteria?: string[];
}): Result<SubmitResult> {
  const review = getPendingReview(params.taskId);
  if (!review) return err(`Task ${params.taskId} 无待审记录`);

  // Phase 0-2：简单规则审核
  // 检查 Worker 是否存在
  const worker = getAgent(review.workerAgentId);
  if (!worker) return err(`Worker ${review.workerAgentId} 不存在`);

  // Phase 0-2：默认接受（后续接 LLM Judge 做实际质量评估）
  const accepted = true;
  const comment = `Phase 0-2 规则审核: policy=${currentConfig.policy}`;

  return reviewSubmission({
    taskId: params.taskId,
    reviewerAgentId: params.reviewerAgentId,
    accepted,
    comment,
  });
}

// ── 清理 ────────────────────────────────────────────────────────────

export function resetReviewer(): void {
  currentConfig = {
    policy: 'moderate',
    maxReviewTimeMs: 30000,
    autoRejectOnTimeout: true,
  };
}
