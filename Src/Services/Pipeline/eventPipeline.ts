/**
 * @module Pipeline/eventPipeline
 * @description
 * 事件管道——处理事件类请求的标准化管道�?
 * 支持事件路由、过滤和分发�?
 */

import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

/** 事件类型 */
export type SystemEvent =
  | 'agent.created'
  | 'agent.started'
  | 'agent.completed'
  | 'agent.failed'
  | 'tool.executed'
  | 'loop.iteration'
  | 'loop.terminated'
  | 'session.started'
  | 'session.ended'
  | 'token.consumed'
  | 'supervision.alert';

/** 事件载荷 */
export interface EventPayload {
  type: SystemEvent;
  timestamp: number;
  source: string;
  data: Record<string, unknown>;
  traceId: string;
}

/** 事件处理�?*/
export type EventHandler = (payload: EventPayload) => Promise<void>;

const eventHandlers: Map<SystemEvent, EventHandler[]> = new Map();
const eventLog: EventPayload[] = [];
const MAX_LOG_SIZE = 1000;

/** 注册事件处理�?*/
export function registerEventHandler(event: SystemEvent, handler: EventHandler): void {
  const list = eventHandlers.get(event) || [];
  list.push(handler);
  eventHandlers.set(event, list);
}

/** 发布事件 */
export async function publishEvent(payload: EventPayload): Promise<Result<void>> {
  // 记录到日�?
  eventLog.push(payload);
  if (eventLog.length > MAX_LOG_SIZE) eventLog.shift();

  // 分发到处理器
  const handlers = eventHandlers.get(payload.type) || [];
  for (const handler of handlers) {
    try {
      await handler(payload);
    } catch (e) {
      // 事件处理失败不应阻断管道
      console.error(`[EventPipeline] Handler failed for ${payload.type}:`, e);
    }
  }

  return ok(undefined);
}

/** 获取事件日志 */
export function getEventLog(limit?: number): EventPayload[] {
  if (limit) return eventLog.slice(-limit);
  return [...eventLog];
}

/** 清空事件日志和处理器 */
export function clearEventPipeline(): void {
  eventHandlers.clear();
  eventLog.length = 0;
}
