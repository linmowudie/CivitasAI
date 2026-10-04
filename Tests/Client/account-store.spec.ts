/**
 * @vitest-environment jsdom
 *
 * 账号 store（accountStore）
 *
 * 关注：登录/登出状态流转、令牌安全存储读写、登录后自动拉取、
 * 上传冲突（revision）呈现、网络类失败入重试队列、登录态失效清理。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// syncService 是重逻辑，单独测试；这里 mock 掉以聚焦 store 行为
const h = vi.hoisted(() => ({
  pullAll: vi.fn(async () => ({ ok: true as const, data: { settings: { applied: true, revision: 1 }, memories: { fetched: 0, imported: 0, updated: 0 }, stats: null, warnings: [] } })),
  pushAll: vi.fn(async () => ({ ok: true as const, data: { settings: { pushed: true, revision: 2 }, memories: { submitted: 0, created: 0, updated: 0 }, stats: { submitted: 0, accepted: 0, since: 0 }, warnings: [] } })),
  exportBackup: vi.fn(async () => ({ ok: true as const, data: { format: 'civitas.backup', version: 1, exportedAt: '', settings: null, memories: [], stats: null } })),
  restoreBackup: vi.fn(async () => ({ ok: true as const, data: { memories: { created: 0, updated: 0 }, stats: { accepted: 0 } } })),
}));

vi.mock('@/services/syncService', () => ({
  pullAll: h.pullAll,
  pushAll: h.pushAll,
  exportBackup: h.exportBackup,
  restoreBackup: h.restoreBackup,
}));

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
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

describe('账号 store', () => {
  it('登录成功：状态置为已登录、令牌写入安全存储、并自动拉取', async () => {
    const store = await freshStore();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: { user: USER, tokens: TOKENS } }));

    const ok = await store.getState().login({ email: 'me@example.com', password: 'Passw0rd123' });

    expect(ok).toBe(true);
    expect(store.getState().status).toBe('authenticated');
    expect(store.getState().user?.email).toBe('me@example.com');
    // 令牌落盘（测试环境降级为 sessionStorage）
    expect(window.sessionStorage.getItem('civitas.secure.civitas.account.tokens')).toContain('acc-1');
    // 登录后自动拉取
    expect(h.pullAll).toHaveBeenCalledTimes(1);
  });

  it('登录失败：保持匿名并给出错误文案（不写令牌）', async () => {
    const store = await freshStore();
    fetchMock.mockResolvedValue(
      jsonResponse(401, { ok: false, error: { code: 'INVALID_CREDENTIALS', message: '邮箱或密码不正确' } }),
    );

    const ok = await store.getState().login({ email: 'me@example.com', password: 'bad' });

    expect(ok).toBe(false);
    expect(store.getState().status).toBe('anonymous');
    expect(store.getState().lastError).toBe('邮箱或密码不正确');
    expect(window.sessionStorage.getItem('civitas.secure.civitas.account.tokens')).toBeNull();
  });

  it('init：存在令牌且 /v1/me 通过 → 恢复登录态', async () => {
    window.sessionStorage.setItem('civitas.secure.civitas.account.tokens', JSON.stringify(TOKENS));
    const store = await freshStore();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: USER }));

    await store.getState().init();

    expect(store.getState().ready).toBe(true);
    expect(store.getState().status).toBe('authenticated');
    expect(store.getState().user?.id).toBe('u1');
  });

  it('init：令牌已失效（/v1/me 401 且刷新失败）→ 回落匿名并清理令牌', async () => {
    window.sessionStorage.setItem('civitas.secure.civitas.account.tokens', JSON.stringify(TOKENS));
    const store = await freshStore();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/v1/auth/refresh')) {
        return jsonResponse(401, { ok: false, error: { code: 'TOKEN_REUSED', message: '重复使用' } });
      }
      return jsonResponse(200, { ok: true, data: USER });
    });
    // /v1/me 返回 401 TOKEN_EXPIRED → 触发刷新 → 刷新失败
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/v1/auth/refresh')) {
        return jsonResponse(401, { ok: false, error: { code: 'TOKEN_REUSED', message: '重复使用' } });
      }
      if (String(url).includes('/v1/me')) {
        return jsonResponse(401, { ok: false, error: { code: 'TOKEN_EXPIRED', message: '过期' } });
      }
      return jsonResponse(200, { ok: true, data: {} });
    });

    await store.getState().init();

    expect(store.getState().ready).toBe(true);
    expect(store.getState().status).toBe('anonymous');
    expect(store.getState().user).toBeNull();
    // onAuthLost 已清理令牌
    expect(window.sessionStorage.getItem('civitas.secure.civitas.account.tokens')).toBeNull();
  });

  it('登出：调用服务端登出并清空本地状态与令牌', async () => {
    const store = await freshStore();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: { user: USER, tokens: TOKENS } }));
    await store.getState().login({ email: 'me@example.com', password: 'Passw0rd123' });

    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: { revoked: 1 } }));
    const ok = await store.getState().logout(false);

    expect(ok).toBe(true);
    expect(store.getState().status).toBe('anonymous');
    expect(store.getState().user).toBeNull();
    expect(window.sessionStorage.getItem('civitas.secure.civitas.account.tokens')).toBeNull();
    // 服务端登出被调用
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/auth/logout'))).toBe(true);
  });

  it('上传冲突（REVISION_MISMATCH）→ 记录冲突供 UI 让用户选择', async () => {
    const store = await freshStore();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: { user: USER, tokens: TOKENS } }));
    await store.getState().login({ email: 'me@example.com', password: 'Passw0rd123' });

    h.pushAll.mockResolvedValueOnce({
      ok: false,
      error: { code: 'REVISION_MISMATCH', message: '设置已被其他设备修改', details: { currentRevision: 9 } },
    });

    const ok = await store.getState().push(false);
    expect(ok).toBe(false);
    expect(store.getState().conflict?.currentRevision).toBe(9);

    // 冲突不进入重试队列（重试无意义）
    expect(store.getState().pending).toHaveLength(0);

    // 用户选择"以本机为准" → force=true
    h.pushAll.mockResolvedValueOnce({
      ok: true,
      data: { settings: { pushed: true, revision: 10 }, memories: { submitted: 0, created: 0, updated: 0 }, stats: { submitted: 0, accepted: 0, since: 0 }, warnings: [] },
    });
    await store.getState().push(true);
    expect(h.pushAll).toHaveBeenLastCalledWith({ force: true });
    expect(store.getState().conflict).toBeNull();
  });

  it('拉取遇到网络错误 → 进入重试队列（可手动重试）', async () => {
    const store = await freshStore();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: { user: USER, tokens: TOKENS } }));
    await store.getState().login({ email: 'me@example.com', password: 'Passw0rd123' });

    h.pullAll.mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK', message: '无法连接服务端' } });
    const ok = await store.getState().pull();

    expect(ok).toBe(false);
    expect(store.getState().pending).toHaveLength(1);
    expect(store.getState().pending[0]?.type).toBe('pull');

    // 手动重试成功后队列清空
    h.pullAll.mockResolvedValueOnce({
      ok: true,
      data: { settings: { applied: true, revision: 1 }, memories: { fetched: 2, imported: 2, updated: 0 }, stats: null, warnings: [] },
    });
    await store.getState().retryPending();
    expect(store.getState().pending).toHaveLength(0);
    expect(store.getState().lastPull?.memories.imported).toBe(2);
  });

  it('4xx（非网络类）失败不入重试队列', async () => {
    const store = await freshStore();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: { user: USER, tokens: TOKENS } }));
    await store.getState().login({ email: 'me@example.com', password: 'Passw0rd123' });

    h.pullAll.mockResolvedValueOnce({ ok: false, error: { code: 'VALIDATION_ERROR', message: '参数错误' } });
    await store.getState().pull();
    expect(store.getState().pending).toHaveLength(0);
    expect(store.getState().lastError).toBe('参数错误');
  });

  it('测试连接：/healthz 与 /readyz 都通过才算就绪', async () => {
    const store = await freshStore();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { status: 'ok', uptimeSec: 5 } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { status: 'ready', db: 'up' } }));

    const probe = await store.getState().testConnection();
    expect(probe.ok).toBe(true);
    expect(probe.message).toContain('连接正常');

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { status: 'ok', uptimeSec: 5 } }))
      .mockResolvedValueOnce(jsonResponse(503, { ok: false, error: { code: 'INTERNAL', message: '数据库不可用' } }));
    const bad = await store.getState().testConnection();
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('未就绪');
  });
});
