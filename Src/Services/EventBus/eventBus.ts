/**
 * @module EventBus/eventBus
 * @description
 * 内存事件总线——Docs/07 §4.2。
 * 发布-订阅模式，异步通信，事件溯源。
 * 消费者幂等（同一 eventId 重复发布只处理一次）。
 */

import type { DomainEvent, EventType, EventHandler, Subscription, EventPriority } from './eventTypes.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 内部状态 ────────────────────────────────────────────────────────

interface SubscriberEntry {
  eventTypes: EventType[];
  handler: EventHandler;
  id: string;
}

const subscribers: SubscriberEntry[] = [];
const processedEventIds: Set<string> = new Set();
const eventLog: DomainEvent[] = [];
let maxQueueSize = 10000;
let nextSubId = 1;

// ── 配置 ────────────────────────────────────────────────────────────

export interface EventBusConfig {
  maxQueueSize?: number;
}

export function initEventBus(config: EventBusConfig = {}): void {
  maxQueueSize = config.maxQueueSize ?? 10000;
}

// ── 发布 ────────────────────────────────────────────────────────────

/**
 * 发布事件——异步分发，不阻塞发布者。
 * 消费者幂等：同一 eventId 仅处理一次。
 */
export function publish(event: DomainEvent): Result<void> {
  // 幂等检查
  if (processedEventIds.has(event.eventId)) {
    return ok(undefined); // 已处理，静默跳过
  }
  processedEventIds.add(event.eventId);

  // 记录事件日志
  eventLog.push({ ...event });
  if (eventLog.length > maxQueueSize) {
    eventLog.shift();
  }

  // 异步分发给匹配的订阅者
  for (const sub of subscribers) {
    if (sub.eventTypes.includes(event.eventType)) {
      // 异步执行，不阻塞发布者
      Promise.resolve(sub.handler(event)).catch(() => {
        // 消费者异常不传播到发布者
      });
    }
  }

  return ok(undefined);
}

// ── 订阅 ────────────────────────────────────────────────────────────

export function subscribe(eventType: EventType, handler: EventHandler): Subscription {
  return subscribeMany([eventType], handler);
}

export function subscribeMany(eventTypes: EventType[], handler: EventHandler): Subscription {
  const id = `sub-${nextSubId++}`;
  const entry: SubscriberEntry = { eventTypes: [...eventTypes], handler, id };
  subscribers.push(entry);

  return {
    unsubscribe() {
      const idx = subscribers.findIndex(s => s.id === id);
      if (idx >= 0) subscribers.splice(idx, 1);
    },
  };
}

// ── 等待（Promise 化）──────────────────────────────────────────────

export function waitFor(
  eventType: EventType,
  filter?: (event: DomainEvent) => boolean,
  timeoutMs?: number,
): Promise<Result<DomainEvent>> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sub = subscribe(eventType, (event) => {
      if (filter && !filter(event)) return;
      if (timer) clearTimeout(timer);
      sub.unsubscribe();
      resolve(ok(event));
    });

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        sub.unsubscribe();
        resolve(err(`waitFor(${eventType}) 超时 ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getEventLog(filter?: { eventType?: EventType; traceId?: string; limit?: number }): DomainEvent[] {
  let events = [...eventLog];
  if (filter?.eventType) {
    events = events.filter(e => e.eventType === filter.eventType);
  }
  if (filter?.traceId) {
    events = events.filter(e => e.traceId === filter.traceId);
  }
  if (filter?.limit && filter.limit > 0) {
    events = events.slice(-filter.limit);
  }
  return events;
}

export function getSubscriberCount(): number {
  return subscribers.length;
}

export function getEventCount(): number {
  return eventLog.length;
}

// ── 辅助：创建事件 ──────────────────────────────────────────────────

let eventCounter = 0;

export function createEvent(params: {
  eventType: EventType;
  source: string;
  payload?: Record<string, unknown>;
  traceId?: string;
  loopId?: string;
  priority?: EventPriority;
}): DomainEvent {
  return {
    eventId: `evt-${Date.now()}-${++eventCounter}`,
    eventType: params.eventType,
    traceId: params.traceId,
    loopId: params.loopId,
    timestamp: Date.now(),
    priority: params.priority ?? 'normal',
    payload: params.payload ?? {},
    source: params.source,
  };
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetEventBus(): void {
  subscribers.length = 0;
  processedEventIds.clear();
  eventLog.length = 0;
  eventCounter = 0;
}
