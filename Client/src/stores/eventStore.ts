/**
 * eventStore——全局事件缓冲（zustand）。
 *
 * 统一事件入口：useEventBus 订阅 subscribe 后，将原始消息推入本 store。
 * AIEventBus / Subscribe 等组件从本 store 读取，不再独立订阅 subscribe。
 *
 * 职责单一：仅负责事件缓冲 + 容量控制。
 * 事件分发到各业务 store 的逻辑仍在 useEventBus 中。
 */
import { create } from "zustand";
import { uiNumber } from "@/config/uiSettings";

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

/**
 * `ui.maxEventBufferSize` = 超限时保留的条数（设置面板可调，丢最旧、不阻断）。
 * 裁剪只在长度超过 2 倍时才发生一次，避免每次推入都切片——与接线前的
 * `MAX_EVENTS=1000 / TRIM_TO=500` 同语义（出厂默认 500 ⇒ 触发点仍是 1000）。
 */
const MAX_EVENTS_FALLBACK = 500;

// ── Store 实现 ──────────────────────────────────────────────────────

export const useEventStore = create<EventState>((set) => ({
  events: [],

  pushEvent: (msg) =>
    set((state) => {
      const keep = uiNumber("maxEventBufferSize", MAX_EVENTS_FALLBACK);
      const next = [...state.events, msg];
      if (next.length <= keep * 2) return { events: next };
      return { events: next.slice(next.length - keep) };
    }),

  clearEvents: () => set({ events: [] }),
}));
