/**
 * 服务端 HTTP 客户端（serverApi）
 *
 * 重点验证：地址规范化、响应约定解析、错误分类、
 * 以及**访问令牌过期 → 自动刷新 → 重试一次**（含单飞，避免并发刷新风暴）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  authedRequest,
  configureServerAuth,
  getServerBaseUrl,
  normalizeServerUrl,
  serverRequest,
  setServerBaseUrl,
  type ServerTokens,
} from '../../Client/src/services/serverApi';

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

function tokensOf(access: string): ServerTokens {
  return {
    tokenType: 'Bearer',
    accessToken: access,
    refreshToken: `refresh-${access}`,
    expiresIn: 900,
    accessExpiresAt: Date.now() + 900_000,
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  configureServerAuth(null);
  setServerBaseUrl('http://127.0.0.1:8787');
});

describe('地址规范化', () => {
  it('补协议、去尾斜杠、空值回落默认', () => {
    expect(normalizeServerUrl('127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(normalizeServerUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    expect(normalizeServerUrl('https://api.example.com///')).toBe('https://api.example.com');
    expect(normalizeServerUrl('   ')).toBe('http://127.0.0.1:8787');
    setServerBaseUrl('api.example.com:9000');
    expect(getServerBaseUrl()).toBe('http://api.example.com:9000');
  });
});

describe('响应约定解析', () => {
  it('成功：解包 { ok:true, data }', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: { status: 'ok' } }));
    const res = await serverRequest<{ status: string }>('GET', '/healthz');
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.status).toBe('ok');
  });

  it('失败：透出 code/message/status/details', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, { ok: false, error: { code: 'REVISION_MISMATCH', message: '版本冲突', details: { currentRevision: 7 } } }),
    );
    const res = await serverRequest('PUT', '/v1/settings', { body: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('REVISION_MISMATCH');
      expect(res.error.status).toBe(409);
      expect((res.error.details as { currentRevision: number }).currentRevision).toBe(7);
    }
  });

  it('非 JSON 响应 → BAD_RESPONSE', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, text: async () => '<html>oops</html>', headers: new Headers(),
    } as unknown as Response);
    const res = await serverRequest('GET', '/healthz');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('BAD_RESPONSE');
  });

  it('网络异常 → NETWORK；AbortError → TIMEOUT', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const net = await serverRequest('GET', '/healthz');
    expect(!net.ok && net.error.code).toBe('NETWORK');

    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    const timeout = await serverRequest('GET', '/healthz');
    expect(!timeout.ok && timeout.error.code).toBe('TIMEOUT');
  });
});

describe('鉴权与自动续期', () => {
  it('未登录时直接返回 NOT_LOGGED_IN（不发请求）', async () => {
    configureServerAuth({ getTokens: () => null, refresh: async () => null, onAuthLost: () => {} });
    const res = await authedRequest('GET', '/v1/settings');
    expect(!res.ok && res.error.code).toBe('NOT_LOGGED_IN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('携带 Bearer 令牌', async () => {
    configureServerAuth({ getTokens: () => tokensOf('a1'), refresh: async () => null, onAuthLost: () => {} });
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: {} }));
    await authedRequest('GET', '/v1/settings');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer a1');
  });

  it('访问令牌过期 → 刷新一次并用新令牌重试成功', async () => {
    let refreshed = 0;
    configureServerAuth({
      getTokens: () => tokensOf('old'),
      refresh: async () => { refreshed++; return tokensOf('new'); },
      onAuthLost: () => {},
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { ok: false, error: { code: 'TOKEN_EXPIRED', message: '过期' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, data: { revision: 3 } }));

    const res = await authedRequest<{ revision: number }>('GET', '/v1/settings');
    expect(res.ok).toBe(true);
    expect(res.ok && res.data.revision).toBe(3);
    expect(refreshed).toBe(1);
    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((retryInit.headers as Record<string, string>)['Authorization']).toBe('Bearer new');
  });

  it('刷新失败 → 通知登录态失效并返回 SESSION_EXPIRED', async () => {
    const lost: string[] = [];
    configureServerAuth({
      getTokens: () => tokensOf('old'),
      refresh: async () => null,
      onAuthLost: (r) => lost.push(r),
    });
    fetchMock.mockResolvedValue(jsonResponse(401, { ok: false, error: { code: 'TOKEN_EXPIRED', message: '过期' } }));

    const res = await authedRequest('GET', '/v1/settings');
    expect(!res.ok && res.error.code).toBe('SESSION_EXPIRED');
    expect(lost).toEqual(['refresh_failed']);
  });

  it('令牌被重用（TOKEN_REUSED）→ 立即失效登录态，不重试', async () => {
    const lost: string[] = [];
    let refreshed = 0;
    configureServerAuth({
      getTokens: () => tokensOf('old'),
      refresh: async () => { refreshed++; return tokensOf('new'); },
      onAuthLost: (r) => lost.push(r),
    });
    fetchMock.mockResolvedValue(jsonResponse(401, { ok: false, error: { code: 'TOKEN_REUSED', message: '重复使用' } }));

    const res = await authedRequest('GET', '/v1/settings');
    expect(!res.ok && res.error.code).toBe('TOKEN_REUSED');
    expect(refreshed).toBe(0);
    expect(lost).toEqual(['TOKEN_REUSED']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('并发请求只触发一次刷新（单飞）', async () => {
    let refreshed = 0;
    configureServerAuth({
      getTokens: () => tokensOf('old'),
      refresh: async () => { refreshed++; await new Promise((r) => setTimeout(r, 10)); return tokensOf('new'); },
      onAuthLost: () => {},
    });
    // 两个并发请求都先拿 401，再各自重试成功
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>)['Authorization'];
      if (auth === 'Bearer old') {
        return jsonResponse(401, { ok: false, error: { code: 'TOKEN_EXPIRED', message: '过期' } });
      }
      return jsonResponse(200, { ok: true, data: { url } });
    });

    const [a, b] = await Promise.all([
      authedRequest('GET', '/v1/settings'),
      authedRequest('GET', '/v1/memories'),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(refreshed).toBe(1);
  });

  it('查询参数被正确编码追加', async () => {
    configureServerAuth({ getTokens: () => tokensOf('a1'), refresh: async () => null, onAuthLost: () => {} });
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: {} }));
    await authedRequest('GET', '/v1/stats/summary', { query: { from: '2026-03-01T00:00:00.000Z', kind: 'chat.turn' } });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/v1/stats/summary?');
    expect(url).toContain('kind=chat.turn');
    expect(url).toContain('from=2026-03-01');
  });
});
