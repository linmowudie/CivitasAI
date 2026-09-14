/**
 * @module EventBus/eventRouter
 * @description
 * 事件路由器——Docs/07 §4 / Docs/08。
 * 根据事件类型/优先级路由到不同处理器队列。
 * critical 事件同步处理，其余异步。
 */

import type { DomainEvent, EventType, EventHandler } from './eventTypes.js';
import { subscribe, publish } from './eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 路由规则 ────────────────────────────────────────────────────────

interface RouteRule {
  eventTypes: EventType[];
  handler: EventHandler;
  sync: boolean;       // true = 同步处理（阻塞发布），false = 异步
  priority: number;    // 越小越先执行
}

const routes: RouteRule[] = [];

// ── 注册路由 ────────────────────────────────────────────────────────

export function registerRoute(params: {
  eventTypes: EventType[];
  handler: EventHandler;
  sync?: boolean;
  priority?: number;
}): void {
  routes.push({
    eventTypes: params.eventTypes,
    handler: params.handler,
    sync: params.sync ?? false,
    priority: params.priority ?? 50,
  });
  // 按优先级排序
  routes.sort((a, b) => a.priority - b.priority);
}

// ── 启动路由 ────────────────────────────────────────────────────────

/**
 * 启动事件路由——为所有注册的路由创建订阅。
 * critical 事件同步执行，其余异步。
 */
export function startRouter(): void {
  for (const route of routes) {
    for (const eventType of route.eventTypes) {
      subscribe(eventType, async (event) => {
        if (route.sync || event.priority === 'critical') {
          await route.handler(event);
        } else {
          // 异步不阻塞
          Promise.resolve(route.handler(event)).catch(() => {});
        }
      });
    }
  }
}

// ── 转发事件 ────────────────────────────────────────────────────────

/**
 * 将事件转发到事件总线（便捷方法）
 */
export function forwardEvent(event: DomainEvent): Result<void> {
  return publish(event);
}

// ── 清理 ────────────────────────────────────────────────────────────

export function resetRouter(): void {
  routes.length = 0;
}
