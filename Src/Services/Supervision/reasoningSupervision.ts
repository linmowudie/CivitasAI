/**
 * @module Supervision/reasoningSupervision
 * @description
 * 推理监管——Docs/02 §3 步骤�?懒监听之一�?
 * 监控模型推理质量，检测推理链异常（如重复、空推理）�?
 */

import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

/** 推理监管结果 */
export interface ReasoningSupervisionResult {
  /** 推理是否异常 */
  anomalyDetected: boolean;
  /** 异常类型 */
  anomalyType?: 'empty_reasoning' | 'repeated_reasoning' | 'reasoning_too_long';
  /** 推理 token �?*/
  reasoningTokens: number;
}

/** 执行推理监管 */
export function runReasoningSupervision(
  reasoningText: string,
  reasoningTokens: number,
  maxReasoningTokens: number = 10000,
): Result<ReasoningSupervisionResult> {
  // 空推理检�?
  if (!reasoningText.trim()) {
    return ok({ anomalyDetected: true, anomalyType: 'empty_reasoning', reasoningTokens });
  }

  // 推理过长检�?
  if (reasoningTokens > maxReasoningTokens) {
    return ok({ anomalyDetected: true, anomalyType: 'reasoning_too_long', reasoningTokens });
  }

  return ok({ anomalyDetected: false, reasoningTokens });
}
