/**
 * @module Interface/IpcBridge/onboardingIpc
 * @description
 * 首次运行引导（onboarding）IPC 通道。
 *
 * 与既有通道的分工：
 * - **供应商注册 + API_KEY 加密落盘** 复用 `ipc-add-provider`（不在此重复实现）；
 * - 本模块只补"引导需要、而此前不存在"的能力：路径透明化、引导状态、连通性探测、
 *   **白名单写用户配置**、完成/跳过/重置。
 *
 * 全部 handler 返回 `{ ok, data?, error? }` 结构，渲染进程按 `onboardingStore` 的约定消费。
 */

import { logger } from '../../Infra/Logging/logger.js';
import { describePaths, getStateDir } from '../../Infra/Fs/pathResolver.js';
import { probeProviderConnection, verifyModels, type ProbeInput, type VerifyModelsInput } from '../../Infra/Llm/providerProbe.js';
import { getRoutingConfig, setRoutingConfig, getProviders, getRegisteredModels } from '../../Infra/Llm/Router/modelRouter.js';
import {
  readUserConfig,
  writeUserConfig,
  getUserConfigPath,
} from '../../Infra/Config/userConfigWriter.js';
import {
  completeOnboarding,
  getOnboardingStatePath,
  readOnboardingState,
  resetOnboarding,
  skipOnboarding,
  needsOnboarding,
  writeOnboardingState,
  ONBOARDING_VERSION,
  type OnboardingPersonalization,
  type OnboardingState,
} from '../../Services/Onboarding/onboardingState.js';

/** 本模块注册的全部通道（供 `stopIpcBridge` 统一摘除） */
export const ONBOARDING_IPC_CHANNELS = [
  'ipc-get-app-paths',
  'ipc-get-onboarding',
  'ipc-test-provider',
  'ipc-verify-models',
  'ipc-write-user-config',
  'ipc-complete-onboarding',
  'ipc-skip-onboarding',
  'ipc-reset-onboarding',
  'ipc-patch-onboarding',
] as const;

type IpcMainLike = { handle: (channel: string, listener: (...args: unknown[]) => unknown) => void };

interface OnboardingSnapshot {
  state: OnboardingState;
  needsOnboarding: boolean;
  version: string;
  paths: ReturnType<typeof describePaths>;
  userConfigPath: string;
  userConfig: Record<string, unknown>;
  providers: Array<{ name: string; displayName: string; modelIds: string[] }>;
  models: string[];
  routing: ReturnType<typeof getRoutingConfig>;
}

/** 组装引导页需要的全部现状（一次调用，避免前端多次往返） */
function snapshot(): OnboardingSnapshot {
  const providers = getProviders().map((p) => ({
    name: p.name,
    displayName: p.displayName,
    modelIds: p.getModels().map((m) => m.id),
  }));
  return {
    state: readOnboardingState(),
    needsOnboarding: needsOnboarding(),
    version: ONBOARDING_VERSION,
    paths: describePaths(),
    userConfigPath: getUserConfigPath(),
    userConfig: readUserConfig(),
    providers,
    models: getRegisteredModels(),
    routing: getRoutingConfig(),
  };
}
/** 把路由补丁应用到内存路由（引导完成即可用，无需重启） */
function applyRoutingPatch(patch: Record<string, unknown>): void {
  const routingKeys = Object.keys(patch).filter((k) => k.startsWith('routing.'));
  if (routingKeys.length === 0) return;

  const current = getRoutingConfig() ?? {
    defaultModel: '', directorModel: '', workerModel: '', verifierModel: '',
    arbitrationModels: [], fallbackOrder: [],
    timeoutMs: 60000, firstByteTimeoutMs: 10000, interChunkTimeoutMs: 15000,
  };
  const next = { ...current };
  for (const key of routingKeys) {
    const field = key.slice('routing.'.length) as keyof typeof next;
    const value = patch[key];
    if (field in next) {
      (next as Record<string, unknown>)[field] = value;
    }
  }
  setRoutingConfig(next);
  logger.info('引导已更新内存路由（无需重启）', {
    source: 'onboardingIpc',
    defaultModel: next.defaultModel,
    fallbackOrder: next.fallbackOrder,
  });
}

