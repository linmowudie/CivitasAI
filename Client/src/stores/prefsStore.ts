/**
 * @module stores/prefsStore
 * @description
 * 可同步的**应用偏好**（上传到服务端 `settings.data.app`）+ 同步元数据（仅本地）。
 *
 * 与 chatStore 的分工：
 *  - chatStore 是"当前运行时选中项"的真源（模型/工作方式）；
 *  - 本 store 保存**偏好快照**用于同步与脏标记；`syncService` 负责两侧桥接
 *    （push 时从 chatStore 取值合并进来，pull 后写回 chatStore）。
 *
 * 持久化：`localStorage`（偏好是明文本地数据，不含密钥）。
 */

import { create } from 'zustand';

export interface AppPreferences {
  /** 选中模型（qualified name，如 huawei-maas/GLM-5.1） */
  selectedModel: string;
  /** 工作方式（DIRECT 等） */
  selectedWorkingMode: string;
  /** 主题偏好（预留） */
  theme: string;
  /** 上次停留的功能视图（便于换机后回到同一处） */
  lastActiveFeature: string;
}

export const DEFAULT_PREFS: AppPreferences = {
  selectedModel: '',
  selectedWorkingMode: 'DIRECT',
  theme: 'dark',
  lastActiveFeature: 'chat',
};

/** 本地同步元数据（不上传服务端） */
export interface SyncMeta {
  /** 元数据归属的账号（服务端 userId；未登录为 null）——跨账号隔离的关键（FE-032） */
  userId: string | null;
  /** 服务端设置修订号（乐观并发用） */
  serverRevision: number;
  /** 统计上行水位（epoch ms） */
  statsSyncSince: number;
  /** 上次成功拉取/上传时间 */
  lastPullAt: number | null;
  lastPushAt: number | null;
}

export const DEFAULT_SYNC_META: SyncMeta = {
  userId: null,
  serverRevision: 0,
  statsSyncSince: 0,
  lastPullAt: null,
  lastPushAt: null,
};

const PREFS_KEY = 'civitas.prefs';
const META_KEY = 'civitas.sync.meta';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<T>;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略：隐私模式等场景下 localStorage 不可用 */
  }
}

interface PrefsState {
  prefs: AppPreferences;
  meta: SyncMeta;
  /** 本地有未上传的偏好改动 */
  dirty: boolean;
  loaded: boolean;

  hydrate: () => void;
  setPref: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void;
  /**
   * 切换账号命名空间（登录/登出时调用）。
   *
   * 跨账号隔离（FE-032）：`userId` 与元数据记录不一致时，
   * 说明换了账号 → **丢弃上一个账号的偏好与同步水位**（否则 B 会继承 A 的
   * `serverRevision`/`statsSyncSince`，误判"已同步"并可能写入 A 的偏好）。
   *
   * @returns 是否发生了账号切换（true 表示已重置为默认值）
   */
  adoptAccount: (userId: string | null) => boolean;
  /** 用服务端数据覆盖本地（pull 后调用） */
  applyFromServer: (data: Partial<AppPreferences> | undefined, revision: number) => void;
  /** 标记已上传 */
  markPushed: (revision: number) => void;
  setStatsSyncSince: (ts: number) => void;
  reset: () => void;
}

export const usePrefsStore = create<PrefsState>((set, get) => ({
  prefs: { ...DEFAULT_PREFS },
  meta: { ...DEFAULT_SYNC_META },
  dirty: false,
  loaded: false,

  hydrate: () => {
    set({
      prefs: readJson<AppPreferences>(PREFS_KEY, DEFAULT_PREFS),
      meta: readJson<SyncMeta>(META_KEY, DEFAULT_SYNC_META),
      loaded: true,
    });
  },

  setPref: (key, value) => {
    const prefs = { ...get().prefs, [key]: value };
    set({ prefs, dirty: true });
    writeJson(PREFS_KEY, prefs);
  },

  adoptAccount: (userId) => {
    const current = readJson<SyncMeta>(META_KEY, DEFAULT_SYNC_META);
    const nextUser = userId && userId.length > 0 ? userId : null;
    // 元数据缺 userId 的旧版本地数据：无法判断归属 → 一律按"换账号"处理（安全优先）
    if (current.userId === nextUser && current.userId !== null) {
      set({ meta: { ...current, userId: nextUser } });
      return false;
    }
    if (nextUser === null && current.userId === null) {
      // 未登录 → 未登录（保持匿名命名空间的数据）
      set({ meta: { ...current, userId: null } });
      return false;
    }
    const prefs = { ...DEFAULT_PREFS };
    const meta: SyncMeta = { ...DEFAULT_SYNC_META, userId: nextUser };
    set({ prefs, meta, dirty: false });
    writeJson(PREFS_KEY, prefs);
    writeJson(META_KEY, meta);
    return true;
  },

  applyFromServer: (data, revision) => {
    const prefs = { ...DEFAULT_PREFS, ...get().prefs, ...(data ?? {}) };
    const meta = { ...get().meta, serverRevision: revision, lastPullAt: Date.now() };
    set({ prefs, meta, dirty: false });
    writeJson(PREFS_KEY, prefs);
    writeJson(META_KEY, meta);
  },

  markPushed: (revision) => {
    const meta = { ...get().meta, serverRevision: revision, lastPushAt: Date.now() };
    set({ meta, dirty: false });
    writeJson(META_KEY, meta);
  },

  setStatsSyncSince: (ts) => {
    const meta = { ...get().meta, statsSyncSince: ts };
    set({ meta });
    writeJson(META_KEY, meta);
  },

  reset: () => {
    set({ prefs: { ...DEFAULT_PREFS }, meta: { ...DEFAULT_SYNC_META }, dirty: false });
    writeJson(PREFS_KEY, DEFAULT_PREFS);
    writeJson(META_KEY, DEFAULT_SYNC_META);
  },
}));
