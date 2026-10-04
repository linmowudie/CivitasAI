/**
 * @module LoopScheduler/index
 * @description
 * Loop 调度器统一导出——Docs/Agent/13 §S8。
 *
 * **接线状态（FE-063 决策，2026-10-04）**：
 *  - `scheduleLoop`（去重 + 熔断启动决策）**未接线**：当前 Loop 由用户消息驱动
 *    （ipcBridge → executeLoop）；本调度器面向**事件驱动的 Loop 启动**场景（预留）——
 *    其 60s 同 key 去重语义与连续对话体验冲突，故不接入 chat 链路；
 *  - `dedupStore`/`circuitBreaker`：`init*` 已在 `main.ts` 装配，但核心检查函数
 *    当前无生产调用者（随 scheduleLoop 一并待事件驱动场景接入）；
 *  - 如后续接事件驱动启动：在启动入口调用 `scheduleLoop`（或 `checkDedup`+`checkBreaker`），
 *    被拒时降级为告警/入队而非直接丢弃。
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
