/**
 * @module EventBus/eventBus
 * @description
 * 内存事件总线——Docs/Agent/07 §4.2。
 * 发布-订阅模式，异步通信，事件溯源。
 * 消费者幂等（同一 eventId 重复发布只处理一次）。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import { logger } from "../../Infra/Logging/logger.js";
import { getEventsDb } from "../../Infra/Db/database.js";

import type {
  DomainEvent,
  EventType,
  EventHandler,
  Subscription,
  EventPriority,
} from "./eventTypes.js";

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

  // MM-GAP-EVENTSTABLE（设计 §3.9）：事件落库到 `domain_events`，
  // 使事件**跨进程可回放**（此前只有进程内 eventLog，重启即丢）。
  // 落库失败 fail-soft：事件分发不因持久化降级而中断，但必须留痕。
  persistDomainEvent(event);

  // 异步分发给匹配的订阅者
  for (const sub of subscribers) {
    if (sub.eventTypes.includes(event.eventType)) {
      // 异步执行，不阻塞发布者
      // 消费者异常**不传播**给发布者（fail-soft），但**必须留痕**：
      // 静默吞掉会让订阅方（Hook / AI 组件 / 审计）的缺陷完全不可见。
      Promise.resolve(sub.handler(event)).catch((e: unknown) => {
        logger.warn("事件订阅者处理失败（已隔离，不影响发布者）", {
          source: "eventBus",
          eventType: event.eventType,
          subscriberId: sub.id,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }
  }

  return ok(undefined);
}

// ── 订阅 ────────────────────────────────────────────────────────────

export function subscribe(
  eventType: EventType,
  handler: EventHandler,
): Subscription {
  return subscribeMany([eventType], handler);
}

export function subscribeMany(
  eventTypes: EventType[],
  handler: EventHandler,
): Subscription {
  const id = `sub-${nextSubId++}`;
  const entry: SubscriberEntry = { eventTypes: [...eventTypes], handler, id };
  subscribers.push(entry);

  return {
    unsubscribe() {
      const idx = subscribers.findIndex((s) => s.id === id);
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

export function getEventLog(filter?: {
  eventType?: EventType;
  traceId?: string;
  limit?: number;
}): DomainEvent[] {
  let events = [...eventLog];
  if (filter?.eventType) {
    events = events.filter((e) => e.eventType === filter.eventType);
  }
  if (filter?.traceId) {
    events = events.filter((e) => e.traceId === filter.traceId);
  }
  if (filter?.limit && filter.limit > 0) {
    events = events.slice(-filter.limit);
  }
  return events;
}

export function getSubscriberCount(): number {
  return subscribers.length;
}

/**
 * 按事件类型取订阅者（MEMN-GAP-EVENTSUB：用于断言"某事件确实有消费者"）。
 * 返回处理器副本，调用方不得依赖其身份。
 */
export function getSubscribers(eventType: EventType): EventHandler[] {
  return subscribers
    .filter((entry) => entry.eventTypes.includes(eventType))
    .map((entry) => entry.handler);
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
    priority: params.priority ?? "normal",
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

// ── 事件持久化与跨进程回放（MM-GAP-EVENTSTABLE，设计 §3.9）─────────────
//
// 背景（矩阵 cell 复现）：`domain_events` 表由迁移创建，但**全仓零 INSERT** ——
// 事件只能活在该进程的 `eventLog` 里，重启/换进程即丢，"跨进程回放"不存在。
// 现在 `publish()` 写穿落库（fail-soft），并提供回放读取入口。

let persistedWriteWarned = false;

function safeParsePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 写穿一条事件到 `domain_events`（失败只告警一次，不影响分发） */
function persistDomainEvent(event: DomainEvent): void {
  try {
    getEventsDb()
      .prepare(
        `INSERT OR REPLACE INTO domain_events
           (event_id, event_type, trace_id, loop_id, source, payload, priority, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.eventType,
        event.traceId ?? null,
        event.loopId ?? null,
        event.source,
        JSON.stringify(event.payload ?? {}),
        event.priority ?? "normal",
        event.timestamp ?? Date.now(),
      );
  } catch (e) {
    if (!persistedWriteWarned) {
      persistedWriteWarned = true;
      logger.warn("事件落库失败（跨进程回放降级；仅告警一次）", {
        source: "eventBus/persistDomainEvent",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/**
 * 从 `domain_events` 回放事件（跨进程/重启后的唯一事件事实源）。
 * 库不可用/无记录时返回空数组（调用方据此判定"无回放数据"，不伪造）。
 */
export function loadPersistedEvents(
  filter: {
    eventType?: EventType;
    traceId?: string;
    since?: number;
    limit?: number;
  } = {},
): DomainEvent[] {
  try {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.eventType) {
      clauses.push("event_type = ?");
      params.push(filter.eventType);
    }
    if (filter.traceId) {
      clauses.push("trace_id = ?");
      params.push(filter.traceId);
    }
    if (filter.since !== undefined) {
      clauses.push("published_at >= ?");
      params.push(filter.since);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    const rows = getEventsDb()
      .prepare(
        `SELECT * FROM domain_events ${where} ORDER BY published_at ASC LIMIT ?`,
      )
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      eventId: String(row["event_id"]),
      eventType: row["event_type"] as EventType,
      ...(row["trace_id"] ? { traceId: String(row["trace_id"]) } : {}),
      ...(row["loop_id"] ? { loopId: String(row["loop_id"]) } : {}),
      timestamp: Number(row["published_at"]),
      priority: (row["priority"] as EventPriority) ?? "normal",
      payload: safeParsePayload(row["payload"]),
      source: String(row["source"]),
    }));
  } catch {
    return [];
  }
}
