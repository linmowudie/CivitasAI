/**
 * @module stores/onboardingStore
 * @description
 * 首次运行引导状态机（渲染进程）。
 *
 * 分工：
 * - **落盘**在主进程（`onboardingIpc`）：用户配置写 `<数据根>/Configs/local.json`，
 *   引导标记写 `<数据根>/.state/onboarding.json`；
 * - 本 store 只负责"当前在哪一步、填了什么、探测结果、能否继续"，不做持久化。
 *
 * 非 Electron 环境（浏览器开发模式 / 单测）：`hasOnboardingApi()` 为 false →
 * `needed=false`，**不拦截应用**（保持既有行为）。
 */

import { create } from 'zustand';

import {
  hasOnboardingApi,
  ipcAddProvider,
  ipcCompleteOnboarding,
  ipcGetModels,
  ipcGetOnboarding,
  ipcOpenPath,
  ipcPatchOnboarding,
  ipcSkipOnboarding,
  ipcResetOnboarding,
  ipcTestProvider,
  ipcVerifyModels,
  type AppPathsDto,
  type DiscoveredModelDto,
  type ModelVerificationDto,
  type OnboardingSnapshotDto,
  type ProbeResultDto,
} from '@/services/ipcApi';

/**
 * 可用性校验的"运行令牌"：每次开始校验自增，循环在批次边界比对；
 * 取消或重新开始都会让上一次循环立刻退出（比 AbortController 更简单可靠）。
 */
let verifyRunToken = 0;

// ── 步骤定义 ────────────────────────────────────────────────────────

export const ONBOARDING_STEPS = [
  { id: 'welcome', title: '欢迎', subtitle: '认识 Civitas AI，看看数据存在哪' },
  { id: 'personalize', title: '个性化', subtitle: '日志级别、工作空间位置' },
  { id: 'provider', title: '选择供应商', subtitle: '从哪里调用大模型' },
  { id: 'credentials', title: '密钥与连通性', subtitle: '填写 API Key 并实测连接' },
  { id: 'routing', title: '默认模型', subtitle: '规划/执行/校验分别用哪个模型' },
  { id: 'guide', title: '使用引导', subtitle: '工作模式、工作目录与安全门' },
  { id: 'done', title: '完成', subtitle: '汇总并开始使用' },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]['id'];

export interface PersonalizationDraft {
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  workspaceRoot: string;
}

export interface ProviderDraft {
  providerId: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
}

export interface RoutingDraft {
  defaultModel: string;
  directorModel: string;
  workerModel: string;
  verifierModel: string;
  arbitrationModels: string[];
}

// ── 状态与动作 ──────────────────────────────────────────────────────

interface OnboardingStoreState {
  /** 引导通道是否可用（浏览器/测试环境为 false） */
  available: boolean;
  /** 是否已探测过（App 门控等待它） */
  checked: boolean;
  /** 是否需要进入引导 */
  needed: boolean;
  snapshot: OnboardingSnapshotDto | null;
  paths: AppPathsDto | null;
  loading: boolean;
  error: string | null;

  step: number;
  personalization: PersonalizationDraft;
  draft: ProviderDraft;
  probe: ProbeResultDto | null;
  probing: boolean;
  /** 用户勾选要导入的模型（**不自动全选**；导入只写这里面的） */
  selectedModels: DiscoveredModelDto[];
  /** 手动指定用于"测试连接"的模型（空 = 自动挑对话可用模型） */
  probeModel: string;
  /** 逐模型可用性校验结果（模型 id → 结论） */
  availability: Record<string, ModelVerificationDto>;
  /** 可用性校验进度 */
  verifying: boolean;
  verifyProgress: { checked: number; total: number };
  /** 可用性校验是否已跑过（用于 UI 提示） */
  verifiedAt: number | null;
  routing: RoutingDraft;
  registering: boolean;
  /// 注册结果 / 最近一次操作提示
  notice: { kind: 'ok' | 'warn' | 'error'; text: string } | null;
  finishing: boolean;

