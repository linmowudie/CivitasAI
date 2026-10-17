/**
 * @module stores/modelStore
 * @description
 * 模型供应商与路由配置状态管理。
 * 通过 IPC 直连后端 Infra/Llm 模块，零 HTTP 开销。
 *
 * 职责：
 * - 管理供应商列表（添加/移除/拉取模型）
 * - 管理路由配置（defaultModel 等）
 * - 管理用户选中的模型和工作方式（同步到 prefsStore）
 */

import { create } from "zustand";
import { usePrefsStore } from "./prefsStore";
import type { WorkingMode } from "./chatStore";
import {
  ipcGetProviders,
  ipcAddProvider,
  ipcRemoveProvider,
  ipcFetchProviderModels,
  ipcGetRouting,
  ipcUpdateRouting,
  ipcGetModels,
  ipcSaveProviderSecrets,
  ipcLoadProviderSecrets,
  type ProviderSecretData,
  type RoutingUpdateResult,
} from "@/services/ipcApi";

// ── 类型 ────────────────────────────────────────────────────────────

export interface ProviderInfo {
  name: string;
  displayName: string;
  models: ModelSpec[];
}

export interface ModelSpec {
  id: string;
  context_window: number;
  max_output: number;
  supports_vision: boolean;
  supports_tools: boolean;
  cost_per_1k_input: number;
  cost_per_1k_output: number;
}

export interface RoutingConfig {
  defaultModel: string;
  directorModel: string;
  workerModel: string;
  verifierModel: string;
  arbitrationModels: string[];
  fallbackOrder: string[];
  timeoutMs: number;
  firstByteTimeoutMs: number;
  interChunkTimeoutMs: number;
}

// ── 预置供应商 ─────────────────────────────────────────────────────

/**
 * 已知模型名（可选）。
 *
 * 用途：部分端点的 base_url **不提供** `GET /models`，拉不到列表就无法继续
 * 「测试连接 / 导入模型」。实测（2026-10-17）华为云 MaaS Token Plan 的
 * `https://api.modelarts-maas.com/plan/v2` 正是如此（404 `APIG.0101`），
 * 而同端点 `POST /chat/completions` 正常。此处登记的是**候选**，不是账号可见列表，
 * 界面会标注来源并要求逐个"校验可用性"后再勾选导入。
 */
