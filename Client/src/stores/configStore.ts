/**
 * 配置面板 store —— 「后端真相 + 本地期望值」模型
 *
 * ## 三层取值（高 → 低）
 *   用户期望值 overrides(本地) > 后端当前生效值 loaded(running) > schema 默认 default
 *
 * ## 为什么不能只写 localStorage（REV-265）
 * 后端 `loadConfig()` 只在启动时读一次文件，之后所有消费方用内存快照。
 * 因此"生效"有且只有两种真实形态，都由**后端**告知，不由前端记账：
 *   - `running` —— 本进程正在使用的值（`GET /api/configs/effective` 的 `running`）
 *   - `onDisk`  —— 重新加载会读到的值（同一响应的 `onDisk`，含刚落盘的 `local.json`）
 *   - `restartPending` —— 二者不等的键 = "已保存，重启后生效"
 * 写入一律经 `PUT /api/configs/user` → `userConfigWriter` 白名单 + 启动校验器试跑，
 * 被拒绝（白名单外）/ 被拦（取值非法）都原样回传并在界面标注，不静默丢弃。
 *
 * ## 提交时机（hotReloadStore）
 * `immediate` / `onRestart` 立即提交到后端（后者由后端答"需重启"）；
 * `afterReply` / `onNavigate` 只是**推迟提交这个动作**的时机标签，到点由 flush 真正写后端。
 *
 * 云端同步：overrides 通过 syncService.pushAll 上行，pullAll 下行走 applyFromCloud。
 */
import { create } from "zustand";
import { apiGet, apiPut } from "@/services/api";
import {
  ALL_FIELDS,
  FIELDS_BY_SOURCE,
  CONFIG_GROUPS,
} from "@/config/configSchema";
import {
  getPath,
  setPath,
  type FieldDef,
  type ReloadStrategy,
} from "@/config/schemaTypes";
import type { FieldValue } from "@/components/Settings/fields";
import { useHotReloadStore, PENDING_UNSET } from "./hotReloadStore";
import { ipcGetConfig } from "@/services/ipcApi";

const LS_KEY = "civitas.config.overrides.v1";

/**
 * 重置哨兵值：显式要求后端**删除**该键的用户覆盖，回到配置文件值。
 * 与"删除本地 override"不同——那只会让界面回到默认而 `local.json` 仍留着旧值。
 */
const DEFAULT_MARK = "@@default@@";

/** 仅界面消费的段（后端也接受落盘，但生效主体是本机渲染层） */
const CLIENT_SCOPE_PREFIXES = ["ui."];

function isClientScopePath(path: string): boolean {
  return CLIENT_SCOPE_PREFIXES.some((p) => path.startsWith(p));
}

function loadOverrides(): Record<string, FieldValue> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, FieldValue>) : {};
  } catch {
    return {};
  }
}
function persistOverrides(o: Record<string, FieldValue>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(o));
  } catch {
    /* 隐私模式忽略 */
  }
}

const FIELD_MAP: Record<string, FieldDef> = Object.fromEntries(
  ALL_FIELDS.map((f) => [f.key, f]),
);

// ── 后端视图类型（与 Src/Interface/RestApi/configApi.ts 对齐）──────────

interface RestartPendingEntry {
  path: string;
  running: unknown;
  onDisk: unknown;
}

interface EffectiveSnapshot {
  env: string | null;
  runningLoaded: boolean;
  userConfigPath: string;
  policy: { allowedPrefixes: string[]; neverWritable: string[] };
  running: Record<string, unknown> | null;
  onDisk: Record<string, unknown> | null;
  onDiskError: string | null;
  restartPending: RestartPendingEntry[];
}

interface WriteResponse {
  path: string;
  applied: string[];
  removed: string[];
  rejected: string[];
  invalid: Array<{ path: string; reason: string }>;
  statuses: Array<{
    path: string;
    status: "live" | "restart-required" | "unknown";
  }>;
  restartPendingCount: number;
}

/** 单项「到底生没生效」的真实状态种类（全部由后端视图推导，前端不自造记账） */
export type FieldEffectKind =
  | "live"
  | "queued"
  | "saving"
  | "pending-restart"
  | "not-accepted"
  | "rejected"
  | "backend-offline";

