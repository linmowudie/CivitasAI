/**
 * 首次运行引导（onboarding）后端测试。
 *
 * 覆盖：
 * - `onboardingState`：未初始化 / 完成 / 跳过 / 重置 / 损坏文件安全回退
 * - `userConfigWriter`：白名单写入、越权键拒绝、取值校验、与既有 local.json 合并
 * - `providerProbe`：/models + 最小对话探测的成功与各类可归因失败
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readOnboardingState,
  writeOnboardingState,
  completeOnboarding,
  skipOnboarding,
  resetOnboarding,
  needsOnboarding,
  getOnboardingStatePath,
  ONBOARDING_VERSION,
} from '../../Src/Services/Onboarding/onboardingState.js';
import {
  writeUserConfig,
  readUserConfig,
  getUserConfigPath,
  isAllowedConfigPath,
} from '../../Src/Infra/Config/userConfigWriter.js';
import { probeProviderConnection, defaultModelSpec, pickChatCandidates, verifyModels } from '../../Src/Infra/Llm/providerProbe.js';
import { resetPathCache } from '../../Src/Infra/Fs/pathResolver.js';

// ── 环境沙箱：把数据根指向临时目录 ──────────────────────────────────

let dataRoot = '';
const MANAGED = ['CIVITAS_DATA_ROOT', 'CIVITAS_WORKSPACE_ROOT', 'CIVITAS_CONFIG_DIR', 'CIVITAS_STATE_DIR'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'civitas-onboarding-'));
  saved = {};
  for (const key of MANAGED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env['CIVITAS_DATA_ROOT'] = dataRoot;
  process.env['CIVITAS_WORKSPACE_ROOT'] = join(dataRoot, 'Workspace');
  // 用户配置层也跟着走临时目录（否则开发态会写到仓库 Configs/）
  process.env['CIVITAS_CONFIG_DIR'] = join(dataRoot, 'Configs');
  resetPathCache();
});

afterEach(() => {
  for (const key of MANAGED) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetPathCache();
  vi.restoreAllMocks();
  try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

// ── onboardingState ─────────────────────────────────────────────────

describe('onboardingState', () => {
  it('初始状态：文件不存在 → 未完成且需要引导', () => {
    expect(existsSync(getOnboardingStatePath())).toBe(false);
    expect(readOnboardingState().completed).toBe(false);
    expect(needsOnboarding()).toBe(true);
    expect(getOnboardingStatePath()).toContain('.state');
  });

  it('完成引导：写状态文件、不再拦截、带版本与时间戳', () => {
    const result = completeOnboarding({
      personalization: { logLevel: 'warn' },
      provider: { name: 'p1', displayName: 'P1', baseUrl: 'https://x/v1', defaultModel: 'p1/m' },
    });
    expect(result.ok).toBe(true);
    const state = readOnboardingState();
    expect(state.completed).toBe(true);
    expect(state.skipped).toBe(false);
    expect(state.version).toBe(ONBOARDING_VERSION);
    expect(typeof state.completedAt).toBe('number');
    expect(state.personalization?.logLevel).toBe('warn');
    expect(state.provider?.defaultModel).toBe('p1/m');
    expect(needsOnboarding()).toBe(false);
  });

  it('跳过引导：completed=false 但不再拦截（可随时重跑）', () => {
    expect(skipOnboarding().ok).toBe(true);
    const state = readOnboardingState();
    expect(state.completed).toBe(false);
    expect(state.skipped).toBe(true);
    expect(needsOnboarding()).toBe(false);
  });

  it('重置引导：重新进入需要引导', () => {
    completeOnboarding();
    expect(needsOnboarding()).toBe(false);
    expect(resetOnboarding().ok).toBe(true);
    expect(readOnboardingState().completed).toBe(false);
    expect(needsOnboarding()).toBe(true);
  });

  it('状态文件损坏 → 当作未初始化（宁可重引导，不可静默跳过）', () => {
    const file = getOnboardingStatePath();
    mkdirSync(join(dataRoot, '.state'), { recursive: true });
    writeFileSync(file, '{ this is not json', 'utf8');
    expect(readOnboardingState().completed).toBe(false);
    expect(needsOnboarding()).toBe(true);
  });

  it('重复完成幂等：保留既有字段并更新版本/时间', () => {
    completeOnboarding({ personalization: { theme: 'dark' } });
    const first = readOnboardingState();
    completeOnboarding({ personalization: { logLevel: 'error' } });
    const second = readOnboardingState();
    expect(second.completed).toBe(true);
    expect(second.personalization?.theme).toBe('dark');
    expect(second.personalization?.logLevel).toBe('error');
    expect(second.completedAt).toBeGreaterThanOrEqual(first.completedAt ?? 0);
  });

  it('部分写入（patch）不改变 completed 语义', () => {
    const r = writeOnboardingState({ personalization: { workspaceRoot: 'D:\\ws' } });
    expect(r.ok).toBe(true);
    expect(readOnboardingState().completed).toBe(false);
  });
});

// ── userConfigWriter ────────────────────────────────────────────────

describe('userConfigWriter', () => {
  it('白名单键写入用户配置层并可读回', () => {
    const result = writeUserConfig({
      'system.logLevel': 'warn',
      'routing.defaultModel': 'p1/m1',
      'server.httpPort': 39123,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toHaveLength(3);
    expect(result.value.rejected).toHaveLength(0);
    expect(result.value.path).toBe(getUserConfigPath());

    const config = readUserConfig();
    expect((config['system'] as Record<string, unknown>)['logLevel']).toBe('warn');
    expect((config['routing'] as Record<string, unknown>)['defaultModel']).toBe('p1/m1');
    expect((config['server'] as Record<string, unknown>)['httpPort']).toBe(39123);
  });

  it('白名单外的键被拒绝且不写入（保护 L0 配置）', () => {
    const result = writeUserConfig({
      'database.mainPath': 'C:\\evil.db',
      'security.autoApprove.tools': ['file.write'],
      'loopConfig.hardLimits.maxIterationsCeiling': 99999,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toHaveLength(0);
    expect(result.value.rejected).toHaveLength(3);
    // 未写入任何东西 → local.json 不应被创建
    expect(existsSync(getUserConfigPath())).toBe(false);
  });

  it('取值校验：端口越界 / 日志级别非法 → invalid，且整体不落盘', () => {
    const result = writeUserConfig({
      'server.httpPort': 70000,
      'system.logLevel': 'verbose',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invalid.map((i) => i.path).sort()).toEqual(['server.httpPort', 'system.logLevel']);
    expect(result.value.applied).toHaveLength(0);
    expect(existsSync(getUserConfigPath())).toBe(false);
  });

  it('与既有 local.json 合并（保留用户手工写的其他白名单键）', () => {
    writeUserConfig({ 'system.logLevel': 'info', 'ui.dashboardPollIntervalSec': 5 });
    const result = writeUserConfig({ 'routing.workerModel': 'p1/m2' });
    expect(result.ok).toBe(true);
    const config = readUserConfig();
    const routing = config['routing'] as Record<string, unknown>;
    const ui = config['ui'] as Record<string, unknown>;
    expect(routing['workerModel']).toBe('p1/m2');
    expect((config['system'] as Record<string, unknown>)['logLevel']).toBe('info');
    expect(ui['dashboardPollIntervalSec']).toBe(5);
  });

  it('现有 local.json 损坏 → 拒绝写入并给出 FATAL 提示（不覆盖用户文件）', () => {
    mkdirSync(join(dataRoot, 'Configs'), { recursive: true });
    writeFileSync(getUserConfigPath(), '{ broken json', 'utf8');
    const result = writeUserConfig({ 'system.logLevel': 'debug' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('解析失败');
    // 原文件保持原样
    expect(readFileSync(getUserConfigPath(), 'utf8')).toBe('{ broken json');
  });

  it('isAllowedConfigPath：允许清单内的点路径，拒绝其他', () => {
    expect(isAllowedConfigPath('routing.defaultModel')).toBe(true);
    expect(isAllowedConfigPath('ui.anything')).toBe(true);
    expect(isAllowedConfigPath('workspace.root')).toBe(true);
    expect(isAllowedConfigPath('onboarding.note')).toBe(true);
    expect(isAllowedConfigPath('database.mainPath')).toBe(false);
    expect(isAllowedConfigPath('security.autoApprove')).toBe(false);
  });
});

// ── providerProbe ───────────────────────────────────────────────────

describe('providerProbe', () => {
  const BASE = 'https://api.example.com/v1';

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  it('列表 + 对话都成功 → ok，返回模型清单与首字节时延', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) {
        return jsonResponse(200, { data: [{ id: 'm1' }, { id: 'm2' }] });
      }
      return jsonResponse(200, { choices: [{ message: { content: '' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeProviderConnection({ base_url: `${BASE}/`, api_key: 'sk-test' });
    expect(result.ok).toBe(true);
    expect(result.listOk).toBe(true);
    expect(result.chatOk).toBe(true);
    expect(result.baseUrl).toBe(BASE); // 末尾斜杠被规范化
    expect(result.models.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(result.suggestedModel).toBe('m1');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('401 → errorKind=auth，提示指向 API Key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthorized' })));
    const result = await probeProviderConnection({ base_url: BASE, api_key: 'bad' });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('auth');
    expect(result.hint).toContain('API Key');
  });

  it('端点不提供 /models（404）但对话成功 → ok=true, listOk=false', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) return jsonResponse(404, {});
      return jsonResponse(200, { choices: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeProviderConnection({ base_url: BASE, api_key: 'sk', model: 'my-model' });
    expect(result.listOk).toBe(false);
    expect(result.chatOk).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.suggestedModel).toBe('my-model');
  });

  it('列表可读但对话 403 → 给出"模型无权限/路径"提示', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) return jsonResponse(200, { data: [{ id: 'm1' }] });
      return jsonResponse(403, { error: 'forbidden' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeProviderConnection({ base_url: BASE, api_key: 'sk' });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('auth');
    expect(result.hint).toContain('m1');
  });

  it('缺少 Base URL / API Key → invalid_input（不发请求）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeProviderConnection({ base_url: '', api_key: '' });
    expect(result.errorKind).toBe('invalid_input');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('网络异常 → errorKind=network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND api.example.com'); }));
    const result = await probeProviderConnection({ base_url: BASE, api_key: 'sk' });
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe('network');
    expect(result.hint).toContain('网络');
  });

  it('默认模型规格：context_window 必须 > 0（providerBase 拒注 0）', () => {
    const spec = defaultModelSpec('m');
    expect(spec.context_window).toBeGreaterThan(0);
    expect(spec.max_output).toBeGreaterThan(0);
  });
});

// ── API Key 规范化与错误归因（2026-10-07 修复）──────────────────────

describe('providerProbe · API Key 规范化', () => {
  const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

  /** 捕获 fetch 实际收到的 Authorization 头 */
  function captureAuth(respond: () => Response): { mock: ReturnType<typeof vi.fn>; auth: () => string } {
    let auth = '';
    const mock = vi.fn(async (_url: string, init?: RequestInit) => {
      auth = String((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '');
      return respond();
    });
    vi.stubGlobal('fetch', mock);
    return { mock, auth: () => auth };
  }

  const okList = () => ({
    ok: true, status: 200,
    json: async () => ({ data: [{ id: 'qwen-plus' }] }),
    text: async () => '{}',
  } as unknown as Response);

  it('零宽字符（trim 不会去掉）被清理后才发送，并如实回报', async () => {
    const { auth } = captureAuth(okList);
    const result = await probeProviderConnection({
      base_url: BASE,
      api_key: 'sk-abc123\u200b\u200d',   // 从网页复制常见的零宽字符
    });
    expect(auth()).toBe('Bearer sk-abc123');        // 真正发出的头是干净的
    expect(result.keySanitized?.length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
  });

  it('外层引号与 "Bearer " 前缀被剥离（用户常把整个头值粘进来）', async () => {
    const { auth } = captureAuth(okList);
    const result = await probeProviderConnection({
      base_url: BASE,
      api_key: '"Bearer sk-real-key"',
    });
    expect(auth()).toBe('Bearer sk-real-key');
    expect(result.keySanitized).toEqual(expect.arrayContaining(['去除外层引号', '去除 "Bearer " 前缀']));
  });

  it('仍含非 ASCII 字符时给出可执行的提示，而不是误报"网络不可达"', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeProviderConnection({ base_url: BASE, api_key: 'sk-密钥' });
    expect(fetchMock).not.toHaveBeenCalled();        // 根本没发请求
    expect(result.errorKind).toBe('invalid_input');
    expect(result.hint).toContain('重新复制');
  });

  it('列表明文返回 invalid_api_key 时，原话被带出来（用户能自查）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({
        error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' },
      }),
    } as unknown as Response)));

    const result = await probeProviderConnection({ base_url: BASE, api_key: 'sk-bad' });
    expect(result.errorKind).toBe('auth');
    expect(result.error).toBe('鉴权失败（HTTP 401）');
    expect(result.providerMessage).toContain('Incorrect API key provided.');
    expect(result.providerMessage).toContain('invalid_api_key');
    expect(result.hint).toContain('供应商原话');
    // 关键：没有发起对话探测，且不谎称"端点不提供"
    expect(result.chatAttempted).toBe(false);
    expect(result.listAttempted).toBe(true);
    expect(result.listNotProvided).toBeUndefined();
  });

  it('404/405 才标记"端点不提供"，并继续对话探测', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) {
        return { ok: false, status: 404, text: async () => '' } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) } as unknown as Response;
    }));

    const result = await probeProviderConnection({ base_url: BASE, api_key: 'sk-x', model: 'my-model' });
    expect(result.listNotProvided).toBe(true);
    expect(result.chatAttempted).toBe(true);
    expect(result.chatOk).toBe(true);
    expect(result.ok).toBe(true);
  });
});

