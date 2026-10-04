/**
 * @vitest-environment jsdom
 *
 * 验证码登录 → 自动拉取 → 守卫放行（FE-031 集成）
 *
 * 修复背景：此前验证码登录由独立 `authStore` 承担，成功后仅把令牌写入安全存储，
 * 依赖 LoginPage 手动调用 `accountStore.init()` 重新读令牌完成"桥接"（任一侧改键名
 * 即断链，且曾漏做自动拉取）。合并到 `accountStore` 后本测试锁定：
 *  ① 验证码登录成功 → `status='authenticated'`（应用内"已登录"判定的唯一依据，
 *     即原"守卫放行"语义：AccountPanel 等据此放行功能）；
 *  ② 令牌单一真源：登录后鉴权请求（refreshProfile → GET /v1/me）直接可用，
 *     无需再 init() 桥接；
 *  ③ 登录成功自动拉取（pullAll 被调用）且设备凭据随请求发送；
 *  ④ 失败回到验证码步骤、重置与登出正确归零。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// syncService 是重逻辑，单独测试；这里 mock 掉以聚焦"登录 → 自动拉取"编排
const h = vi.hoisted(() => ({
  pullAll: vi.fn(async () => ({ ok: true as const, data: { settings: { applied: true, revision: 1 }, memories: { fetched: 0, imported: 0, updated: 0 }, stats: null, warnings: [] } })),
  pushAll: vi.fn(async () => ({ ok: true as const, data: { settings: { pushed: true, revision: 2 }, memories: { submitted: 0, created: 0, updated: 0 }, stats: { submitted: 0, accepted: 0, since: 0 }, warnings: [] } })),
  exportBackup: vi.fn(),
  restoreBackup: vi.fn(),
}));

vi.mock('@/services/syncService', () => ({
  pullAll: h.pullAll,
  pushAll: h.pushAll,
  exportBackup: h.exportBackup,
  restoreBackup: h.restoreBackup,
}));

const fetchMock = vi.fn();

/** 同时兼容 serverApi（res.text()）与 api.ts（res.json()）两种解析方式 */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: new Headers(),
  } as unknown as Response;
}

/** 按 URL 片段路由请求；未命中返回 404 */
function routeFetch(handlers: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    for (const [fragment, body] of Object.entries(handlers)) {
      if (url.includes(fragment)) return jsonResponse(200, body);
    }
    return jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: url } });
  });
}