export interface FieldEffect {
  kind: FieldEffectKind;
  reason?: string;
}

export interface FieldEffectInput {
  path: string;
  /** 是否存在本地期望值（含"要求后端删除覆盖"的 DEFAULT_MARK） */
  hasDesired: boolean;
  /** 本地期望值（DEFAULT_MARK = 要求后端删除覆盖） */
  desired: FieldValue | undefined;
  /** 后端进程当前生效值（running） */
  running: FieldValue | undefined;
  /** 后端配置文件值（onDisk） */
  disk: FieldValue | undefined;
  /** 后端答复：该路径 running 与 onDisk 不一致（需重启才读到新值） */
  pendingRestart: boolean;
  saving: boolean;
  error: string | undefined;
  policy: ConfigState["policy"];
  backendReachable: boolean;
}

/** 点路径是否命中后端白名单（与 `userConfigWriter.isAllowedConfigPath` 同口径，仅用于展示） */
export function isPathAccepted(
  policy: ConfigState["policy"],
  path: string,
): boolean {
  if (!policy) return true; // 后端不可达时不下"不接受"的结论，交给 backend-offline 表达
  if (policy.neverWritable.includes(path)) return false;
  return policy.allowedPrefixes.some((prefix) =>
    prefix.endsWith(".")
      ? path.startsWith(prefix) || path === prefix.slice(0, -1)
      : path === prefix,
  );
}

/**
 * 生效态推导（纯函数，界面与测试共用同一口径）。
 * 顺序即优先级：提交中 > 后端拒绝/不接受 > 后端不可达 > 界面段即时生效 > 期望值与后端比对。
 */
export function deriveFieldState(i: FieldEffectInput): FieldEffect {
  if (i.saving) return { kind: "saving" };
  if (i.error) {
    return {
      kind: isPathAccepted(i.policy, i.path) ? "rejected" : "not-accepted",
      reason: i.error,
    };
  }
  if (!i.backendReachable) {
    return i.hasDesired ? { kind: "backend-offline" } : { kind: "live" };
  }
  if (!isPathAccepted(i.policy, i.path)) return { kind: "not-accepted" };
  // 界面段（ui.*）由本机渲染层直接消费，写入即生效；落盘只是给其他设备/下次启动用
  if (isClientScopePath(i.path)) return { kind: "live" };
  if (!i.hasDesired)
    return i.pendingRestart ? { kind: "pending-restart" } : { kind: "live" };
  if (i.desired === DEFAULT_MARK)
    return i.pendingRestart ? { kind: "pending-restart" } : { kind: "live" };
  if (sameValue(i.running, i.desired)) return { kind: "live" };
  if (sameValue(i.disk, i.desired)) return { kind: "pending-restart" };
  return { kind: "queued" };
}

/** 把 store 状态折叠成 deriveFieldState 的输入（fieldState 与组件共用） */
export function effectInputFor(
  state: ConfigState,
  key: string,
): FieldEffectInput | null {
  const field = FIELD_MAP[key];
  if (!field) return null;
  return {
    path: field.path,
    hasDesired: key in state.overrides,
    desired: state.overrides[key],
    running: state.loaded[key],
    disk: state.disk[key],
    pendingRestart: state.restartPending.some((p) => p.path === field.path),
    saving: !!state.saving[key],
    error: state.writeErrors[key],
    policy: state.policy,
    backendReachable: state.backendReachable,
  };
}

export interface ConfigState {
  /** 后端**当前生效**值（running；后端不可达时降级为配置文件原文） */
  loaded: Record<string, FieldValue>;
  /** 后端配置文件里的值（onDisk；重启后会成为 running） */
  disk: Record<string, FieldValue>;
  /** 用户期望值（未提交/已提交待生效都在此；DEFAULT_MARK = 要求后端删除覆盖） */
  overrides: Record<string, FieldValue>;
  /** 后端可写白名单（来自 effective 响应；null = 后端不可达，无从判断） */
  policy: { allowedPrefixes: string[]; neverWritable: string[] } | null;
  restartPending: RestartPendingEntry[];
  /** 后端 `/api/configs/effective` 是否可达（不可达时改动只落在本地，界面上必须明说） */
  backendReachable: boolean;
  loading: boolean;
  loadedSources: Record<string, boolean>;
  loadedAt: number | null;
  /** 本地有未同步到云端的配置变更 */
  dirty: boolean;
  /** 正在提交后端的键 */
  saving: Record<string, true>;
  /** 上一次提交被后端拒绝的键与原因（值改动即清除） */
  writeErrors: Record<string, string>;

