/**
 * @module Supervision/loopSupervision
 * @description
 * 循环监管——Docs/02 §3 步骤�?懒监听之一�?
 * 检测循环异常：无进展、死循环、互相等待死锁（T6）�?
 */

import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

/** 循环监管结果 */
export interface LoopSupervisionResult {
  /** 是否检测到异常 */
  anomalyDetected: boolean;
  /** 异常类型 */
  anomalyType?: 'no_progress' | 'infinite_loop' | 'deadlock';
  /** 当前迭代�?*/
  currentIteration: number;
  /** 建议 */
  recommendation?: string;
}

/** 迭代记录 */
export interface IterationRecord {
  iteration: number;
  /** 是否有工具调�?*/
  hadToolCall: boolean;
  /** 输出指纹（用于检测重复） */
  outputFingerprint: string;
  timestamp: number;
}

/** 执行循环监管 */
export function runLoopSupervision(
  records: IterationRecord[],
  maxIterations: number,
): Result<LoopSupervisionResult> {
  if (records.length < 2) {
    return ok({ anomalyDetected: false, currentIteration: records.length });
  }

  const current = records[records.length - 1];

  // �?无进展检测：连续 3 轮无工具调用
  const lastThree = records.slice(-3);
  const noProgress = lastThree.every(r => !r.hadToolCall) && lastThree.length >= 3;
  if (noProgress) {
    return ok({
      anomalyDetected: true, anomalyType: 'no_progress',
      currentIteration: current.iteration,
      recommendation: '连续 3 轮无工具调用，建议终止或重新规划',
    });
  }

  // �?重复输出检测（指纹相同�?
  const lastFive = records.slice(-5);
  if (lastFive.length >= 3) {
    const fingerprints = lastFive.map(r => r.outputFingerprint);
    const unique = new Set(fingerprints);
    if (unique.size === 1) {
      return ok({
        anomalyDetected: true, anomalyType: 'infinite_loop',
        currentIteration: current.iteration,
        recommendation: '输出指纹重复，可能陷入死循环',
      });
    }
  }

  return ok({ anomalyDetected: false, currentIteration: current.iteration });
}

/** 检�?T6 死锁：A �?B，B �?A */
export function detectDeadlock(
  waitingPairs: Array<{ waiter: string; waitingFor: string }>,
): boolean {
  for (const pair of waitingPairs) {
    const reverse = waitingPairs.find(
      p => p.waiter === pair.waitingFor && p.waitingFor === pair.waiter,
    );
    if (reverse) return true;
  }
  return false;
}
