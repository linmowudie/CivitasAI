/**
 * AIEventBus——声明式事件订阅容器。
 * Docs/Client/03-AI组件族架构 §5.2。
 *
 * 职责：
 * 1. 从全局事件缓冲（eventStore）读取事件（不再独立订阅 subscribe）
 * 2. 通过 React Context 传递给子组件（Subscribe）
 * 3. 按 sessionId 隔离事件（多会话支持）
 *
 * 数据流：
 *   eventBusBridge → useEventBus（唯一 subscribe）→ eventStore → AIEventBus → Subscribe
 *
 * 使用方式：
 * ```tsx
 * <AIEventBus sessionId={sessionId}>
 *   <Subscribe eventTypes={['agent:stream_chunk']}>
 *     {(events) => <StreamBuffer events={events} />}
 *   </Subscribe>
 * </AIEventBus>
 * ```
 */

import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useEventStore } from '@/stores/eventStore';
import type { AIEvent } from './types';

// ── Context ─────────────────────────────────────────────────────────

interface EventBusContextValue {
  events: AIEvent[];
  sessionId: string;
}

const EventBusContext = createContext<EventBusContextValue>({
  events: [],
  sessionId: '',
});

// ── Props ───────────────────────────────────────────────────────────

interface AIEventBusProps {
  /** 会话 ID（事件按会话隔离） */
  sessionId: string;
  /** 子组件（Subscribe 组件需作为子级） */
  children: ReactNode;
}

// ── 组件实现 ────────────────────────────────────────────────────────

export function AIEventBus({ sessionId, children }: AIEventBusProps) {
  // 从全局事件缓冲读取（不再独立 subscribe）
  const rawEvents = useEventStore((s) => s.events);
  const clearEvents = useEventStore((s) => s.clearEvents);

  // 切换会话时清空事件缓冲（首次挂载不清空，保留已有事件）
  const prevSessionId = useRef(sessionId);
  useEffect(() => {
    if (prevSessionId.current !== sessionId) {
      clearEvents();
      prevSessionId.current = sessionId;
    }
  }, [sessionId, clearEvents]);

  // 将原始消息转换为 AIEvent（useMemo 避免每次渲染重新转换）
  const events = useMemo<AIEvent[]>(() =>
    rawEvents.map((msg, i) => ({
      id: `${msg.type}-${msg.timestamp}-${i}`,
      type: msg.type,
      data: (msg.data ?? {}) as Record<string, unknown>,
      timestamp: msg.timestamp,
    })),
    [rawEvents],
  );

  return (
    <EventBusContext.Provider value={{ events, sessionId }}>
      {children}
    </EventBusContext.Provider>
  );
}

// ── Hook：访问事件上下文 ────────────────────────────────────────────

export function useEventBusContext(): EventBusContextValue {
  return useContext(EventBusContext);
}

// ── 导出 Context 供 Subscribe 使用 ──────────────────────────────────

export { EventBusContext };
