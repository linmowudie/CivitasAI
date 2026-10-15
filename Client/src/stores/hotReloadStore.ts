/**
 * @module stores/hotReloadStore
 * @description
 * 配置变更的**提交时机队列**（不是"生效状态"的记账本）。
 *
 * 边界（REV-266 的修复口径）：
 * - 本 store 只管**什么时候把改动 PUT 给后端**：
 *     · immediate / onRestart → 由 `configStore.setValue` 直接提交，不入队
 *     · afterReply → Agent 回复结束（`AGENT_STREAM_END`）时提交
 *     · onNavigate → 离开当前对话/视图时提交
 * - "改了之后到底生没生效"**不在这里**：那是后端 `running` / `onDisk` 的比对结果，
 *   由 `configStore.fieldState()` 给出。历史实现把这两件事混在一起，
 *   于是出现"本地记了 N 项待生效、后端从未收到任何一个键"的假绿灯。
 *
 * 持久化：pending 存入 localStorage，刷新页面不丢失（未提交的改动仍在队列里）。
 */

import { create } from "zustand";
import type { ReloadStrategy } from "@/config/schemaTypes";
import type { FieldValue } from "@/components/Settings/fields";

const LS_PENDING = "civitas.hotreload.pending.v1";

/** 哨兵值：该项的期望动作是"请后端删除这个键的用户覆盖"（重置为默认） */
export const PENDING_UNSET = "@@unset@@";

// ── 类型 ────────────────────────────────────────────────────────────

export interface PendingChange {
  key: string;
  value: FieldValue;
  strategy: ReloadStrategy;
  timestamp: number;
  /** 来源：本地用户修改 or 云端同步拉取 */
  source: "local" | "cloud";
}

// ── 持久化 ──────────────────────────────────────────────────────────

function loadPending(): PendingChange[] {
  try {
    const raw = localStorage.getItem(LS_PENDING);
    return raw ? (JSON.parse(raw) as PendingChange[]) : [];
  } catch {
    return [];
  }
}

function persistPending(list: PendingChange[]) {
  try {
    localStorage.setItem(LS_PENDING, JSON.stringify(list));
  } catch {
    /* 隐私模式忽略 */
  }
}

// ── Store ───────────────────────────────────────────────────────────

interface HotReloadState {
  /** 待提交队列（afterReply / onNavigate） */
  pending: PendingChange[];

  /** 入队一项变更（同 key 覆盖旧项）；immediate/onRestart 不入队（调用方已直接提交） */
  scheduleReload: (
    key: string,
    value: FieldValue,
    strategy: ReloadStrategy,
    source?: "local" | "cloud",
  ) => void;

  /** Agent 回复完成后调用：批量提交 afterReply 级 */
  flushAfterReply: () => void;

  /** 离开对话时调用：批量提交 onNavigate 级 */
  flushOnNavigate: () => void;

  /** 撤销某项待提交变更（同时丢弃本地期望值，回到后端当前值） */
  dismissPending: (key: string) => void;

  /** 按策略统计待提交数量 */
  pendingCount: (strategy?: ReloadStrategy) => number;

  /** 清空所有待提交（测试用） */
  clearAll: () => void;
}

/**
 * 提交一组队列项。
 * 动态导入避免 configStore ↔ hotReloadStore 的循环依赖。
 */
function submit(items: PendingChange[]): void {
  if (items.length === 0) return;
  import("@/stores/configStore").then(({ useConfigStore }) => {
    void useConfigStore
      .getState()
      .persistFields(items.map((i) => ({ key: i.key, value: i.value })));
  });
}

export const useHotReloadStore = create<HotReloadState>((set, get) => ({
  pending: loadPending(),

  scheduleReload: (key, value, strategy, source = "local") => {
    // immediate / onRestart 由 configStore 立即提交，不入队
    if (strategy === "immediate" || strategy === "onRestart") return;

    const change: PendingChange = {
      key,
      value,
      strategy,
      timestamp: Date.now(),
      source,
    };
    set((state) => {
      const next = [...state.pending.filter((c) => c.key !== key), change];
      persistPending(next);
      return { pending: next };
    });
  },

  flushAfterReply: () => {
    const toFlush = get().pending.filter((c) => c.strategy === "afterReply");
    if (toFlush.length === 0) return;
    set((state) => {
      const next = state.pending.filter((c) => c.strategy !== "afterReply");
      persistPending(next);
      return { pending: next };
    });
    submit(toFlush);
  },

  flushOnNavigate: () => {
    const toFlush = get().pending.filter((c) => c.strategy === "onNavigate");
    if (toFlush.length === 0) return;
    set((state) => {
      const next = state.pending.filter((c) => c.strategy !== "onNavigate");
      persistPending(next);
      return { pending: next };
    });
    submit(toFlush);
  },

  dismissPending: (key) => {
    set((state) => {
      const next = state.pending.filter((c) => c.key !== key);
      persistPending(next);
      return { pending: next };
    });
    // 撤销必须连本地期望值一起丢弃，否则界面显示一个"既不提交也不生效"的值
    import("@/stores/configStore").then(({ useConfigStore }) => {
      useConfigStore.getState().discardDesired(key);
    });
  },

  pendingCount: (strategy) => {
    const { pending } = get();
    if (!strategy) return pending.length;
    return pending.filter((c) => c.strategy === strategy).length;
  },

  clearAll: () => {
    persistPending([]);
    set({ pending: [] });
  },
}));
