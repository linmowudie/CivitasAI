/**
 * Agent 状态 store。
 */
import { create } from "zustand";
import { apiGet } from "@/services/api";
import { EventType } from "@/shared/eventTypes";

export interface AgentInfo {
  agentId: string;
  traceId: string;
  role: string;
  status: string;
  trustLevel: string;
  model?: string;
  createdAt: number;
}

/**
 * 只有这些事件会改变 Agent 花名册。
 *
 * 其余 `agent:*`（`stream_chunk` 逐 token、`iteration_complete` 每轮、
 * `tool_call_*` 每次工具调用）与花名册无关 —— 此前对它们一律 `hydrate()`，
 * 等于生成期每 token 发一次 `GET /api/agents`，打满限流后连审批写入都被 429
 * （REV-314，症状与 REV-264 叠加成"点了批准没反应"）。
 */
const ROSTER_EVENTS = new Set<string>([
  EventType.AGENT_RECRUITED,
  EventType.AGENT_READY,
  EventType.AGENT_EXPELLED,
  EventType.AGENT_DESTROYED,
  EventType.LOOP_STARTED,
  EventType.LOOP_COMPLETED,
  EventType.LOOP_ABORTED,
]);

/** 合批窗口：窗口内的多次花名册变化只拉一次 */
const ROSTER_COALESCE_MS = 1_000;

let rosterTimer: ReturnType<typeof setTimeout> | null = null;

interface AgentState {
  agents: AgentInfo[];
  loading: boolean;
  hydrate: () => Promise<void>;
  applyEvent: (type: string) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  loading: false,

  hydrate: async () => {
    set({ loading: true });
    const res = await apiGet<AgentInfo[]>("/api/agents");
    if (res.ok) set({ agents: res.data, loading: false });
    else set({ loading: false });
  },

  applyEvent: (type) => {
    if (!ROSTER_EVENTS.has(type)) return;
    if (rosterTimer) return;
    rosterTimer = setTimeout(() => {
      rosterTimer = null;
      void useAgentStore.getState().hydrate();
    }, ROSTER_COALESCE_MS);
  },
}));
