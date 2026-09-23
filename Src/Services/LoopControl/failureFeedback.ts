/**
 * @module LoopControl/failureFeedback
 * @description
 * 可行动的失败信息协议——Docs/12 §7。
 * 禁止"再试一次"式反馈（P5 Failure Must Be Actionable）。
 * 每次失败都必须产出：具体失败证据 + 已试策略 + 剩余预算。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import type { FailureCategory, NextAction } from './types.js';
import type { VerifierResult } from './loopState.js';

// ── FailureFeedback（Docs/12 §7.2）─────────────────────────────────

export interface FailureFeedback {
  iteration: number;
  failureCategory: FailureCategory;
  evidence: Array<{
    kind: 'test_output' | 'error_stack' | 'diff_from_expected' | 'tool_error' | 'rule_violation' | 'judge_rubric';
    data: unknown;
    excerpt?: string;
  }>;
  comparedWithLastAttempt?: {
    improvement: number;
    newFailures: string[];
    resolvedFailures: string[];
  };
  triedStrategies: string[];
  remainingBudget: { tokens: number; iterations: number; seconds: number };
  recommendedNextAction?: NextAction;
}

// ── 配置 ────────────────────────────────────────────────────────────

export interface FailureFeedbackConfig {
  evidenceExcerptMaxChars: number;
  strategyTextMaxChars: number;
  sameDefectCategoryEscalateRounds: number;
  noImprovementAbortRounds: number;
  improvementMinRatio: number;
  unreasonableGoalEscalateCount: number;
}

// ── 构建 FailureFeedback ────────────────────────────────────────────

export interface BuildFeedbackInput {
  iteration: number;
  category: FailureCategory;
  verifierResult?: VerifierResult;
  errorMessage?: string;
  triedStrategies: string[];
  remainingBudget: { tokens: number; iterations: number; seconds: number };
  lastMetricValue?: number;
  currentMetricValue?: number;
  newFailures?: string[];
  resolvedFailures?: string[];
}

/**
 * 构建结构化失败反馈
 *
 * 核心原则：
 * - 必须包含 evidence（具体失败证据）
 * - 必须包含 triedStrategies（已试策略，防重复）
 * - 必须包含 remainingBudget（剩余预算）
 * - 必须推荐 nextAction（可行动的下一步）
 */
export function buildFailureFeedback(
  input: BuildFeedbackInput,
  config: FailureFeedbackConfig,
): Result<FailureFeedback> {
  // 构建证据
  const evidence: FailureFeedback['evidence'] = [];

  if (input.verifierResult) {
    for (const e of input.verifierResult.evidence) {
      const excerpt = typeof e.data === 'string'
        ? e.data.slice(0, config.evidenceExcerptMaxChars)
        : JSON.stringify(e.data).slice(0, config.evidenceExcerptMaxChars);
      evidence.push({ kind: e.kind as FailureFeedback['evidence'][0]['kind'], data: e.data, excerpt });
    }
  }

  if (input.errorMessage) {
    evidence.push({
      kind: 'error_stack',
      data: { message: input.errorMessage },
      excerpt: input.errorMessage.slice(0, config.evidenceExcerptMaxChars),
    });
  }

  if (evidence.length === 0) {
    return err('FailureFeedback 必须至少包含一条证据');
  }

  // 构建比较信息
  let comparedWithLastAttempt: FailureFeedback['comparedWithLastAttempt'] | undefined;
  if (input.lastMetricValue !== undefined && input.currentMetricValue !== undefined) {
    const improvement = input.lastMetricValue === 0
      ? (input.currentMetricValue > 0 ? 1.0 : 0.0)
      : (input.currentMetricValue - input.lastMetricValue) / Math.abs(input.lastMetricValue);
    comparedWithLastAttempt = {
      improvement,
      newFailures: input.newFailures ?? [],
      resolvedFailures: input.resolvedFailures ?? [],
    };
  }

  // 推荐下一步动作
  const recommendedNextAction = recommendNextAction(input, config);

  // 截断策略文本
  const truncatedStrategies = input.triedStrategies.map(
    s => s.slice(0, config.strategyTextMaxChars),
  );

  return ok({
    iteration: input.iteration,
    failureCategory: input.category,
    evidence,
    comparedWithLastAttempt,
    triedStrategies: truncatedStrategies,
    remainingBudget: input.remainingBudget,
    recommendedNextAction,
  });
}

// ── 推荐下一步动作 ──────────────────────────────────────────────────

function recommendNextAction(
  input: BuildFeedbackInput,
  config: FailureFeedbackConfig,
): NextAction {
  // 预算耗尽 → abort
  if (input.remainingBudget.tokens <= 0 || input.remainingBudget.iterations <= 0) {
    return 'abort';
  }

  // 同类缺陷连续出现 → escalate_human
  if (input.triedStrategies.length >= config.sameDefectCategoryEscalateRounds) {
    return 'escalate_human';
  }

  // 无改善 → switch_strategy
  if (input.comparedWithLastAttempt !== undefined) {
    const { improvement } = input.comparedWithLastAttempt;
    if (improvement < config.improvementMinRatio) {
      return 'switch_strategy';
    }
  }

  // 风险类 → rollback_and_abort
  if (input.category === 'risk') {
    return 'rollback_and_abort';
  }

  // 默认 → switch_strategy
  return 'switch_strategy';
}

// ── 序列化为 tool_result 格式（Docs/12 §7.3）───────────────────────

export function feedbackToToolResult(feedback: FailureFeedback): object {
  return {
    role: 'tool',
    tool_call_id: `verify-${feedback.iteration}`,
    status: 'error',
    recoverable: true,
    content: feedback,
  };
}
