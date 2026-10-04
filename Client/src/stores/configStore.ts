/**
 * 配置面板 store —— 「默认值 vs 用户值」模型（对齐 VSCode 设置语义）
 *
 * 三层取值优先级（高 → 低）：
 *   user override (localStorage)  >  文件当前值 (GET /api/configs/:name)  >  schema 默认值
 *
 * - effective(key)  = overrides[key] ?? loaded[key] ?? field.default
 * - isModified(key) = effective(key) !== field.default
 * - reset(key)      = 删除 override 并把 effective 钉回 default
 * - export()        = 按 source 重建嵌套 JSON，供用户手动落盘
 *
 * 热重载：setValue 按字段 reloadStrategy 分级入队 hotReloadStore，
 *         到达触发时机时由 hotReloadStore 回调 applyEffective 使运行时真正生效。
 *
 * 云端同步：overrides 通过 syncService.pushAll 上行，pullAll 下行走 applyFromCloud。
 */
import { create } from 'zustand';
import { apiGet } from '@/services/api';
import { ALL_FIELDS, FIELDS_BY_SOURCE, CONFIG_GROUPS } from '@/config/configSchema';
import { getPath, setPath, type FieldDef, type ReloadStrategy } from '@/config/schemaTypes';
import type { FieldValue } from '@/components/Settings/fields';
import { useHotReloadStore } from './hotReloadStore';
import { ipcGetConfig } from '@/services/ipcApi';

const LS_KEY = 'civitas.config.overrides.v1';

/**
 * 重置哨兵值：把某字段显式钉回「出厂默认」（schema default）。
 * 与真实用户值区分——删除 override 会退回文件值，而 reset 语义要求回到默认值。
 */
const DEFAULT_MARK = '@@default@@';

function loadOverrides(): Record<string, FieldValue> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) as Record<string, FieldValue> : {};
  } catch { return {}; }
}
function persistOverrides(o: Record<string, FieldValue>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch { /* 隐私模式忽略 */ }
}

const FIELD_MAP: Record<string, FieldDef> = Object.fromEntries(ALL_FIELDS.map(f => [f.key, f]));

interface ConfigState {
  /** 从后端文件读到的当前值（key → value） */
  loaded: Record<string, FieldValue>;
  /** 用户覆盖值（localStorage 持久） */
  overrides: Record<string, FieldValue>;
  loading: boolean;
  loadedSources: Record<string, boolean>;
  loadedAt: number | null;
  /** 本地有未同步到云端的配置变更 */
  dirty: boolean;
  hydrate: () => Promise<void>;
  effective: (key: string) => FieldValue;
  isModified: (key: string) => boolean;
  modifiedCount: (groupId?: string) => number;
  setValue: (key: string, v: FieldValue) => void;
  resetField: (key: string) => void;
  resetGroup: (groupId: string) => void;
  resetAll: () => void;
  exportMerged: () => Record<string, unknown>;
  /** 运行时生效：由 hotReloadStore flush 时调用，使变更真正影响运行时 */
  applyEffective: (key: string, v: FieldValue) => void;
  /** 从云端拉取的配置覆盖本地（服务端权威） */
  applyFromCloud: (cloudOverrides: Record<string, FieldValue>) => void;
  /** 返回当前所有非 DEFAULT_MARK 的 overrides，供 pushAll 同步使用 */
  getOverridesForSync: () => Record<string, FieldValue>;
  /** 标记已同步到云端 */
  markSynced: () => void;
}

