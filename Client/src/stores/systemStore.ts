/**
 * 系统状态 store——在线状态 + 大屏概览。
 */
import { create } from 'zustand';
import { apiGet } from '@/services/api';

export interface DashboardOverview {
  activeAgents: number;
  totalAgents: number;
  activeArbitrationCases: number;
  totalArbitrationCases: number;
  arbitratorPool: { total: number; core: number; auxiliary: number; idle: number; busy: number };
  recentEvents: number;
}

interface SystemState {
  online: boolean;
  dashboard: DashboardOverview | null;
  lastUpdated: number;
  rateLimited: boolean;
  rateLimitedUntil: number;
  setOnline: (v: boolean) => void;
  setRateLimited: (retryAfterSec: number) => void;
  hydrate: () => Promise<void>;
}

export const useSystemStore = create<SystemState>((set) => ({
  online: false,
  dashboard: null,
  lastUpdated: 0,
  rateLimited: false,
  rateLimitedUntil: 0,

  setOnline: (v) => set({ online: v }),

  setRateLimited: (retryAfterSec) => {
    const until = Date.now() + retryAfterSec * 1000;
    set({ rateLimited: true, rateLimitedUntil: until });
    // 自动清除限流状态
    setTimeout(() => {
      if (Date.now() >= until) {
        set({ rateLimited: false, rateLimitedUntil: 0 });
      }
    }, retryAfterSec * 1000 + 500);
  },

  hydrate: async () => {
    const res = await apiGet<DashboardOverview>('/api/loops/dashboard');
    if (res.ok) {
      set({ dashboard: res.data, lastUpdated: Date.now() });
    }
  },
}));
