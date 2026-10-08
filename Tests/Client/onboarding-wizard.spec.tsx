/**
 * @vitest-environment jsdom
 *
 * 首次运行引导向导（渲染进程）测试。
 *
 * 覆盖：
 * - 非 Electron 环境不拦截应用（`hasOnboardingApi() === false` → needed=false）
 * - 七步向导渲染与关键交互：目录透明化、供应商选择、连通性校验后勾选模型、
 *   路由硬约束（仲裁模型 ≥3）、完成（写配置）与跳过
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

import OnboardingWizard from '../../Client/src/views/Onboarding/OnboardingWizard';
import { useOnboardingStore } from '../../Client/src/stores/onboardingStore';

// ── 主进程 IPC 替身 ─────────────────────────────────────────────────

const PATHS = {
  mode: 'installed' as const,
  appRoot: 'C:\\Program Files\\CivitasAI\\resources\\app',
  dataRoot: 'C:\\Users\\me\\AppData\\Roaming\\CivitasAI',
  workspaceRoot: 'C:\\Program Files\\CivitasAI\\Workspace',
  configDir: 'C:\\Users\\me\\AppData\\Roaming\\CivitasAI\\Configs',
  bundledConfigDir: 'C:\\Program Files\\CivitasAI\\resources\\app\\Configs',
  logDir: 'C:\\Users\\me\\AppData\\Roaming\\CivitasAI\\Logs',
  databaseDir: 'C:\\Users\\me\\AppData\\Roaming\\CivitasAI\\db',
  secretsDir: 'C:\\Users\\me\\AppData\\Roaming\\CivitasAI\\.secrets',
  backupDir: 'C:\\Program Files\\CivitasAI\\Workspace\\.civitas',
  stateDir: 'C:\\Users\\me\\AppData\\Roaming\\CivitasAI\\.state',
  promptsDir: 'C:\\Program Files\\CivitasAI\\resources\\app\\Prompts',
  skillsDir: 'C:\\Program Files\\CivitasAI\\resources\\app\\Skills',
  writable: { dataRoot: true, workspaceRoot: true },
  warnings: [],
  userConfigPath: 'C:\\Users\\me\\AppData\\Roaming\\CivitasAI\\Configs\\local.json',
  onboardingStatePath: 'C:\\Users\\me\\AppData\\Roaming\\CivitasAI\\.state\\onboarding.json',
};

const SNAPSHOT = {
  state: { completed: false },
  needsOnboarding: true,
  version: '1',
  paths: PATHS,
  userConfigPath: PATHS.userConfigPath,
  userConfig: {},
  providers: [],
  models: [],
  routing: null,
};

const PROBE_OK = {
  ok: true,
  baseUrl: 'https://api.example.com/v1',
  listOk: true,
  chatOk: true,
  models: [
    { id: 'm1', context_window: 128000, max_output: 8192, supports_vision: false, supports_tools: true, cost_per_1k_input: 0, cost_per_1k_output: 0 },
    { id: 'm2', context_window: 128000, max_output: 8192, supports_vision: false, supports_tools: true, cost_per_1k_input: 0, cost_per_1k_output: 0 },
    { id: 'm3', context_window: 128000, max_output: 8192, supports_vision: false, supports_tools: true, cost_per_1k_input: 0, cost_per_1k_output: 0 },
  ],
  suggestedModel: 'm1',
  latencyMs: 42,
};

let api: Record<string, ReturnType<typeof vi.fn>>;

function installElectronApi(overrides: Partial<Record<string, unknown>> = {}) {
  api = {
    getPaths: vi.fn(async () => ({ ok: true, data: PATHS })),
    getState: vi.fn(async () => ({ ok: true, data: SNAPSHOT })),
    testProvider: vi.fn(async () => ({ ok: true, data: PROBE_OK })),
    verifyModels: vi.fn(async () => ({
      ok: true,
      data: {
        results: PROBE_OK.models.map((m) => ({ id: m.id, status: 'available', latencyMs: 42 })),
        summary: { total: PROBE_OK.models.length, available: PROBE_OK.models.length, unavailable: 0, unknown: 0 },
      },
    })),
    writeUserConfig: vi.fn(async () => ({ ok: true, data: { path: PATHS.userConfigPath, applied: [], rejected: [], invalid: [] } })),
    patchState: vi.fn(async () => ({ ok: true, data: { completed: false } })),
    complete: vi.fn(async () => ({
      ok: true,
      data: { state: { completed: true }, config: { path: PATHS.userConfigPath, applied: [], rejected: [] } },
    })),
    skip: vi.fn(async () => ({ ok: true, data: { completed: false, skipped: true } })),
    reset: vi.fn(async () => ({ ok: true, data: { reset: true } })),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ...(overrides as object),
    onboarding: { ...api, ...(overrides['onboarding'] as object ?? {}) },
    openPath: vi.fn(async () => ({ ok: true })),
    pickDirectory: vi.fn(async () => null),
    modelProviders: {
      getProviders: vi.fn(async () => []),
      addProvider: vi.fn(async () => ({ ok: true })),
      getModels: vi.fn(async () => ['p1/m1', 'p1/m2', 'p1/m3']),
    },
  };
}

function resetStore() {
  useOnboardingStore.setState({
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
    routing: { defaultModel: '', directorModel: '', workerModel: '', verifierModel: '', arbitrationModels: [] },
    registering: false,
    notice: null,
    finishing: false,
  });
}

beforeEach(() => {
  resetStore();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

// ── 门控 ────────────────────────────────────────────────────────────

describe('引导门控', () => {
  it('非 Electron 环境：check() 判定为"不需要引导"（不锁住应用）', async () => {
    await useOnboardingStore.getState().check();
    const s = useOnboardingStore.getState();
    expect(s.available).toBe(false);
    expect(s.checked).toBe(true);
    expect(s.needed).toBe(false);
  });

  it('Electron 环境且未初始化：needed=true 并带回目录快照', async () => {
    installElectronApi();
    await useOnboardingStore.getState().check();
    const s = useOnboardingStore.getState();
    expect(s.available).toBe(true);
    expect(s.needed).toBe(true);
    expect(s.paths?.dataRoot).toBe(PATHS.dataRoot);
  });

  it('探测失败时放行（宁可少一次引导，也不要打不开）', async () => {
    installElectronApi({ onboarding: { getState: vi.fn(async () => ({ ok: false, error: 'boom' })) } });
    await useOnboardingStore.getState().check();
    expect(useOnboardingStore.getState().needed).toBe(false);
  });
});

// ── 向导交互 ────────────────────────────────────────────────────────

describe('OnboardingWizard', () => {
  it('第一步展示目录透明化（数据根/工作空间/用户配置）', async () => {
    installElectronApi();
    await useOnboardingStore.getState().check();
    useOnboardingStore.setState({ needed: true, step: 0 });

    render(<OnboardingWizard onFinish={vi.fn()} />);
    expect(screen.getByText('Civitas AI')).toBeTruthy();
    expect(screen.getByText(PATHS.dataRoot)).toBeTruthy();
    expect(screen.getByText(PATHS.workspaceRoot)).toBeTruthy();
    expect(screen.getByText(PATHS.userConfigPath)).toBeTruthy();
    expect(screen.getByText(/安装模式/)).toBeTruthy();
  });

  it('选择供应商 → 填 Key → 测试连接 → 勾选模型后方可继续', async () => {
    installElectronApi();
    await useOnboardingStore.getState().check();
    useOnboardingStore.setState({ needed: true, step: 2 });

    render(<OnboardingWizard onFinish={vi.fn()} />);
    fireEvent.click(screen.getByText('华为云 MaaS'));
    expect(useOnboardingStore.getState().draft.providerId).toBe('huawei-maas');

    // 进入密钥步骤（用步骤内容断言，避免与左侧步骤列表同名文本冲突）
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    expect(screen.getByText('连接信息')).toBeTruthy();

    const inputs = document.querySelectorAll('input');
    fireEvent.change(inputs[1]!, { target: { value: 'https://api.example.com/v1' } });
    fireEvent.change(inputs[2]!, { target: { value: 'sk-test' } });

    fireEvent.click(screen.getByText('测试连接'));
    await waitFor(() => expect(api['testProvider']).toHaveBeenCalled());
    // 模型导入重设计：连通性通过后**不再自动勾选**任何模型（列表可见 ≠ 可用）
    await waitFor(() => expect(useOnboardingStore.getState().selectedModels.length).toBe(0));
    expect((screen.getByRole('button', { name: /下一步/ }) as HTMLButtonElement).disabled).toBe(true);

    // 用户手动勾选一个模型后才能继续（chip 的 accessible name 含徽标文案，故用正则）
    fireEvent.click(screen.getAllByRole('button', { name: /m1/ })[0]!);
    await waitFor(() => expect(useOnboardingStore.getState().selectedModels.length).toBe(1));
    expect((screen.getByRole('button', { name: /下一步/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('校验可用性 → 仅选可用：只导入被确认可用的模型', async () => {
    installElectronApi({
      onboarding: {
        getState: vi.fn(async () => ({ ok: true, data: SNAPSHOT })),
        testProvider: vi.fn(async () => ({ ok: true, data: PROBE_OK })),
    verifyModels: vi.fn(async () => ({
      ok: true,
      data: {
        results: PROBE_OK.models.map((m) => ({ id: m.id, status: 'available', latencyMs: 42 })),
        summary: { total: PROBE_OK.models.length, available: PROBE_OK.models.length, unavailable: 0, unknown: 0 },
      },
    })),
        verifyModels: vi.fn(async () => ({
          ok: true,
          data: {
            results: [
              { id: 'm1', status: 'available', latencyMs: 120 },
              { id: 'm2', status: 'unavailable', providerMessage: 'Model not exist.（model_not_found）' },
              { id: 'm3', status: 'unknown', errorKind: 'http', providerMessage: '触发供应商限流（429）' },
            ],
            summary: { total: 3, available: 1, unavailable: 1, unknown: 1 },
          },
        })),
      },
    });
    await useOnboardingStore.getState().check();
    useOnboardingStore.setState({
      needed: true,
      step: 3,
      draft: { providerId: 'p', displayName: 'P', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' },
      probe: PROBE_OK as never,
      selectedModels: [],
      availability: {},
      verifiedAt: null,
    });

    // 驱动 store 的校验 + 勾选逻辑（新增的核心规则）；渲染层由其它用例覆盖
    await useOnboardingStore.getState().verifyAvailability();

    const state = useOnboardingStore.getState();
    expect(state.verifying).toBe(false);
    expect(state.verifiedAt).toBeTruthy();
    expect(state.verifyProgress).toEqual({ checked: 3, total: 3 });
    expect(state.availability['m1']!.status).toBe('available');
    expect(state.availability['m2']!.status).toBe('unavailable');
    expect(state.availability['m3']!.status).toBe('unknown');
    // 校验过程**不会**自动勾选任何模型
    expect(state.selectedModels).toHaveLength(0);

    // 仅选可用 → 只勾选 m1
    useOnboardingStore.getState().selectOnlyAvailable();
    expect(useOnboardingStore.getState().selectedModels.map((m) => m.id)).toEqual(['m1']);

    // 渲染该步骤：可用性徽标应出现在列表里（"不可用""未知"各至少一个）
    render(<OnboardingWizard onFinish={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText('不可用').length).toBeGreaterThan(0));
    expect(screen.getAllByText('未知').length).toBeGreaterThan(0);
    expect(screen.getByText(/已勾选/)).toBeTruthy();
  });

  it('连通性失败：提示可归因错误，且不可继续', async () => {
    installElectronApi({
      onboarding: {
        testProvider: vi.fn(async () => ({
          ok: true,
          data: { ...PROBE_OK, ok: false, listOk: false, chatOk: false, models: [], errorKind: 'auth', error: '鉴权失败（HTTP 401）', hint: 'API Key 无效' },
        })),
      },
    });
    await useOnboardingStore.getState().check();
    useOnboardingStore.setState({ needed: true, step: 3, draft: { providerId: 'p', displayName: 'P', baseUrl: 'https://x/v1', apiKey: 'bad' } });

    render(<OnboardingWizard onFinish={vi.fn()} />);
    fireEvent.click(screen.getByText('测试连接'));
    await waitFor(() => expect(screen.getAllByText(/鉴权失败（HTTP 401）/).length).toBeGreaterThan(0));
    expect((screen.getByRole('button', { name: /下一步/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('路由步骤：仲裁模型不足 3 个时不可继续', async () => {
    installElectronApi();
    await useOnboardingStore.getState().check();
    useOnboardingStore.setState({
      needed: true,
      step: 4,
      snapshot: { ...SNAPSHOT, models: ['p1/m1', 'p1/m2', 'p1/m3'] },
      routing: { defaultModel: 'p1/m1', directorModel: 'p1/m2', workerModel: 'p1/m1', verifierModel: 'p1/m2', arbitrationModels: ['p1/m1'] },
    });

    render(<OnboardingWizard onFinish={vi.fn()} />);
    expect((screen.getByRole('button', { name: /下一步/ }) as HTMLButtonElement).disabled).toBe(true);

    // 只点"仲裁模型"区的 chip（下拉框里的同名 option 不是 button）
    fireEvent.click(screen.getAllByRole('button', { name: 'p1/m2' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'p1/m3' })[0]!);
    await waitFor(() => expect(useOnboardingStore.getState().routing.arbitrationModels.length).toBe(3));
    expect((screen.getByRole('button', { name: /下一步/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('完成：写出路由与个性化配置，并结束引导', async () => {
    installElectronApi();
    const onFinish = vi.fn();
    await useOnboardingStore.getState().check();
    useOnboardingStore.setState({
      needed: true,
      step: 6,
      draft: { providerId: 'huawei-maas', displayName: '华为云 MaaS', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' },
      routing: { defaultModel: 'p1/m1', directorModel: 'p1/m2', workerModel: 'p1/m1', verifierModel: 'p1/m2', arbitrationModels: ['p1/m1', 'p1/m2', 'p1/m3'] },
      personalization: { logLevel: 'warn', workspaceRoot: 'D:\\ws' },
    });

    render(<OnboardingWizard onFinish={onFinish} />);
    fireEvent.click(screen.getByRole('button', { name: /开始使用/ }));

    await waitFor(() => expect(api['complete']).toHaveBeenCalled());
    const payload = api['complete']!.mock.calls[0]![0] as { configPatch: Record<string, unknown>; personalization: Record<string, unknown> };
    expect(payload.configPatch['routing.defaultModel']).toBe('p1/m1');
    expect(payload.configPatch['system.logLevel']).toBe('warn');
    expect(payload.configPatch['workspace.root']).toBe('D:\\ws');
    expect(payload.configPatch['routing.arbitrationModels']).toHaveLength(3);
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
    expect(useOnboardingStore.getState().needed).toBe(false);
  });

  it('跳过：调用 skip 通道并结束引导', async () => {
    installElectronApi();
    const onFinish = vi.fn();
    await useOnboardingStore.getState().check();
    useOnboardingStore.setState({ needed: true, step: 0 });

    render(<OnboardingWizard onFinish={onFinish} />);
    fireEvent.click(screen.getByText(/跳过引导/));

    await waitFor(() => expect(api['skip']).toHaveBeenCalled());
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
    expect(useOnboardingStore.getState().needed).toBe(false);
  });
});