  hydrate: () => Promise<void>;
  /** 只刷新后端生效态视图（写入成功后调用，避免整面板 loading 闪烁） */
  refreshEffective: () => Promise<boolean>;
  effective: (key: string) => FieldValue;
  isModified: (key: string) => boolean;
  modifiedCount: (groupId?: string) => number;
  /** 单项生效态（界面文案唯一来源） */
  fieldState: (key: string) => FieldEffect;
  setValue: (key: string, v: FieldValue) => void;
  /** 丢弃本地期望值（撤销一项尚未提交的改动；不向后端发任何请求） */
  discardDesired: (key: string) => void;
  resetField: (key: string) => void;
  resetGroup: (groupId: string) => void;
  resetAll: () => void;
  exportMerged: () => Record<string, unknown>;
  /**
   * 把一项变更真正提交到后端（`PUT /api/configs/user`）。
   * `value === PENDING_UNSET` 表示请求后端删除该键的用户覆盖。
   * 由 hotReloadStore 到达生效时机时调用，也被 immediate/onRestart 直接调用。
   */
  persistField: (key: string, value: FieldValue) => Promise<void>;
  /** 批量提交（一次 PUT 带上全部待写入项，避免逐键往返） */
  persistFields: (
    entries: Array<{ key: string; value: FieldValue }>,
  ) => Promise<void>;
  applyFromCloud: (cloudOverrides: Record<string, FieldValue>) => void;
  getOverridesForSync: () => Record<string, FieldValue>;
  markSynced: () => void;
}

/** 把某 source 的加载值展开为 key→value */
function flattenSource(
  source: string,
  json: unknown,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of FIELDS_BY_SOURCE[source] ?? []) {
    const v = getPath(json, f.path);
    if (v !== undefined && v !== null) out[f.key] = v as FieldValue;
  }
  return out;
}

