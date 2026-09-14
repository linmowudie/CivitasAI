/**
 * 任务状态 store。
 */
import { create } from 'zustand';
import { apiGet, apiPost, apiDelete } from '@/services/api';

export interface TaskRecord {
  taskId: string;
  traceId: string;
  description: string;
  status: 'submitted' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  completedAt?: number;
  result?: string;
}

interface TaskState {
  tasks: TaskRecord[];
  loading: boolean;
  hydrate: () => Promise<void>;
  submitTask: (description: string) => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
  applyEvent: (type: string, data: unknown) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  loading: false,

  hydrate: async () => {
    set({ loading: true });
    const res = await apiGet<TaskRecord[]>('/api/tasks');
    if (res.ok) set({ tasks: res.data, loading: false });
    else set({ loading: false });
  },

  submitTask: async (description) => {
    const res = await apiPost<TaskRecord>('/api/tasks', { description });
    if (res.ok) {
      set({ tasks: [...get().tasks, res.data] });
    }
  },

  cancelTask: async (taskId) => {
    const res = await apiDelete<TaskRecord>(`/api/tasks/${taskId}`);
    if (res.ok) {
      set({ tasks: get().tasks.map(t => t.taskId === taskId ? res.data : t) });
    }
  },

  applyEvent: (type) => {
    if (type.startsWith('task:')) {
      useTaskStore.getState().hydrate();
    }
  },
}));