/** 把某 source 的加载值展开为 key→value */
function flattenSource(source: string, json: unknown): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of FIELDS_BY_SOURCE[source] ?? []) {
    const v = getPath(json, f.path);
    if (v !== undefined && v !== null) out[f.key] = v as FieldValue;
  }
  return out;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  loaded: {},
  overrides: loadOverrides(),
  loading: false,
  loadedSources: {},
  loadedAt: null,
  dirty: false,

  hydrate: async () => {
    set({ loading: true });
    const sources = Object.keys(FIELDS_BY_SOURCE);
    const merged: Record<string, FieldValue> = {};
    const flags: Record<string, boolean> = {};
    await Promise.all(sources.map(async s => {
      // 优先 IPC 直连，降级 HTTP
      let data: unknown = null;
      try {
        const ipcRes = await ipcGetConfig(`${s}.json`);
        if (ipcRes.ok && ipcRes.data !== undefined) {
          data = ipcRes.data;
        } else {
          const res = await apiGet<unknown>(`/api/configs/${s}.json`);
          if (res.ok) data = res.data;
        }
      } catch {
        const res = await apiGet<unknown>(`/api/configs/${s}.json`);
        if (res.ok) data = res.data;
      }
      if (data !== null) {
        Object.assign(merged, flattenSource(s, data));
        flags[s] = true;
      } else {
        flags[s] = false;
      }
    }));
    set({ loaded: merged, loadedSources: flags, loading: false, loadedAt: Date.now() });
  },

  effective: (key) => {
    const { overrides, loaded } = get();
    if (key in overrides) {
      const ov = overrides[key];
      if (ov === DEFAULT_MARK) return FIELD_MAP[key]?.default as FieldValue;
      return ov;
    }
    if (key in loaded) return loaded[key];
    return FIELD_MAP[key]?.default as FieldValue;
  },

  isModified: (key) => {
    const f = FIELD_MAP[key];
    if (!f) return false;
    const eq = (a: FieldValue, b: FieldValue) =>
      Array.isArray(a) || Array.isArray(b)
        ? JSON.stringify(a) === JSON.stringify(b)
        : a === b;
    return !eq(get().effective(key), f.default as FieldValue);
  },

  modifiedCount: (groupId) => {
    const keys = groupId
      ? (CONFIG_GROUPS.find(g => g.id === groupId)?.source
        ? ALL_FIELDS.filter(f => f.source === CONFIG_GROUPS.find(g => g.id === groupId)!.source).map(f => f.key)
        : [])
      : ALL_FIELDS.map(f => f.key);
    return keys.filter(k => get().isModified(k)).length;
  },

  setValue: (key, v) => {
    const field = FIELD_MAP[key];
    const strategy: ReloadStrategy = field?.reloadStrategy ?? 'afterReply';

    // 所有级别都立即写入 overrides（持久化 + UI 立即反映）
    set(state => {
      const overrides = { ...state.overrides, [key]: v };
      persistOverrides(overrides);
      return { overrides, dirty: true };
    });

    // 按策略入队热重载（immediate 不入队，已直接生效）
    if (strategy !== 'immediate') {
      useHotReloadStore.getState().scheduleReload(key, v, strategy, 'local');
    }
  },

  resetField: (key) => {
    const f = FIELD_MAP[key];
    if (!f) return;
    set(state => {
      const overrides = { ...state.overrides, [key]: DEFAULT_MARK as unknown as FieldValue };
      persistOverrides(overrides);
      return { overrides };
    });
  },

  resetGroup: (groupId) => {
    const g = CONFIG_GROUPS.find(x => x.id === groupId);
    if (!g) return;
    set(state => {
      const overrides = { ...state.overrides };
      for (const f of ALL_FIELDS.filter(x => x.source === g.source)) {
        overrides[f.key] = DEFAULT_MARK as unknown as FieldValue;
      }
      persistOverrides(overrides);
      return { overrides };
    });
  },

  resetAll: () => {
    set(() => {
      const overrides: Record<string, FieldValue> = {};
      for (const f of ALL_FIELDS) overrides[f.key] = DEFAULT_MARK as unknown as FieldValue;
      persistOverrides(overrides);
      return { overrides };
    });
  },

  exportMerged: () => {
    const out: Record<string, unknown> = {};
    for (const [source, fields] of Object.entries(FIELDS_BY_SOURCE)) {
      let json: Record<string, unknown> = {};
      for (const f of fields) {
        json = setPath(json, f.path, get().effective(f.key));
      }
      out[`${source}.json`] = json;
    }
    return out;
  },

  applyEffective: (key, v) => {
    // flush 时调用：使变更真正影响运行时
    // 目前 effective() 已返回最新值（overrides 已写入），
    // 此方法保留为扩展点（未来可通知后端刷新参数等）
    // 当前实现：确保 overrides 中有该值
    set(state => {
      if (state.overrides[key] === v) return {};
      const overrides = { ...state.overrides, [key]: v };
      persistOverrides(overrides);
      return { overrides };
    });
  },

  applyFromCloud: (cloudOverrides) => {
    // 云端权威：覆盖本地 overrides
    // 按各字段的 reloadStrategy 走热重载管线
    set(state => {
      const overrides = { ...state.overrides, ...cloudOverrides };
      persistOverrides(overrides);
      return { overrides, dirty: false }; // pull 后清除 dirty
    });

    // 按策略入队（不走 immediate，云端变更安全起见分级生效）
    const hotReload = useHotReloadStore.getState();
    for (const [key, value] of Object.entries(cloudOverrides)) {
      const field = FIELD_MAP[key];
      const strategy: ReloadStrategy = field?.reloadStrategy ?? 'afterReply';
      if (strategy !== 'immediate') {
        hotReload.scheduleReload(key, value, strategy, 'cloud');
      }
    }
  },

  getOverridesForSync: () => {
    const { overrides } = get();
    const result: Record<string, FieldValue> = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== DEFAULT_MARK) {
        result[key] = value;
      }
    }
    return result;
  },

  markSynced: () => {
    set({ dirty: false });
  },
}));

export { FIELD_MAP, DEFAULT_MARK };
