/**
 * todoStore —— Agent 计划清单（TODO）前端状态。
 *
 * 多 agent 语义（关键）：
 *  - 计划**按来源 agent 归属**：同一会话下每个 agent 各有一组计划，平级 agent 互不覆盖；
 *  - 状态存储：`groupsBySession[sessionId] = TodoAgentGroup[]`，面板按 agent 分组渲染；
 *  - 实时更新：订阅本地事件 `agent:todo_updated`（携带 agentId），事件既来自运行中的工具调用，
 *    也来自重启后的 `ai_events` 回放 → 两种情况都能重建面板；
 *  - 权威数据源是本地库（`/api/sessions/:id/todos`），事件只做增量刷新，必要时可重新 hydrate 校正。
 */

import { create } from 'zustand';
import { apiGet, apiDelete } from '@/services/api';
import { useEventStore } from '@/stores/eventStore';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  todoId: string;
  content: string;
  status: TodoStatus;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface TodoProgress {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

/** 某个 agent 在会话中的计划（前端按此分组展示） */
export interface TodoAgentGroup {
  sessionId: string;
  agentId: string;
  agentRole?: string;
  todos: TodoItem[];
  progress: TodoProgress;
  updatedAt: number;
}

interface TodoState {
  /** sessionId → 该会话下各 agent 的计划分组 */
  groupsBySession: Record<string, TodoAgentGroup[]>;
  /** 面板当前选中的 agent（缺省选中"最近更新"的那个，平级 agent 可切换查看） */
  selectedAgentBySession: Record<string, string | null>;
  loading: boolean;

  /** 拉取某会话的计划（分 agent 分组） */
  hydrate: (sessionId: string) => Promise<void>;
  /** 选择要查看的 agent（多 agent 平级时的切换） */
  selectAgent: (sessionId: string, agentId: string | null) => void;
  /** 事件驱动的增量更新（agent:todo_updated；也用于回放） */
  applyEvent: (payload: {
    sessionId?: string;
    agentId?: string | null;
    agentRole?: string | null;
    todos?: TodoItem[];
    progress?: TodoProgress;
    cleared?: boolean;
  }) => void;
  /** 清空某 agent 的计划（或整会话） */
  clear: (sessionId: string, agentId?: string) => Promise<boolean>;
}

/** 本地事件总线中计划更新事件的类型（与后端 EventType.AGENT_TODO_UPDATED 一致） */
const TODO_EVENT_TYPE = 'agent:todo_updated';

const EMPTY_PROGRESS: TodoProgress = { total: 0, pending: 0, inProgress: 0, completed: 0 };

function progressOf(items: TodoItem[]): TodoProgress {
  const p: TodoProgress = { total: items.length, pending: 0, inProgress: 0, completed: 0 };
  for (const it of items) {
    if (it.status === 'completed') p.completed++;
    else if (it.status === 'in_progress') p.inProgress++;
    else p.pending++;
  }
  return p;
}

export const useTodoStore = create<TodoState>((set, get) => ({
  groupsBySession: {},
  selectedAgentBySession: {},
  loading: false,

  hydrate: async (sessionId) => {
    if (!sessionId) return;
    set({ loading: true });
    const res = await apiGet<{ sessionId: string; groups: TodoAgentGroup[]; total: number }>(
      `/api/sessions/${sessionId}/todos`,
    );
    if (!res.ok) {
      set({ loading: false });
      return;
    }
    const groups = (res.data.groups ?? []).map((g) => ({ ...g, progress: g.progress ?? progressOf(g.todos ?? []) }));
    set((state) => ({
      groupsBySession: { ...state.groupsBySession, [sessionId]: groups },
      loading: false,
    }));
    // 未选过 agent 时，默认选中最近更新的那个（通常是正在干活的主 agent）
    if (!get().selectedAgentBySession[sessionId] && groups.length > 0) {
      const latest = [...groups].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]!;
      get().selectAgent(sessionId, latest.agentId);
    }
  },

  selectAgent: (sessionId, agentId) => {
    set((state) => ({
      selectedAgentBySession: { ...state.selectedAgentBySession, [sessionId]: agentId },
    }));
  },

  applyEvent: (payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    const agentId = payload.agentId ?? undefined;
    set((state) => {
      const current = state.groupsBySession[sessionId] ?? [];
      // 清空事件：移除对应 agent（或整会话）
      if (payload.cleared) {
        const next = agentId ? current.filter((g) => g.agentId !== agentId) : [];
        return { groupsBySession: { ...state.groupsBySession, [sessionId]: next } };
      }
      if (!agentId) return state;
      const todos = (payload.todos ?? []) as TodoItem[];
      const group: TodoAgentGroup = {
        sessionId,
        agentId,
        agentRole: payload.agentRole ?? current.find((g) => g.agentId === agentId)?.agentRole,
        todos,
        progress: payload.progress ?? progressOf(todos),
        updatedAt: Date.now(),
      };
      const others = current.filter((g) => g.agentId !== agentId);
      const next = [...others, group];
      return { groupsBySession: { ...state.groupsBySession, [sessionId]: next } };
    });
  },

  clear: async (sessionId, agentId) => {
    const url = agentId
      ? `/api/sessions/${sessionId}/todos?agentId=${encodeURIComponent(agentId)}`
      : `/api/sessions/${sessionId}/todos`;
    const res = await apiDelete(url);
    if (!res.ok) return false;
    await get().hydrate(sessionId);
    return true;
  },
}));

/** 取某会话下选中的 agent 分组（面板渲染入口） */
export function selectActiveGroup(state: TodoState, sessionId: string | null): TodoAgentGroup | null {
  if (!sessionId) return null;
  const groups = state.groupsBySession[sessionId] ?? [];
  if (groups.length === 0) return null;
  const selected = state.selectedAgentBySession[sessionId];
  return groups.find((g) => g.agentId === selected) ?? groups[0] ?? null;
}

// ── 事件接入（实时 + 回放共用一条通路）────────────────────────────
// 实时：useEventBus 收到本地事件 → eventStore.pushEvent
// 回放：replayAiEvents（重启/切回会话）→ eventStore.pushEvent
// 两者都会触发下面的订阅，因此计划面板在两种情况下都能重建。
useEventStore.subscribe((state, prev) => {
  if (state.events === prev.events) return;
  const last = state.events[state.events.length - 1];
  if (!last || last.type !== TODO_EVENT_TYPE) return;
  useTodoStore.getState().applyEvent((last.data ?? {}) as Parameters<TodoState['applyEvent']>[0]);
});

export { EMPTY_PROGRESS, progressOf };
