/**
 * @module EventBus/index
 * @description
 * 事件总线统一导出——Docs/07 §4 / Docs/08。
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

// ── EventRouter ─────────────────────────────────────────────────────
export {
  registerRoute, startRouter, forwardEvent, resetRouter,
} from './eventRouter.js';