export const PRESET_PROVIDERS: Array<{
  id: string;
  name: string;
  base_url: string;
  models?: string[];
}> = [
  { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1" },
  {
    id: "huawei-maas",
    name: "华为云 MaaS",
    base_url: "https://api.modelarts-maas.com/plan/v2",
    // 与 Configs/modelRouter.json 的三个 Token Plan 模型对齐（实测均可用）
    models: ["GLM-5.1", "DeepSeek-V4-Flash", "Kimi-K2.6"],
  },
  {
    id: "dashscope",
    name: "阿里通义",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "qianfan",
    name: "百度文心",
    base_url: "https://qianfan.baidubce.com/v2",
  },
  {
    id: "zhipu",
    name: "智谱 AI",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
  },
  { id: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com/v1" },
  { id: "moonshot", name: "月之暗面", base_url: "https://api.moonshot.cn/v1" },
  { id: "minimax", name: "MiniMax", base_url: "https://api.minimax.chat/v1" },
  {
    id: "lingyi",
    name: "零一万物",
    base_url: "https://api.lingyiwanwu.com/v1",
  },
];

/**
 * 取某个供应商的**内置候选模型名**（无登记则空数组）。
 *
 * 端点不提供 `/models` 时用它兜底：既能让"测试连接"有模型可探测，
 * 也能让用户在界面上直接看到可勾选的候选（仍须逐个校验可用性）。
 */
export function presetKnownModels(
  providerId: string | undefined | null,
): string[] {
  if (!providerId) return [];
  return PRESET_PROVIDERS.find((p) => p.id === providerId)?.models ?? [];
}

// ── Store ──────────────────────────────────────────────────────────

interface ModelState {
  providers: ProviderInfo[];
  routingConfig: RoutingConfig | null;
  availableModels: string[];
  loading: boolean;
  error: string | null;

  // 数据加载
  fetchProviders: () => Promise<void>;
  fetchRouting: () => Promise<void>;
  fetchModels: () => Promise<void>;
  /** 从加密存储恢复供应商（初始化时调用） */
  restoreFromSecrets: () => Promise<void>;

  // 供应商管理
  addProvider: (config: {
    provider: string;
    base_url: string;
    api_key: string;
    display_name: string;
    models?: ModelSpec[];
  }) => Promise<{ ok: boolean; error?: string }>;
  removeProvider: (name: string) => Promise<{ ok: boolean; error?: string }>;
  fetchProviderModels: (
    base_url: string,
    api_key: string,
    fallbackModels?: string[],
  ) => Promise<{
    ok: boolean;
    data?: ModelSpec[];
    error?: string;
    /** 端点确实不提供 /models（404/405） */
    listNotProvided?: boolean;
    listStatus?: number;
    /** data 来自 fallbackModels 而非端点列表 */
    modelsFromFallback?: boolean;
  }>;

  // 路由配置
  updateRouting: (
    config: Partial<RoutingConfig>,
  ) => Promise<RoutingUpdateResult>;

  // 用户选择（同步到 prefsStore）
  setSelectedModel: (model: string) => void;
  setSelectedWorkingMode: (mode: WorkingMode) => void;
}

export const useModelStore = create<ModelState>((set, get) => ({
  providers: [],
  routingConfig: null,
  availableModels: [],
  loading: false,
  error: null,

  fetchProviders: async () => {
    set({ loading: true, error: null });
    try {
      const providers = await ipcGetProviders();
      set({ providers, loading: false });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "获取供应商失败",
        loading: false,
      });
    }
  },

  fetchRouting: async () => {
    try {
      const routingConfig = await ipcGetRouting();
      set({ routingConfig });
    } catch {
      // 静默失败
    }
  },

  fetchModels: async () => {
    try {
      const models = await ipcGetModels();
      set({ availableModels: models });
    } catch {
      // 静默失败
    }
  },

  restoreFromSecrets: async () => {
    try {
      const result = await ipcLoadProviderSecrets();
      if (!result.ok || !result.data?.providers) return;

      // 逐个恢复供应商（注册到内存 + 重建状态）
      for (const secret of result.data.providers) {
        await ipcAddProvider({
          provider: secret.provider,
          base_url: secret.baseUrl,
          api_key: secret.apiKey,
          display_name: secret.displayName,
          models: secret.models,
        });
      }
      // 刷新供应商列表
      await get().fetchProviders();
      await get().fetchModels();
    } catch {
      // 静默失败（可能尚未保存过密钥）
    }
  },

  addProvider: async (config) => {
    set({ loading: true, error: null });
    const result = await ipcAddProvider(config);
    if (result.ok) {
      // 密钥持久化由**后端**在 ipc-add-provider 内完成（只 upsert 这一个供应商）。
      //
      // 这里原先会整包写回 secrets：
      //   providers: [...已有供应商(apiKey:'', baseUrl:''), 新供应商]
      // → 再加第二个模型就把第一个供应商的密钥/地址**写成空串**；重启后 restoreFromSecrets
      //   用空 key 重新注册，表现为"API_KEY 被刷掉"。整包覆盖本身也有并发丢写风险，故移除。
      await get().fetchProviders();
      await get().fetchModels();
    } else {
      set({ error: result.error });
    }
    set({ loading: false });
    return result;
  },

  removeProvider: async (name) => {
    set({ loading: true, error: null });
    const result = await ipcRemoveProvider(name);
    if (result.ok) {
      await get().fetchProviders();
      await get().fetchModels();
    } else {
      set({ error: result.error });
    }
    set({ loading: false });
    return result;
  },

  fetchProviderModels: async (base_url, api_key, fallbackModels) => {
    const result = await ipcFetchProviderModels({
      base_url,
      api_key,
      fallbackModels,
    });
    return result;
  },

  updateRouting: async (config) => {
    set({ loading: true, error: null });
    const result = await ipcUpdateRouting(config);
    if (result.ok && result.data) {
      set({ routingConfig: result.data, loading: false });
    } else {
      set({ error: result.error, loading: false });
    }
    return result;
  },

  setSelectedModel: (model) => {
    usePrefsStore.getState().setPref("selectedModel", model);
  },

  setSelectedWorkingMode: (mode) => {
    usePrefsStore.getState().setPref("selectedWorkingMode", mode);
  },
}));
