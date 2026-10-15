/**
 * 任务状态 store。
 */
import { create } from "zustand";
import { apiGet, apiPost, apiDelete } from "@/services/api";

export interface TaskRecord {
  taskId: string;
  traceId: string;
  description: string;
  status: "submitted" | "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
  result?: string;
  /** 提交时用户指定的工作方式；缺省表示交给复杂度评估自动决定 */
  routingMode?: string;
}

interface TaskState {
  tasks: TaskRecord[];
  loading: boolean;
  hydrate: () => Promise<void>;
  submitTask: (
    description: string,
    routingMode?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  cancelTask: (taskId: string) => Promise<void>;
  applyEvent: (type: string, data: unknown) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  loading: false,

  hydrate: async () => {
    set({ loading: true });
    const res = await apiGet<TaskRecord[]>("/api/tasks");
    if (res.ok) set({ tasks: res.data, loading: false });
    else set({ loading: false });
  },

  submitTask: async (description, routingMode) => {
    const res = await apiPost<TaskRecord>("/api/tasks", {
      description,
      routingMode,
    });
    if (res.ok) {
      set({ tasks: [...get().tasks, res.data] });
      return { ok: true };
    }
    // 后端会拒绝不可执行的工作方式（400）——必须回传原因，否则"提交"按钮看起来坏了
    return { ok: false, error: res.error?.message ?? "任务提交失败" };
  },

  cancelTask: async (taskId) => {
    const res = await apiDelete<TaskRecord>(`/api/tasks/${taskId}`);
    if (res.ok) {
      set({
        tasks: get().tasks.map((t) => (t.taskId === taskId ? res.data : t)),
      });
    }
  },

  applyEvent: (type) => {
    if (type.startsWith("task:")) {
      useTaskStore.getState().hydrate();
    }
  },
}));
