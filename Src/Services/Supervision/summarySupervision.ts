/**
 * @module Supervision/summarySupervision
 * @description
 * 摘要监管——Docs/02 §3 步骤�?懒监听之一�?
 * 监控上下文摘要质量，确保摘要保留关键信息�?
 */

import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

/** 摘要监管结果 */
export interface SummarySupervisionResult {
  /** 摘要是否合格 */
  summaryQualityOk: boolean;
  /** 摘要压缩�?*/
  summaryRatio: number;
  /** 是否触发了摘�?*/
  summaryTriggered: boolean;
}

/** 执行摘要监管 */
export function runSummarySupervision(
  originalTokens: number,
  summaryTokens: number,
  triggered: boolean,
): Result<SummarySupervisionResult> {
  const summaryRatio = originalTokens > 0 ? summaryTokens / originalTokens : 1;
  // 摘要不应超过原文 60%
  const summaryQualityOk = summaryRatio <= 0.6;

  return ok({ summaryQualityOk, summaryRatio, summaryTriggered: triggered });
}
