/**
 * @module LoopScheduler/index
 * @description
 * Loop 调度器统一导出——Docs/14 §S8。
 */

// ── Scheduler ───────────────────────────────────────────────────────
export { scheduleLoop } from './scheduler.js';
export type { ScheduleDecision } from './scheduler.js';

// ── DedupStore ──────────────────────────────────────────────────────
export {
  initDedupStore, checkDedup, getDedupCount,
  purgeExpired, resetDedupStore,
} from './dedupStore.js';

// ── CircuitBreaker ──────────────────────────────────────────────────
export {
  initCircuitBreaker, checkBreaker, isTripped,
  getBreakerStatus, resetCircuitBreaker,
} from './circuitBreaker.js';
export type { CircuitBreakerConfig } from './circuitBreaker.js';
