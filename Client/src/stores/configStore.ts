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
 * 不写后端：避免直接改受保护的 Configs/*.json（security L0 / 启动 fail-closed 校验）。
 */
import { create } from 'zustand';
import { apiGet } from '@/services/api';
import { ALL_FIELDS, FIELDS_BY_SOURCE, CONFIG_GROUPS } from '@/config/configSchema';
import { getPath, setPath, type FieldDef } from '@/config/schemaTypes';
import type { FieldValue } from '@/components/Settings/fields';

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
  hydrate: () => Promise<void>;
  effective: (key: string) => FieldValue;
  isModified: (key: string) => boolean;
  modifiedCount: (groupId?: string) => number;
  setValue: (key: string, v: FieldValue) => void;
  resetField: (key: string) => void;
  resetGroup: (groupId: string) => void;
  resetAll: () => void;
  exportMerged: () => Record<string, unknown>;
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

  hydrate: async () => {
    set({ loading: true });
    const sources = Object.keys(FIELDS_BY_SOURCE);
    const merged: Record<string, FieldValue> = {};
    const flags: Record<string, boolean> = {};
    await Promise.all(sources.map(async s => {
      const res = await apiGet<unknown>(`/api/configs/${s}.json`);
      if (res.ok) {
        Object.assign(merged, flattenSource(s, res.data));
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
    set(state => {
      const overrides = { ...state.overrides, [key]: v };
      persistOverrides(overrides);
      return { overrides };
    });
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
}));

export { FIELD_MAP, DEFAULT_MARK };