  check: () => Promise<void>;
  setStep: (n: number) => void;
  next: () => void;
  prev: () => void;
  setPersonalization: (patch: Partial<PersonalizationDraft>) => void;
  setDraft: (patch: Partial<ProviderDraft>) => void;
  /** 手动指定"测试连接"使用的模型（空 = 自动挑对话可用模型） */
  setProbeModel: (model: string) => void;
  /** 逐模型校验可用性（小批次并发，可中途取消） */
  verifyAvailability: () => Promise<void>;
  /** 取消可用性校验 */
  cancelVerify: () => void;
  /** 仅勾选"校验为可用"的模型 */
  selectOnlyAvailable: () => void;
  /** 清空勾选 */
  clearSelection: () => void;
  selectPreset: (preset: { id: string; name: string; base_url: string }) => void;
  probeConnection: () => Promise<boolean>;
  toggleModel: (model: DiscoveredModelDto) => void;
  registerProvider: () => Promise<boolean>;
  setRouting: (patch: Partial<RoutingDraft>) => void;
  toggleArbitrationModel: (qualified: string) => void;
  complete: () => Promise<boolean>;
  skip: () => Promise<void>;
  reset: () => Promise<void>;
  openPath: (target: string) => Promise<void>;
  setNotice: (notice: OnboardingStoreState['notice']) => void;
}

const EMPTY_ROUTING: RoutingDraft = {
  defaultModel: '',
  directorModel: '',
  workerModel: '',
  verifierModel: '',
  arbitrationModels: [],
};

function qualifiedModels(snapshot: OnboardingSnapshotDto | null): string[] {
  if (!snapshot) return [];
  return snapshot.models ?? [];
}

/** 从已注册模型里挑一套合理默认（第一个做默认/执行，第二个做规划/校验，兜底复用第一个） */
function deriveRouting(models: string[]): RoutingDraft {
  if (models.length === 0) return { ...EMPTY_ROUTING };
  const first = models[0]!;
  const second = models[1] ?? first;
  return {
    defaultModel: first,
    directorModel: second,
    workerModel: first,
    verifierModel: second,
    arbitrationModels: models.slice(0, Math.max(3, Math.min(3, models.length))),
  };
}