const USER = {
  id: 'u1', email: 'me@example.com', displayName: '我',
  status: 'active', createdAt: '2026-10-01T00:00:00.000Z', lastLoginAt: '2026-10-02T00:00:00.000Z',
};
const TOKENS = {
  tokenType: 'Bearer', accessToken: 'acc-1', refreshToken: 'ref-1',
  expiresIn: 900, accessExpiresAt: Date.now() + 900_000,
  refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

async function freshStore() {
  vi.resetModules();
  const mod = await import('../../Client/src/stores/accountStore');
  mod.useAccountStore.getState().__resetForTest();
  return mod.useAccountStore;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  h.pullAll.mockClear();
  h.pushAll.mockClear();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('验证码登录流程（FE-031）', () => {
  it('发送验证码：阶段流转并透传 devCode/有效期', async () => {
    const store = await freshStore();
    routeFetch({
      '/v1/auth/send-code': { ok: true, data: { success: true, expiresIn: 300, devCode: '246810' } },
    });

    const ok = await store.getState().sendCode('new@example.com');

    expect(ok).toBe(true);
    expect(store.getState().loginPhase).toBe('code_sent');
    expect(store.getState().loginEmail).toBe('new@example.com');
    expect(store.getState().codeExpiresIn).toBe(300);
    expect(store.getState().devCode).toBe('246810');
  });

  it('验证码登录成功：status=authenticated（守卫放行）+ 自动拉取 + 令牌单一真源', async () => {
    const store = await freshStore();
    routeFetch({
      '/v1/auth/send-code': { ok: true, data: { success: true, expiresIn: 300 } },
      '/v1/auth/login-with-code': { ok: true, data: { user: USER, tokens: TOKENS, isNewUser: false } },
      '/v1/me/sessions': { ok: true, data: { sessions: [] } },
      '/v1/me': { ok: true, data: USER },
      '/api/account/active-user': { ok: true, data: { owner: 'u1', changed: true } },
      '/api/sessions': { ok: true, data: [] },
    });

    await store.getState().sendCode('new@example.com');
    const ok = await store.getState().loginWithCode('new@example.com', '246810', '新用户');
    expect(ok).toBe(true);

    // ① 守卫放行：应用内"已登录"判定的唯一依据
    expect(store.getState().status).toBe('authenticated');
    expect(store.getState().user?.id).toBe('u1');
    expect(store.getState().loginPhase).toBe('authenticated');

    // ② 令牌落安全存储（与密码登录同一键，单键存整个令牌对象）
    expect(window.sessionStorage.getItem('civitas.secure.civitas.account.tokens')).toContain('acc-1');

    // ③ 自动拉取（FE-031 修复点：验证码路径此前漏做）
    expect(h.pullAll).toHaveBeenCalledTimes(1);

    // ④ 设备凭据随请求发送（FE-033：安装期稳定凭据，替代易变硬件指纹）
    const loginCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/auth/login-with-code'));
    const body = JSON.parse(String((loginCall?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.deviceId).toMatch(/^install-/);
    expect(String(body.deviceCredential).length).toBeGreaterThan(10);
    expect(String(body.deviceLabel)).toContain('Civitas Desktop');
    expect(body.displayName).toBe('新用户');

    // ⑤ 单一令牌真源：登录后鉴权请求直接可用（旧实现需重新 init() 读同一 key 桥接）
    await store.getState().refreshProfile();
    expect(store.getState().user?.email).toBe('me@example.com');
    const meCall = fetchMock.mock.calls.find(
      (c) => String(c[0]).includes('/v1/me') && !String(c[0]).includes('/sessions'),
    );
    expect((meCall?.[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer acc-1' });
  });

  it('验证码错误：回到验证码步骤、状态保持匿名、不写令牌', async () => {
    const store = await freshStore();
    routeFetch({
      '/v1/auth/send-code': { ok: true, data: { success: true, expiresIn: 300 } },
      '/v1/auth/login-with-code': { ok: false, error: { code: 'INVALID_CODE', message: '验证码不正确' } },
    });

    await store.getState().sendCode('new@example.com');
    const ok = await store.getState().loginWithCode('new@example.com', '000000');

    expect(ok).toBe(false);
    expect(store.getState().loginPhase).toBe('code_sent');
    expect(store.getState().lastError).toBe('验证码不正确');
    expect(store.getState().status).not.toBe('authenticated');
    expect(window.sessionStorage.getItem('civitas.secure.civitas.account.tokens')).toBeNull();
    // 失败不触发拉取
    expect(h.pullAll).not.toHaveBeenCalled();
  });

  it('resetLoginFlow 与登出：验证码流程归零', async () => {
    const store = await freshStore();
    routeFetch({
      '/v1/auth/send-code': { ok: true, data: { success: true, expiresIn: 300, devCode: '111111' } },
      '/v1/auth/login-with-code': { ok: true, data: { user: USER, tokens: TOKENS, isNewUser: false } },
      '/v1/auth/logout': { ok: true, data: { revoked: 1 } },
      '/v1/me/sessions': { ok: true, data: { sessions: [] } },
      '/api/account/active-user': { ok: true, data: { owner: 'u1', changed: true } },
      '/api/sessions': { ok: true, data: [] },
    });

    // "更换邮箱" → 重置回第一步
    await store.getState().sendCode('new@example.com');
    expect(store.getState().loginPhase).toBe('code_sent');
    store.getState().resetLoginFlow();
    expect(store.getState().loginPhase).toBe('idle');
    expect(store.getState().loginEmail).toBe('');
    expect(store.getState().devCode).toBeNull();

    // 登录 → 登出：验证码流程一并归零
    await store.getState().loginWithCode('new@example.com', '246810');
    expect(store.getState().loginPhase).toBe('authenticated');

    await store.getState().logout(false);
    expect(store.getState().status).toBe('anonymous');
    expect(store.getState().loginPhase).toBe('idle');
    expect(store.getState().loginEmail).toBe('');
    expect(window.sessionStorage.getItem('civitas.secure.civitas.account.tokens')).toBeNull();
  });
});