/**
 * 注册引导相关 IPC。
 *
 * @param ipcMain Electron 的 ipcMain（由 `ipcBridge` 注入，非 Electron 环境为空操作）
 */
export function registerOnboardingIpc(ipcMain: IpcMainLike): void {
  // 路径透明化：让用户看到"程序装在哪、数据存在哪、工作空间在哪"
  ipcMain.handle('ipc-get-app-paths', () => {
    try {
      const paths = describePaths();
      return {
        ok: true,
        data: {
          ...paths,
          userConfigPath: getUserConfigPath(),
          onboardingStatePath: getOnboardingStatePath(),
          stateDir: getStateDir(),
        },
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 引导现状（状态 + 已有供应商/模型/路由 + 目录）
  ipcMain.handle('ipc-get-onboarding', () => {
    try {
      return { ok: true, data: snapshot() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 连通性校验（/models + 最小对话）
  ipcMain.handle('ipc-test-provider', async (_event, input: unknown) => {
    try {
      const result = await probeProviderConnection((input ?? {}) as ProbeInput);
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /**
   * 逐模型可用性校验（模型导入重设计，2026-10-07）。
   *
   * 渲染层按**小批次**调用（每批 ≈8 个模型）以便展示进度；并发在服务端内部限流。
   * 只返回校验结论，不做导入——导出的模型由用户在列表里勾选后走 `ipc-add-provider`。
   */
  ipcMain.handle('ipc-verify-models', async (_event, input: unknown) => {
    try {
      const payload = (input ?? {}) as VerifyModelsInput;
      const result = await verifyModels(payload);
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 白名单写用户配置（写 `<数据根>/Configs/local.json`，并同步内存路由）
  ipcMain.handle('ipc-write-user-config', (_event, patch: unknown) => {
    try {
      const result = writeUserConfig((patch ?? {}) as Record<string, unknown>);
      if (!result.ok) return { ok: false, error: result.error };
      applyRoutingPatch((patch ?? {}) as Record<string, unknown>);
      return { ok: true, data: result.value };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 完成引导：写配置 + 应用路由 + 落状态标记
  ipcMain.handle('ipc-complete-onboarding', (_event, payload: unknown) => {
    try {
      const input = (payload ?? {}) as {
        personalization?: OnboardingPersonalization;
        provider?: OnboardingSnapshot['state']['provider'];
        configPatch?: Record<string, unknown>;
      };

      const writeResult = writeUserConfig(input.configPatch ?? {});
      if (!writeResult.ok) return { ok: false, error: writeResult.error };
      applyRoutingPatch(input.configPatch ?? {});

      const stateResult = completeOnboarding({
        personalization: input.personalization,
        provider: input.provider,
      });
      if (!stateResult.ok) return { ok: false, error: stateResult.error };

      logger.info('首次运行引导已完成', {
        source: 'onboardingIpc',
        appliedKeys: writeResult.value.applied.length,
        rejectedKeys: writeResult.value.rejected,
        provider: input.provider?.name,
      });

      return {
        ok: true,
        data: {
          state: stateResult.value,
          config: writeResult.value,
        },
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 跳过引导（仍可稍后从设置重跑）
  ipcMain.handle('ipc-skip-onboarding', () => {
    try {
      const result = skipOnboarding();
      return result.ok ? { ok: true, data: result.value } : { ok: false, error: result.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 重置引导（设置里"重新运行初始化引导"）
  ipcMain.handle('ipc-reset-onboarding', () => {
    try {
      const result = resetOnboarding();
      return result.ok ? { ok: true, data: { reset: result.value } } : { ok: false, error: result.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 仅更新状态（例如个性化项随步写入；完成用 complete）
  ipcMain.handle('ipc-patch-onboarding', (_event, patch: unknown) => {
    try {
      const result = writeOnboardingState((patch ?? {}) as Partial<OnboardingState>);
      return result.ok ? { ok: true, data: result.value } : { ok: false, error: result.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