// ── 对话探测的模型选择（2026-10-07 修复：不再盲用 models[0]）────────

describe('providerProbe · 对话模型选择', () => {
  const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

  /** /models 返回一长串模型（含非对话模型），记录 chat 请求实际用的 model */
  function stubProvider(modelIds: string[], chatResponse: (model: string) => Response) {
    const usedModels: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/models')) {
        return {
          ok: true, status: 200,
          json: async () => ({ data: modelIds.map((id) => ({ id })) }),
          text: async () => '{}',
        } as unknown as Response;
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      usedModels.push(body.model ?? '');
      return chatResponse(body.model ?? '');
    }));
    return usedModels;
  }

  it('pickChatCandidates：排除 embedding/tts/asr/image，优先常见对话前缀', () => {
    const models = [
      'text-embedding-v1', 'wanx-v1', 'cosyvoice-v1', 'paraformer-v1',
      'qwen-plus', 'qwen-turbo', 'gpt-4o-mini',
    ].map((id) => defaultModelSpec(id));

    const candidates = pickChatCandidates(models);
    expect(candidates).not.toContain('text-embedding-v1');
    expect(candidates).not.toContain('wanx-v1');
    expect(candidates).not.toContain('cosyvoice-v1');
    expect(candidates[0]).toBe('qwen-plus');       // 对话前缀优先
    expect(candidates).toContain('gpt-4o-mini');
  });

  it('列表首位是 embedding 时，不会拿它去探测对话（Key 正确也不再误判）', async () => {
    const used = stubProvider(
      ['text-embedding-v1', 'qwen-plus'],
      () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) } as unknown as Response),
    );

    const result = await probeProviderConnection({ base_url: BASE, api_key: 'sk-ok' });
    expect(used).toEqual(['qwen-plus']);            // 关键：跳过 embedding
    expect(result.ok).toBe(true);
    expect(result.chatModelUsed).toBe('qwen-plus');
    expect(result.suggestedModel).toBe('qwen-plus');
  });

  it('候选模型逐个失败时自动重试下一个，直到成功', async () => {
    const used = stubProvider(
      ['qwen-plus', 'qwen-turbo'],
      (model) => (model === 'qwen-plus'
        // 第一个候选：模型未开通
        ? {
            ok: false, status: 400,
            text: async () => JSON.stringify({ error: { message: 'Model not exist.', code: 'model_not_found' } }),
          } as unknown as Response
        // 第二个候选：成功
        : { ok: true, status: 200, text: async () => '{}', json: async () => ({}) } as unknown as Response),
    );

    const result = await probeProviderConnection({ base_url: BASE, api_key: 'sk-ok' });
    expect(used).toEqual(['qwen-plus', 'qwen-turbo']);
    expect(result.ok).toBe(true);
    expect(result.chatModelUsed).toBe('qwen-turbo');
    expect(result.chatAttempts).toBe(2);
  });

  it('鉴权失败（401）不浪费重试：只试一次并把供应商原话带回', async () => {
    const used = stubProvider(
      ['qwen-plus', 'qwen-turbo'],
      () => ({
        ok: false, status: 401,
        text: async () => JSON.stringify({ error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } }),
      } as unknown as Response),
    );

    const result = await probeProviderConnection({ base_url: BASE, api_key: 'sk-bad' });
    expect(used).toHaveLength(1);
    expect(result.errorKind).toBe('auth');
    expect(result.providerMessage).toContain('invalid_api_key');
  });

  it('显式指定模型时只用它（用户手动选择优先）', async () => {
    const used = stubProvider(
      ['qwen-plus', 'qwen-turbo'],
      () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) } as unknown as Response),
    );

    const result = await probeProviderConnection({ base_url: BASE, api_key: 'sk-ok', model: 'qwen-turbo' });
    expect(used).toEqual(['qwen-turbo']);
    expect(result.chatModelUsed).toBe('qwen-turbo');
  });

  it('所有候选都失败时，如实报告"已依次尝试 N 个候选模型"', async () => {
    const used = stubProvider(
      ['qwen-plus', 'qwen-turbo'],
      () => ({
        ok: false, status: 400,
        text: async () => JSON.stringify({ error: { message: 'Model not exist.', code: 'model_not_found' } }),
      } as unknown as Response),
    );

    const result = await probeProviderConnection({ base_url: BASE, api_key: 'sk-ok' });
    expect(used).toEqual(['qwen-plus', 'qwen-turbo']);
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/已依次尝试 2 个候选模型/);
    expect(result.providerMessage).toContain('model_not_found');
  });
});

