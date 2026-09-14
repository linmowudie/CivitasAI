/**
 * Agent 状态 store。
 */
import { create } from 'zustand';
import { apiGet } from '@/services/api';

export interface AgentInfo {
  agentId: string;
  traceId: string;
  role: string;
  status: string;
  trustLevel: string;
  model?: string;
  createdAt: number;
}

interface AgentState {
  agents: AgentInfo[];
  loading: boolean;
  hydrate: () => Promise<void>;
  applyEvent: (type: string, data: unknown) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  loading: false,

  hydrate: async () => {
    set({ loading: true });
    const res = await apiGet<AgentInfo[]>('/api/agents');
    if (res.ok) set({ agents: res.data, loading: false });
    else set({ loading: false });
  },

  applyEvent: (type, data) => {
    // 增量更新：agent 相关事件触发重新拉取
    if (type.startsWith('agent:')) {
      useAgentStore.getState().hydrate();
    }
  },
}));
