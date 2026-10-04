/**
 * eventStore——全局事件缓冲（zustand）。
 *
 * 统一事件入口：useEventBus 订阅 subscribe 后，将原始消息推入本 store。
 * AIEventBus / Subscribe 等组件从本 store 读取，不再独立订阅 subscribe。
 *
 * 职责单一：仅负责事件缓冲 + 容量控制。
 * 事件分发到各业务 store 的逻辑仍在 useEventBus 中。
 */
import { create } from 'zustand';

// ── 类型 ────────────────────────────────────────────────────────────

export interface RawBusMessage {
  type: string;
  data: unknown;
  timestamp: number;
}

interface EventState {
  /** 全局事件缓冲（按时间顺序） */
  events: RawBusMessage[];
  /** 推入一条事件（由 useEventBus 调用） */
  pushEvent: (msg: RawBusMessage) => void;
  /** 清空事件缓冲 */
  clearEvents: () => void;
}

// ── 容量控制 ────────────────────────────────────────────────────────

const MAX_EVENTS = 1000;
const TRIM_TO = 500; // 超限时保留最新 N 条

// ── Store 实现 ──────────────────────────────────────────────────────

export const useEventStore = create<EventState>((set) => ({
  events: [],

  pushEvent: (msg) =>
    set((state) => {
      const next = [...state.events, msg];
      if (next.length > MAX_EVENTS) {
        return { events: next.slice(-TRIM_TO) };
      }
      return { events: next };
    }),

  clearEvents: () => set({ events: [] }),
}));