// ── 逐模型可用性校验（模型导入重设计，2026-10-07）──────────────────

describe('verifyModels · 逐个确认模型可用性', () => {
  const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

  /** 按模型 id 定制每个请求的响应 */
  function stubChat(respond: (model: string) => { status: number; body?: unknown; ok?: boolean }) {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      const model = body.model ?? '';
      seen.push(model);
      const r = respond(model);
      return {
        ok: r.ok ?? (r.status >= 200 && r.status < 300),
        status: r.status,
        text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
        json: async () => r.body ?? {},
      } as unknown as Response;
    }));
    return seen;
  }

  it('区分 可用 / 不可用 / 未知（限流不判死）', async () => {
    stubChat((model) => {
      if (model === 'good') return { status: 200, body: { choices: [] } };
      if (model === 'not-enabled') {
        return { status: 400, body: { error: { message: 'Model not exist.', code: 'model_not_found' } } };
      }
      return { status: 429, body: { error: { message: 'Requests rate limit exceeded' } } };
    });

    const result = await verifyModels({ base_url: BASE, api_key: 'sk-ok', models: ['good', 'not-enabled', 'busy'] });
    const byId = Object.fromEntries(result.results.map((r) => [r.id, r]));

    expect(byId['good']!.status).toBe('available');
    expect(byId['good']!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(byId['not-enabled']!.status).toBe('unavailable');
    expect(byId['not-enabled']!.providerMessage).toContain('Model not exist.');
    // 关键：限流**不能**判成"这个模型不可用"
    expect(byId['busy']!.status).toBe('unknown');
    expect(result.summary).toEqual({ total: 3, available: 1, unavailable: 1, unknown: 1 });
  });

  it('鉴权失败（401）时整批为 unknown，不误判模型', async () => {
    stubChat(() => ({
      status: 401,
      body: { error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } },
    }));

    const result = await verifyModels({ base_url: BASE, api_key: 'sk-bad', models: ['a', 'b'] });
    expect(result.results.every((r) => r.status === 'unknown')).toBe(true);
    expect(result.summary.unknown).toBe(2);
    expect(result.results.every((r) => r.errorKind === 'auth')).toBe(true);
  });

  it('结果顺序与入参一致（并发完成顺序不影响 UI）', async () => {
    stubChat(() => ({ status: 200, body: { choices: [] } }));
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'];
    const result = await verifyModels({ base_url: BASE, api_key: 'sk-ok', models: ids, concurrency: 4 });
    expect(result.results.map((r) => r.id)).toEqual(ids);
  });

  it('去重 + 缺参保护', async () => {
    stubChat(() => ({ status: 200, body: { choices: [] } }));
    const dedup = await verifyModels({ base_url: BASE, api_key: 'sk-ok', models: ['m1', 'm1', 'm2'] });
    expect(dedup.results.map((r) => r.id)).toEqual(['m1', 'm2']);

    const noKey = await verifyModels({ base_url: BASE, api_key: '', models: ['m1'] });
    expect(noKey.results[0]!.status).toBe('unknown');
    expect(noKey.results[0]!.errorKind).toBe('invalid_input');
  });
});
