/**
 * useTaskStream hook——任务流式事件订阅。
 * F2 将扩展为流式 Markdown 渲染；F1 仅拉取事件列表。
 */
import { useEffect } from 'react';
import { useLoopStore } from '@/stores/loopStore';

export function useTaskStream(traceId?: string) {
  const events = useLoopStore(s => s.events);
  const loading = useLoopStore(s => s.loading);

  useEffect(() => {
    useLoopStore.getState().hydrate(traceId ? { traceId, limit: 100 } : { limit: 50 });
  }, [traceId]);

  return { events, loading };
}