export const useOnboardingStore = create<OnboardingStoreState>((set, get) => ({
  available: false,
  checked: false,
  needed: false,
  snapshot: null,
  paths: null,
  loading: false,
  error: null,

  step: 0,
  personalization: { logLevel: 'info', workspaceRoot: '' },
  draft: { providerId: '', displayName: '', baseUrl: '', apiKey: '' },
  probe: null,
  probing: false,
  selectedModels: [],
  probeModel: '',
  availability: {},
  verifying: false,
  verifyProgress: { checked: 0, total: 0 },
  verifiedAt: null,
  routing: { ...EMPTY_ROUTING },
  registering: false,
  notice: null,
  finishing: false,

  /** 探测引导状态（App 启动时调用；API 不可用则视为不需要引导） */
  check: async () => {
    if (!hasOnboardingApi()) {
      set({ available: false, checked: true, needed: false });
      return;
    }
    set({ loading: true, error: null, available: true });
    const res = await ipcGetOnboarding();
    if (!res.ok || !res.data) {
      // 探测失败：不拦截应用（宁可少一次引导，也不要打不开）
      set({ loading: false, checked: true, needed: false, error: res.error ?? null });
      return;
    }
    const snapshot = res.data;
    const models = qualifiedModels(snapshot);
    set({
      loading: false,
      checked: true,
      needed: snapshot.needsOnboarding,
      snapshot,
      paths: snapshot.paths,
      routing: models.length > 0 ? deriveRouting(models) : { ...EMPTY_ROUTING },
    });
  },

  setStep: (n) => set({ step: Math.max(0, Math.min(ONBOARDING_STEPS.length - 1, n)) }),
  next: () => set((s) => ({ step: Math.min(ONBOARDING_STEPS.length - 1, s.step + 1) })),
  prev: () => set((s) => ({ step: Math.max(0, s.step - 1) })),

  setPersonalization: (patch) => set((s) => ({ personalization: { ...s.personalization, ...patch } })),
  setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
  setProbeModel: (model) => set({ probeModel: model }),

  /**
   * 逐模型校验可用性（模型导入重设计核心）。
   *
   * 流程：把列表切成**小批次**（每批 8 个）逐个调用后端 `verifyModels`，每批回来就更新
   * 进度与状态（可中途取消）。只校验、不导入；是否导入由用户勾选决定。
   */
  verifyAvailability: async () => {
    const { draft, probe, availability } = get();
    const all = probe?.models.map((m) => m.id) ?? [];
    if (!draft.baseUrl.trim() || !draft.apiKey.trim() || all.length === 0) {
      set({ notice: { kind: 'warn', text: '请先"测试连接"拿到模型列表，再校验可用性' } });
      return;
    }

    const BATCH = 8;
    let cancelled = false;
    verifyRunToken += 1;
    const myToken = verifyRunToken;
    const isStale = (): boolean => cancelled || myToken !== verifyRunToken;

    set({
      verifying: true,
      verifyProgress: { checked: 0, total: all.length },
      availability: { ...availability },
      notice: null,
    });

    let checked = 0;
    for (let i = 0; i < all.length; i += BATCH) {
      if (isStale()) return;
      const batch = all.slice(i, i + BATCH);
      const res = await ipcVerifyModels({
        base_url: draft.baseUrl.trim(),
        api_key: draft.apiKey.trim(),
        models: batch,
      });
      if (isStale()) return;

      if (!res.ok || !res.data) {
        set({ verifying: false, notice: { kind: 'error', text: res.error ?? '可用性校验失败' } });
        return;
      }
      const next = { ...get().availability };
      for (const item of res.data.results) next[item.id] = item;
      checked += res.data.results.length;
      set({ availability: next, verifyProgress: { checked, total: all.length } });
    }

    const finalMap = get().availability;
    const available = all.filter((id) => finalMap[id]?.status === 'available');
    const unknown = all.filter((id) => finalMap[id]?.status === 'unknown');
    const unavailable = all.filter((id) => finalMap[id]?.status === 'unavailable');

    set({
      verifying: false,
      verifiedAt: Date.now(),
      notice: {
        kind: available.length > 0 ? 'ok' : 'warn',
        text: `可用性校验完成：可用 ${available.length} / 不可用 ${unavailable.length} / 未知 ${unknown.length}`
          + (unknown.length > 0 ? '（未知多为限流或超时，可点"仅选可用"后重试）' : '')
          + '；请勾选要导入的模型。',
      },
    });
  },

  cancelVerify: () => {
    verifyRunToken += 1;   // 让进行中的循环在下一次批次边界退出
    set({ verifying: false });
  },

  selectOnlyAvailable: () => set((s) => ({
    selectedModels: (s.probe?.models ?? []).filter((m) => s.availability[m.id]?.status === 'available'),
  })),

  clearSelection: () => set({ selectedModels: [] }),

  selectPreset: (preset) => set({
    draft: {
      providerId: preset.id,
      displayName: preset.name,
      baseUrl: preset.base_url,
      apiKey: get().draft.apiKey,
    },
    probe: null,
    selectedModels: [],
    probeModel: '',
    availability: {},
    verifiedAt: null,
  }),
  setNotice: (notice) => set({ notice }),

  /** 连通性校验（/models + 最小对话），成功即回填模型清单 */
  probeConnection: async () => {
    const { draft } = get();
    if (!draft.baseUrl.trim() || !draft.apiKey.trim()) {
      set({
        probe: null,
        notice: { kind: 'warn', text: '请先填写 Base URL 与 API Key' },
      });
      return false;
    }
    set({ probing: true, notice: null });
    const res = await ipcTestProvider({
      base_url: draft.baseUrl.trim(),
      api_key: draft.apiKey.trim(),
      // 指定了就用指定的；留空则后端自动挑"对话可用"的模型（排除 embedding/tts/asr…）并逐个重试
      ...(get().probeModel ? { model: get().probeModel } : {}),
    });
    if (!res.ok || !res.data) {
      set({ probing: false, notice: { kind: 'error', text: res.error ?? '探测失败' } });
      return false;
    }
    const probe = res.data;
    set({
      probing: false,
      probe,
      // 模型导入重设计（2026-10-07）：**不再自动勾选**任何模型。
      // 列表只代表"账号可见"，不等于"可用"；导入哪些由用户在校验后自行勾选。
      selectedModels: [],
      availability: {},
      verifiedAt: null,
      notice: probe.ok
        ? {
            kind: 'ok',
            text: `连接成功：发现 ${probe.models.length} 个模型`
              + (probe.chatModelUsed ? `（连通性用 ${probe.chatModelUsed}）` : '')
              + '。下一步请点"校验可用性"逐个确认，再勾选要导入的模型。',
          }
        : { kind: 'error', text: `${probe.error ?? '连接失败'}${probe.hint ? `（${probe.hint}）` : ''}` },
    });
    return probe.ok;
  },

  toggleModel: (model) => set((s) => {
    const exists = s.selectedModels.some((m) => m.id === model.id);
    return {
      selectedModels: exists
        ? s.selectedModels.filter((m) => m.id !== model.id)
        : [...s.selectedModels, model],
    };
  }),

  /** 注册供应商（加密落盘 + 内存注册），随后回填路由候选 */
  registerProvider: async () => {
    const { draft, selectedModels, snapshot } = get();
    if (!draft.baseUrl.trim() || !draft.apiKey.trim()) {
      set({ notice: { kind: 'warn', text: '请先填写 Base URL 与 API Key' } });
      return false;
    }
    // 模型清单 = **用户勾选的**（模型导入重设计：绝不自动全量导入，也不再回退到"探测建议"）
    const models = selectedModels.map((m) => ({
      id: m.id,
      context_window: m.context_window > 0 ? m.context_window : 128000,
      max_output: m.max_output > 0 ? m.max_output : 8192,
      supports_vision: m.supports_vision,
      supports_tools: m.supports_tools,
      cost_per_1k_input: m.cost_per_1k_input,
      cost_per_1k_output: m.cost_per_1k_output,
    }));

    if (models.length === 0) {
      set({
        notice: {
          kind: 'warn',
          text: '请先在下方列表里**勾选要导入的模型**（可先"校验可用性"再点"仅选可用"）。',
        },
      });
      return false;
    }

    set({ registering: true, notice: null });
    const res = await ipcAddProvider({
      provider: draft.providerId || draft.displayName || 'custom',
      base_url: draft.baseUrl.trim(),
      api_key: draft.apiKey.trim(),
      display_name: draft.displayName || draft.providerId || '自定义供应商',
      models,
    });
    if (!res.ok) {
      set({ registering: false, notice: { kind: 'error', text: res.error ?? '供应商注册失败' } });
      return false;
    }

    // 回填路由候选（全限定名 provider/model）
    let registered: string[] = [];
    try {
      registered = await ipcGetModels();
    } catch {
      registered = [];
    }
    const nextRouting = deriveRouting(
      Array.isArray(registered) && registered.length > 0 ? registered : (snapshot?.models ?? []),
    );
    set({
      registering: false,
      routing: nextRouting,
      notice: { kind: 'ok', text: `已注册供应商并加密保存 API Key（模型 ${models.length} 个）` },
    });
    return true;
  },

  setRouting: (patch) => set((s) => ({ routing: { ...s.routing, ...patch } })),

  toggleArbitrationModel: (qualified) => set((s) => {
    const exists = s.routing.arbitrationModels.includes(qualified);
    return {
      routing: {
        ...s.routing,
        arbitrationModels: exists
          ? s.routing.arbitrationModels.filter((m) => m !== qualified)
          : [...s.routing.arbitrationModels, qualified],
      },
    };
  }),

  /** 完成引导：写用户配置（路由 + 个性化）并落状态标记 */
  complete: async () => {
    const { personalization, routing, draft, selectedModels, snapshot } = get();
    set({ finishing: true, notice: null });

    const configPatch: Record<string, unknown> = {
      'system.logLevel': personalization.logLevel,
      'routing.defaultModel': routing.defaultModel,
      'routing.directorModel': routing.directorModel,
      'routing.workerModel': routing.workerModel,
      'routing.verifierModel': routing.verifierModel,
      'routing.arbitrationModels': routing.arbitrationModels,
      'routing.fallbackOrder': Array.from(new Set([
        routing.defaultModel.split('/')[0] ?? '',
        ...(snapshot?.providers ?? []).map((p) => p.name),
      ].filter(Boolean))),
    };
    if (personalization.workspaceRoot.trim()) {
      configPatch['workspace.root'] = personalization.workspaceRoot.trim();
    }

    // 供应商名：注册后从快照里取最新的（registerProvider 已落盘）
    const providerName = draft.providerId || draft.displayName;
    const res = await ipcCompleteOnboarding({
      personalization: {
        logLevel: personalization.logLevel,
        workspaceRoot: personalization.workspaceRoot.trim() || undefined,
        theme: 'dark',
        language: 'zh-CN',
      },
      provider: providerName
        ? {
            name: providerName,
            displayName: draft.displayName || providerName,
            baseUrl: draft.baseUrl,
            defaultModel: routing.defaultModel,
          }
        : undefined,
      configPatch,
    });

    if (!res.ok) {
      set({ finishing: false, notice: { kind: 'error', text: res.error ?? '引导完成失败' } });
      return false;
    }
    const rejected = res.data?.config.rejected ?? [];
    set({
      finishing: false,
      needed: false,
      notice: rejected.length > 0
        ? { kind: 'warn', text: `已保存；以下键被白名单拒绝：${rejected.join('、')}` }
        : { kind: 'ok', text: '引导完成，配置已保存（无需重启即刻生效）' },
    });
    return true;
  },

  skip: async () => {
    await ipcPatchOnboarding({ skipped: true, completed: false, version: get().snapshot?.version ?? '1' });
    await ipcSkipOnboarding();
    set({ needed: false, notice: { kind: 'warn', text: '已跳过引导：未配置模型时无法对话，可随时从设置重新运行引导' } });
  },

  reset: async () => {
    await ipcResetOnboarding();
    await get().check();
  },

  openPath: async (target) => {
    const res = await ipcOpenPath(target);
    if (!res.ok) set({ notice: { kind: 'error', text: res.error ?? '打开目录失败' } });
  },
}));

/** 当前步骤能否继续（供 UI 禁用"下一步"） */
export function canProceed(stepId: OnboardingStepId, s: OnboardingStoreState): boolean {
  switch (stepId) {
    case 'credentials':
      // 模型导入重设计（2026-10-07）：必须由用户**明确勾选**至少一个模型才能继续，
      // 不再允许"连通性通过即自动带入模型"（列表可见 ≠ 可用）。
      return s.draft.baseUrl.trim().length > 0
        && s.draft.apiKey.trim().length > 0
        && s.selectedModels.length > 0;
    case 'routing':
      if (!s.routing.defaultModel) return false;
      // 仲裁模型 ≥3 是 loopConfig 校验的硬约束（缺失会让后端启动失败）
      return s.routing.arbitrationModels.length >= 3;
    default:
      return true;
  }
}