/** 从 effective 视图展开全量 key→value（running / onDisk 各一份） */
function flattenFields(
  tree: Record<string, unknown> | null,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  if (!tree) return out;
  for (const f of ALL_FIELDS) {
    const v = getPath(tree, f.path);
    if (v !== undefined && v !== null) out[f.key] = v as FieldValue;
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  loaded: {},
  disk: {},
  overrides: loadOverrides(),
  policy: null,
  restartPending: [],
  backendReachable: false,
  loading: false,
  loadedSources: {},
  loadedAt: null,
  dirty: false,
  saving: {},
  writeErrors: {},

  hydrate: async () => {
    set({ loading: true });
    const reached = await get().refreshEffective();
    if (reached) {
      set({ loading: false, loadedAt: Date.now() });
      return;
    }
    // 降级：后端不可达（或旧版后端没有 effective 接口）→ 沿用按文件读取，
    // 并在界面上明说"改动不会生效"。此时 loaded 是**内置配置文件原文**，不是运行态。
    const sources = Object.keys(FIELDS_BY_SOURCE);
    const merged: Record<string, FieldValue> = {};
    const flags: Record<string, boolean> = {};
    await Promise.all(
      sources.map(async (s) => {
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
      }),
    );
    set({
      loaded: merged,
      loadedSources: flags,
      loading: false,
      loadedAt: Date.now(),
      backendReachable: false,
    });
  },

  refreshEffective: async () => {
    const res = await apiGet<EffectiveSnapshot>("/api/configs/effective");
    if (!res.ok || !res.data || !res.data.policy) {
      set({ backendReachable: false });
      return false;
    }
    const snap = res.data;
    const running = flattenFields(snap.running);
    const disk = flattenFields(snap.onDisk);
    set({
      loaded: running,
      disk,
      policy: snap.policy,
      restartPending: snap.restartPending ?? [],
      backendReachable: true,
      loadedSources: Object.fromEntries(
        Object.keys(FIELDS_BY_SOURCE).map((s) => [s, true]),
      ),
      loadedAt: Date.now(),
    });
    // 收敛清理：后端已经用到期望值 → 不再是"覆盖"；重置项若后端已无待重启差异 → 清除
    const { overrides } = get();
    const pruned: Record<string, FieldValue> = {};
    let changed = false;
    for (const [key, value] of Object.entries(overrides)) {
      const field = FIELD_MAP[key];
      if (!field) {
        pruned[key] = value;
        continue;
      }
      if (value === DEFAULT_MARK) {
        if (!snap.restartPending?.some((p) => p.path === field.path)) {
          changed = true;
          continue;
        }
        pruned[key] = value;
      } else if (sameValue(running[key], value)) {
        changed = true; // 已生效，覆盖层不再需要
      } else {
        pruned[key] = value;
      }
    }
    if (changed) {
      persistOverrides(pruned);
      set({ overrides: pruned });
    }
    return true;
  },

  effective: (key) => {
    const { overrides, loaded } = get();
    if (key in overrides) {
      const ov = overrides[key];
      // 重置 = 后端删除覆盖 → 界面显示后端当前生效值；后端未答之前保持可见
      if (ov === DEFAULT_MARK)
        return key in loaded
          ? loaded[key]
          : (FIELD_MAP[key]?.default as FieldValue);
      return ov;
    }
    if (key in loaded) return loaded[key];
    return FIELD_MAP[key]?.default as FieldValue;
  },

  isModified: (key) => {
    const f = FIELD_MAP[key];
    if (!f) return false;
    return !sameValue(get().effective(key), f.default as FieldValue);
  },

  modifiedCount: (groupId) => {
    const keys = groupId
      ? CONFIG_GROUPS.find((g) => g.id === groupId)?.source
        ? ALL_FIELDS.filter(
            (f) =>
              f.source === CONFIG_GROUPS.find((g) => g.id === groupId)!.source,
          ).map((f) => f.key)
        : []
      : ALL_FIELDS.map((f) => f.key);
    return keys.filter((k) => get().isModified(k)).length;
  },

  fieldState: (key) => {
    const input = effectInputFor(get(), key);
    return input ? deriveFieldState(input) : { kind: "live" };
  },

  setValue: (key, v) => {
    const field = FIELD_MAP[key];
    const strategy: ReloadStrategy = field?.reloadStrategy ?? "afterReply";

    // 期望值立即写入本地（持久化 + UI 立即反映）
    set((state) => {
      const overrides = { ...state.overrides, [key]: v };
      persistOverrides(overrides);
      const writeErrors = { ...state.writeErrors };
      delete writeErrors[key]; // 改动即清除上一次的拒绝原因
      return { overrides, dirty: true, writeErrors };
    });

    // 提交给后端：immediate 立即；onRestart 立即落盘（由后端回答"需重启"）；
    // afterReply / onNavigate 进队列，到点由 hotReloadStore 真正提交
    if (strategy === "immediate" || strategy === "onRestart") {
      void get().persistField(key, v);
    } else {
      useHotReloadStore.getState().scheduleReload(key, v, strategy, "local");
    }
  },

  discardDesired: (key) => {
    set((state) => {
      if (!(key in state.overrides)) return {};
      const overrides = { ...state.overrides };
      delete overrides[key];
      persistOverrides(overrides);
      const writeErrors = { ...state.writeErrors };
      delete writeErrors[key];
      return { overrides, writeErrors };
    });
  },

  resetField: (key) => {
    const f = FIELD_MAP[key];
    if (!f) return;
    set((state) => {
      const overrides = {
        ...state.overrides,
        [key]: DEFAULT_MARK as unknown as FieldValue,
      };
      persistOverrides(overrides);
      const writeErrors = { ...state.writeErrors };
      delete writeErrors[key];
      // 重置同样是用户改动：必须置 dirty，否则界面显示「已同步」而后端还留着旧覆盖
      return { overrides, dirty: true, writeErrors };
    });

    const strategy: ReloadStrategy = f.reloadStrategy ?? "afterReply";
    if (strategy === "immediate" || strategy === "onRestart") {
      void get().persistField(key, PENDING_UNSET as unknown as FieldValue);
    } else {
      useHotReloadStore
        .getState()
        .scheduleReload(
          key,
          PENDING_UNSET as unknown as FieldValue,
          strategy,
          "local",
        );
    }
  },

  resetGroup: (groupId) => {
    const g = CONFIG_GROUPS.find((x) => x.id === groupId);
    if (!g) return;
    for (const f of ALL_FIELDS.filter((x) => x.source === g.source))
      get().resetField(f.key);
  },

  resetAll: () => {
    for (const f of ALL_FIELDS) get().resetField(f.key);
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

  persistField: async (key, value) => {
    await get().persistFields([{ key, value }]);
  },

  persistFields: async (entries) => {
    const patch: Record<string, unknown> = {};
    const unset: string[] = [];
    const pathToKeys = new Map<string, string[]>();
    const activeKeys: string[] = [];

    for (const { key, value } of entries) {
      const field = FIELD_MAP[key];
      if (!field) continue;
      if (value === (PENDING_UNSET as unknown as FieldValue))
        unset.push(field.path);
      else patch[field.path] = value;
      pathToKeys.set(field.path, [...(pathToKeys.get(field.path) ?? []), key]);
      activeKeys.push(key);
    }
    if (activeKeys.length === 0) return;

    set((state) => ({
      saving: {
        ...state.saving,
        ...Object.fromEntries(activeKeys.map((k) => [k, true as const])),
      },
    }));

    const res = await apiPut<WriteResponse>("/api/configs/user", {
      patch,
      unset,
    });

    set((state) => {
      const saving = { ...state.saving };
      for (const key of activeKeys) delete saving[key];
      return { saving };
    });

    const failAll = (reason: string) => {
      set((state) => ({
        writeErrors: {
          ...state.writeErrors,
          ...Object.fromEntries(activeKeys.map((k) => [k, reason])),
        },
      }));
    };

    if (!res.ok) {
      const e = res.error;
      failAll(`${e.message}${e.status ? `（HTTP ${e.status}）` : ""}`);
      return;
    }
    const data = res.data;

    // 后端逐项回执 → 归位到字段键（白名单外 / 取值非法都必须让用户看见）
    const refused = new Map<string, string>();
    for (const path of data.rejected) {
      for (const key of pathToKeys.get(path) ?? [])
        refused.set(
          key,
          "后端不接受该配置键（不在可写白名单内），改动不会生效",
        );
    }
    for (const item of data.invalid) {
      for (const key of pathToKeys.get(item.path) ?? [])
        refused.set(key, item.reason);
    }
    if (refused.size > 0) {
      set((state) => ({
        writeErrors: { ...state.writeErrors, ...Object.fromEntries(refused) },
      }));
    }
    // 整批被拒（校验不过 / 文件不可写）：error 里没有逐项信息，全部标失败
    if (
      refused.size === 0 &&
      data.applied.length === 0 &&
      data.removed.length === 0 &&
      activeKeys.length > 0
    ) {
      failAll("后端未落盘任何改动（配置校验或文件写入被拒）");
      return;
    }
    // 落盘成功 → 用后端视图刷新生效态（running/onDisk 由后端判定，不由前端猜）
    await get().refreshEffective();
  },

  applyFromCloud: (cloudOverrides) => {
    // 云端权威：覆盖本地 overrides
    set((state) => {
      const overrides = { ...state.overrides, ...cloudOverrides };
      persistOverrides(overrides);
      return { overrides, dirty: false }; // pull 后清除 dirty
    });

    // 按策略提交（云端变更安全起见按分级时机提交，immediate 也走队列避免打断当前会话）
    const hotReload = useHotReloadStore.getState();
    for (const [key, value] of Object.entries(cloudOverrides)) {
      const field = FIELD_MAP[key];
      const strategy: ReloadStrategy = field?.reloadStrategy ?? "afterReply";
      hotReload.scheduleReload(
        key,
        value,
        strategy === "immediate" ? "afterReply" : strategy,
        "cloud",
      );
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
