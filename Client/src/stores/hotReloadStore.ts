/**
 * @module stores/hotReloadStore
 * @description
 * 热重载队列管理——四级生效策略。
 *
 * 配置变更按 reloadStrategy 分级：
 *   - immediate:  setValue 时直接生效，不入队
 *   - afterReply: Agent 回复完成后生效（AGENT_STREAM_END 触发）
 *   - onNavigate: 离开当前对话窗口时生效（切换对话/视图触发）
 *   - onRestart:  需重启服务后生效（仅 UI 提示，不自动生效）
 *
 * 持久化：pending / restartRequired 存入 localStorage，刷新页面不丢失。
 */

import { create } from 'zustand';
import type { ReloadStrategy } from '@/config/schemaTypes';
import type { FieldValue } from '@/components/Settings/fields';

const LS_PENDING = 'civitas.hotreload.pending.v1';
const LS_RESTART = 'civitas.hotreload.restart.v1';

// ── 类型 ────────────────────────────────────────────────────────────

export interface PendingChange {
  key: string;
  value: FieldValue;
  strategy: ReloadStrategy;
  timestamp: number;
  /** 来源：本地用户修改 or 云端同步拉取 */
  source: 'local' | 'cloud';
}

// ── 持久化 ──────────────────────────────────────────────────────────

function loadPending(): PendingChange[] {
  try {
    const raw = localStorage.getItem(LS_PENDING);
    return raw ? JSON.parse(raw) as PendingChange[] : [];
  } catch { return []; }
}

function loadRestart(): PendingChange[] {
  try {
    const raw = localStorage.getItem(LS_RESTART);
    return raw ? JSON.parse(raw) as PendingChange[] : [];
  } catch { return []; }
}

function persistPending(list: PendingChange[]) {
  try { localStorage.setItem(LS_PENDING, JSON.stringify(list)); } catch { /* 隐私模式忽略 */ }
}

function persistRestart(list: PendingChange[]) {
  try { localStorage.setItem(LS_RESTART, JSON.stringify(list)); } catch { /* 隐私模式忽略 */ }
}

// ── Store ───────────────────────────────────────────────────────────

interface HotReloadState {
  /** 待生效队列（afterReply / onNavigate） */
  pending: PendingChange[];
  /** 需重启的变更（onRestart） */
  restartRequired: PendingChange[];

  /**
   * 入队一项变更。
   * immediate 级别不入队（setValue 时已直接生效）。
   */
  scheduleReload: (key: string, value: FieldValue, strategy: ReloadStrategy, source?: 'local' | 'cloud') => void;

  /** 批量入队（云端 pull 后使用） */
  applyCloudChanges: (changes: Record<string, FieldValue>) => void;

  /** Agent 回复完成后调用：生效 afterReply 级 */
  flushAfterReply: () => void;

  /** 离开对话时调用：生效 onNavigate 级 */
  flushOnNavigate: () => void;

  /** 清除某项 pending（用户撤销或已被覆盖） */
  dismissPending: (key: string) => void;

  /** 清除某项 restartRequired */
  dismissRestart: (key: string) => void;

  /** 按策略统计待生效数量 */
  pendingCount: (strategy?: ReloadStrategy) => number;

  /** 需重启数量 */
  restartCount: () => number;

  /** 清空所有 pending（测试用） */
  clearAll: () => void;
}

export const useHotReloadStore = create<HotReloadState>((set, get) => ({
  pending: loadPending(),
  restartRequired: loadRestart(),

  scheduleReload: (key, value, strategy, source = 'local') => {
    // immediate 不入队
    if (strategy === 'immediate') return;

    const change: PendingChange = { key, value, strategy, timestamp: Date.now(), source };

    if (strategy === 'onRestart') {
      // 入 restartRequired（同 key 覆盖）
      set(state => {
        const filtered = state.restartRequired.filter(c => c.key !== key);
        const next = [...filtered, change];
        persistRestart(next);
        return { restartRequired: next };
      });
    } else {
      // afterReply / onNavigate 入 pending（同 key 覆盖）
      set(state => {
        const filtered = state.pending.filter(c => c.key !== key);
        const next = [...filtered, change];
        persistPending(next);
        return { pending: next };
      });
    }
  },

  applyCloudChanges: (changes) => {
    // 云端变更按各字段的 reloadStrategy 入队
    // 这里只负责入队，strategy 由调用方（configStore.applyFromCloud）判断
    // 因此 applyCloudChanges 接收的 changes 已经是带 strategy 的
    // 实际逻辑在 configStore 中调用 scheduleReload
    // 本方法保留为批量入口，便于未来扩展
    for (const [key, value] of Object.entries(changes)) {
      // 云端变更默认走 afterReply（安全起见，不立即生效）
      get().scheduleReload(key, value, 'afterReply', 'cloud');
    }
  },

  flushAfterReply: () => {
    const { pending } = get();
    const toFlush = pending.filter(c => c.strategy === 'afterReply');
    if (toFlush.length === 0) return;

    // 从 pending 中移除已 flush 的项
    set(state => {
      const next = state.pending.filter(c => c.strategy !== 'afterReply');
      persistPending(next);
      return { pending: next };
    });

    // 通知 configStore 使运行时真正生效
    // 延迟导入避免循环依赖
    import('@/stores/configStore').then(({ useConfigStore }) => {
      for (const c of toFlush) {
        useConfigStore.getState().applyEffective(c.key, c.value);
      }
    });
  },

  flushOnNavigate: () => {
    const { pending } = get();
    const toFlush = pending.filter(c => c.strategy === 'onNavigate');
    if (toFlush.length === 0) return;

    set(state => {
      const next = state.pending.filter(c => c.strategy !== 'onNavigate');
      persistPending(next);
      return { pending: next };
    });

    import('@/stores/configStore').then(({ useConfigStore }) => {
      for (const c of toFlush) {
        useConfigStore.getState().applyEffective(c.key, c.value);
      }
    });
  },

  dismissPending: (key) => {
    set(state => {
      const next = state.pending.filter(c => c.key !== key);
      persistPending(next);
      return { pending: next };
    });
  },

  dismissRestart: (key) => {
    set(state => {
      const next = state.restartRequired.filter(c => c.key !== key);
      persistRestart(next);
      return { restartRequired: next };
    });
  },

  pendingCount: (strategy) => {
    const { pending } = get();
    if (!strategy) return pending.length;
    return pending.filter(c => c.strategy === strategy).length;
  },

  restartCount: () => get().restartRequired.length,

  clearAll: () => {
    persistPending([]);
    persistRestart([]);
    set({ pending: [], restartRequired: [] });
  },
}));
