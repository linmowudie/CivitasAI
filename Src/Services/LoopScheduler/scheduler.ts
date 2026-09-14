/**
 * @module LoopScheduler/scheduler
 * @description
 * Loop 调度器——Docs/14 §S8。
 * 整合去重 + 熔断，防止事件风暴。
 */

import { checkDedup } from './dedupStore.js';
import { checkBreaker } from './circuitBreaker.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 调度决策 ────────────────────────────────────────────────────────

export type ScheduleDecision =
  | { action: 'start_loop'; loopId: string }
  | { action: 'dedup_rejected'; reason: string }
  | { action: 'circuit_broken'; reason: string };

/**
 * 调度决策：
 * 1. 去重检查（60s 窗口内同 key 仅首次通过）
 * 2. 熔断检查（60s 内 100 次 → 熔断）
 * 3. 通过 → 启动 Loop
 */
export function scheduleLoop(params: {
  key: string;
  loopId: string;
  now?: number;
}): Result<ScheduleDecision> {
  const now = params.now ?? Date.now();

  // [1] 去重
  if (!checkDedup(params.key, now)) {
    return ok({ action: 'dedup_rejected', reason: `Key "${params.key}" 60s 内已触发过` });
  }

  // [2] 熔断
  const breakerResult = checkBreaker(params.key, now);
  if (!breakerResult.ok) {
    return ok({ action: 'circuit_broken', reason: breakerResult.error });
  }

  // [3] 放行
  return ok({ action: 'start_loop', loopId: params.loopId });
}
