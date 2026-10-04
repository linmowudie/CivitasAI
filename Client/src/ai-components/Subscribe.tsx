/**
 * Subscribe——声明式事件订阅组件。
 * Docs/Client/03-AI组件族架构 §5.2。
 *
 * 支持：
 * - 精确匹配：eventTypes={['agent:stream_chunk']}
 * - 通配符匹配：eventTypes={['memory:*']}
 * - 多事件类型：eventTypes={['agent:tool_call', 'agent:tool_result']}
 * - 注册表动态渲染：自动从 registry 查找并渲染匹配组件
 * - 自定义渲染：通过 children render prop 覆盖注册表渲染
 *
 * 使用方式（注册表自动渲染）：
 * ```tsx
 * <Subscribe eventTypes={['agent:tool_call']} />
 * ```
 *
 * 使用方式（自定义渲染）：
 * ```tsx
 * <Subscribe eventTypes={['agent:stream_chunk']}>
 *   {(events) => <StreamBuffer events={events} />}
 * </Subscribe>
 * ```
 */

import { useContext, useEffect, useMemo, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { EventBusContext } from './AIEventBus';
import { registry } from './registry';
import type { AIEvent } from './types';

// ── Props ───────────────────────────────────────────────────────────

interface SubscribeProps {
  /** 订阅的事件类型（支持通配符，如 'agent:tool_*'） */
  eventTypes: string[];
  /** 自定义渲染函数（提供时覆盖注册表自动渲染） */
  children?: (events: AIEvent[]) => ReactNode;
}

// ── 组件实现 ────────────────────────────────────────────────────────

export function Subscribe({ eventTypes, children }: SubscribeProps) {
  const { events } = useContext(EventBusContext);

  // 过滤出订阅的事件类型（useMemo 避免每次渲染都重新过滤）
  const filteredEvents = useMemo(() => {
    return events.filter(event =>
      eventTypes.some(pattern => matchEventType(event.type, pattern))
    );
  }, [events, eventTypes]);

  // ── 注册表动态渲染 ────────────────────────────────────────────────

  // 已解析的事件ID → 组件映射
  const [resolved, setResolved] = useState<Map<string, ComponentType<{ payload: any; event?: AIEvent }>>>(new Map());
  // 正在加载中的事件类型（避免重复查询）
  const [pendingTypes, setPendingTypes] = useState<Set<string>>(new Set());
  // 已确认无组件的事件类型（避免重复查询）
  const [missedTypes, setMissedTypes] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    for (const event of filteredEvents) {
      // 已解析或已确认无组件 → 跳过
      if (resolved.has(event.id) || missedTypes.has(event.type)) continue;

      // 正在加载中 → 跳过（等 useEffect 下次触发）
      if (pendingTypes.has(event.type)) continue;

      // 同步检查注册表是否已有
      if (registry.hasComponent(event.type)) {
        setPendingTypes(prev => new Set(prev).add(event.type));
        registry.getComponent(event.type).then(comp => {
          if (cancelled) return;
          if (comp) {
            setResolved(prev => new Map(prev).set(event.id, comp));
          } else {
            setMissedTypes(prev => new Set(prev).add(event.type));
          }
          setPendingTypes(prev => { const next = new Set(prev); next.delete(event.type); return next; });
        });
      } else {
        // 尝试异步加载（懒加载族）
        setPendingTypes(prev => new Set(prev).add(event.type));
        registry.getComponent(event.type).then(comp => {
          if (cancelled) return;
          if (comp) {
            setResolved(prev => new Map(prev).set(event.id, comp));
          } else {
            setMissedTypes(prev => new Set(prev).add(event.type));
          }
          setPendingTypes(prev => { const next = new Set(prev); next.delete(event.type); return next; });
        });
      }
    }

    return () => { cancelled = true; };
  }, [filteredEvents, resolved, pendingTypes, missedTypes]);

  // ── 渲染 ──────────────────────────────────────────────────────────

  // 如果提供了 children render prop → 使用自定义渲染（覆盖注册表）
  if (children) {
    return <>{children(filteredEvents)}</>;
  }

  // 注册表自动渲染模式
  return (
    <>
      {filteredEvents.map(event => {
        const Component = resolved.get(event.id);
        if (Component) {
          return <Component key={event.id} payload={event.data} event={event} />;
        }
        // 正在加载或无匹配组件 → 不渲染（静默跳过）
        return null;
      })}
    </>
  );
}

// ── 通配符匹配 ──────────────────────────────────────────────────────

/**
 * 匹配事件类型（支持通配符 *）
 * - 'agent:stream_chunk' === 'agent:stream_chunk' → true
 * - 'agent:stream_chunk' matches 'agent:*' → true
 * - 'memory:written' matches 'memory:*' → true
 */
function matchEventType(actual: string, pattern: string): boolean {
  if (pattern === actual) return true;

  if (pattern.includes('*')) {
    // 将通配符模式转为正则
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(actual);
  }

  return false;
}

// ── 导出匹配工具函数（供测试使用）───────────────────────────────────

export { matchEventType };
