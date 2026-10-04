/**
 * @module EventBus/index
 * @description
 * 事件总线统一导出——Docs/Agent/07 §4 / Docs/Agent/08。
 */

// ── 类型 ────────────────────────────────────────────────────────────
export { EventType } from './eventTypes.js';
export type {
  EventPriority, DomainEvent, EventHandler, Subscription,
  MessageType, MessagePriority, AgentMessage, AssertionLevel,
} from './eventTypes.js';

// ── EventBus ────────────────────────────────────────────────────────
export {
  initEventBus, publish, subscribe, subscribeMany, waitFor,
  getEventLog, getSubscriberCount, getEventCount,
  createEvent, resetEventBus,
} from './eventBus.js';
export type { EventBusConfig } from './eventBus.js';

// 注（FE-063 决策，2026-10-04）：`eventRouter.ts` 已删除——其“critical 同步路由”
// 能力与 eventBus 的订阅分发**重复**且全仓 0 注册方；如同需同步语义，可在 eventBus
// 层扩展 priority 分发（保留本注作为决策痕迹）。
