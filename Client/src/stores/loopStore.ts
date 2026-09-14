/**
 * Loop / 事件 store。
 */
import { create } from 'zustand';
import { apiGet } from '@/services/api';

export interface DomainEvent {
  eventId: string;
  eventType: string;
  traceId?: string;
  loopId?: string;
  timestamp: number;
  source: string;
  payload: Record<string, unknown>;
}

interface LoopState {
  events: DomainEvent[];
  loading: boolean;
  hydrate: (filter?: { traceId?: string; limit?: number }) => Promise<void>;
}

export const useLoopStore = create<LoopState>((set) => ({
  events: [],
  loading: false,

  hydrate: async (filter) => {
    set({ loading: true });
    const params = new URLSearchParams();
    if (filter?.traceId) params.set('traceId', filter.traceId);
    if (filter?.limit) params.set('limit', String(filter.limit));
    const qs = params.toString();
    const res = await apiGet<DomainEvent[]>(`/api/loops/events${qs ? `?${qs}` : ''}`);
    if (res.ok) set({ events: res.data, loading: false });
    else set({ loading: false });
  },
}));
