/**
 * @module Supervision/postSupervision
 * @description
 * Post-supervision - Docs/Agent/02 step 9.
 * Result archival, anomaly scan, token deduction, loop exit decisions.
 */

import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

export interface PostSupervisionInput {
  outputText: string;
  toolResults: Array<{ toolName: string; status: string; recoverable: boolean }>;
  tokensConsumed: number;
  totalTokensConsumed: number;
  tokenBudget: number;
  currentIteration: number;
  maxIterations: number;
  /**
   * 本轮**开始前**已连续发生的工具错误数（由 `executeLoop` 跨轮维护）。
   * 缺省 0——即"本轮就是第一次失败"。
   */
  consecutiveErrors?: number;
  /**
   * 连续错误达到该值才判定为不可恢复终止（来自 `stopRules.limits.maxConsecutiveErrors`，缺省 3）。
   *
   * 为什么需要：此前"任一 status=error 且 !recoverable"即 `shouldExit:true`，
   * 单次路径写错（PATH_DENIED）就终止整个 Loop，且模型没有机会看到错误并纠正。
   */
  maxConsecutiveErrors?: number;
}

/** 连续工具错误的缺省终止阈值（与 `Configs/loopConfig.json` 的 `stopRules.limits.maxConsecutiveErrors` 对齐） */
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;

/**
 * 累计"连续工具错误数"（单一实现，供 `executeLoop` 与 `runPostSupervision` 共用）。
 *
 * 语义：本轮无错误 → 归零；本轮有错误 → 在上轮基础上累加**本轮错误条数**
 * （一次迭代内并发多个工具全部失败时，按实际失败次数计，而不是只算一轮）。
 *
 * @param previous 本轮开始前的连续错误数
 * @param results 本轮的（部分）工具结果，仅需 status 字段
 */
export function accumulateConsecutiveErrors(
  previous: number,
  results: ReadonlyArray<{ status: string }>,
): number {
  const errorsNow = results.filter(r => r.status === 'error').length;
  return errorsNow > 0 ? Math.max(previous, 0) + errorsNow : 0;
}

export interface ExitDecision {
  shouldExit: boolean;
  exitReason?: 'success' | 'budget_exhausted' | 'max_iterations' | 'error' | 'risk';
  message?: string;
}

export interface PostSupervisionResult {
  exitDecision: ExitDecision;
  tokenDeduction: { consumed: number; remaining: number };
  anomalies: string[];
  archived: boolean;
}

export function runPostSupervision(
  input: PostSupervisionInput,
): Result<PostSupervisionResult> {
  const anomalies: string[] = [];
  const remaining = input.tokenBudget - input.totalTokensConsumed;

  // 连续错误计数：本轮结束后的累计值（跨轮由 executeLoop 回传，两者共用同一算法）
  const threshold = input.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const consecutiveErrors = accumulateConsecutiveErrors(input.consecutiveErrors ?? 0, input.toolResults);

  // Anomaly scan
  // 只有**达到连续阈值**才登记为致命异常：单次不可恢复错误先回灌给模型（工具结果已进对话历史），
  // 让模型有机会改用合法路径/参数；连续失败到阈值才终止。
  // 注意 `anomalies` 非空会经 `IterationDecisionInput.riskDetected` 直接退出循环，故此处必须严格按阈值判定。
  if (consecutiveErrors >= threshold) {
    anomalies.push('UNRECOVERABLE_TOOL_ERROR');
  }

  // Exit decision
  let exitDecision: ExitDecision;

  if (anomalies.includes('UNRECOVERABLE_TOOL_ERROR')) {
    const failed = input.toolResults.filter(r => r.status === 'error');
    const names = [...new Set(failed.map(r => r.toolName))].join(', ');
    const hasNonRecoverable = failed.some(r => !r.recoverable);
    exitDecision = {
      shouldExit: true,
      exitReason: 'error',
      message: `连续工具失败达到阈值（${consecutiveErrors}/${threshold}）：${names || '未知工具'}`
        + (hasNonRecoverable ? '（含不可恢复错误）' : ''),
    };
  } else if (input.totalTokensConsumed >= input.tokenBudget) {
    exitDecision = { shouldExit: true, exitReason: 'budget_exhausted', message: 'Token budget exhausted' };
  } else if (input.currentIteration >= input.maxIterations) {
    exitDecision = { shouldExit: true, exitReason: 'max_iterations', message: 'Max iterations reached' };
  } else if (input.outputText && !input.toolResults.length) {
    exitDecision = { shouldExit: true, exitReason: 'success', message: 'Agent output complete' };
  } else {
    exitDecision = { shouldExit: false };
  }

  return ok({
    exitDecision,
    tokenDeduction: { consumed: input.tokensConsumed, remaining },
    anomalies,
    // FE-070：此前为写死 `true` 的假标记（“结果归档”实际未发生）——现如实返回 false：
    // 真实归档由事件持久化（ai_events）、checkpoint 与会话消息落库承担，本模块不重复归档。
    archived: false,
  });
}
