/**
 * FE-041 验收：HTTP 链路请求头透传（2026-10-04）
 *
 * 背景：`handleRequest({method,url,body})` 构造点未透传 headers，
 * 导致 `approvalApi` 的 `extractBearerToken(req.headers)` 恒为 null ——
 * G-09 方案 B（服务端令牌验真）在真实 HTTP 链路上永不生效（死代码）。
 *
 * 覆盖：
 *  1. webServer.handleRequest 将 headers 传入 ApiRequest（路由处理器可读到）；
 *  2. 真实 httpServer 往返：Authorization 头到达处理器；
 *  3. CORS 预检响应允许 Authorization / X-Account-Token（浏览器跨域可携带）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { startHttpServer, stopHttpServer } from '../../Src/Interface/WebServer/httpServer.js';
import { handleRequest } from '../../Src/Interface/WebServer/webServer.js';
import { registerRoute, json, clearRoutes } from '../../Src/Interface/RestApi/router.js';

const ECHO_PATH = '/api/_test/echo-headers';
const TEST_PORT = 14041;
const ORIGIN = 'http://localhost:5173';

/** 等待真实 HTTP 服务器就绪（listen 是异步的，startHttpServer 立即 resolve） */
async function waitForServer(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${TEST_PORT}${ECHO_PATH}`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 30));
    }
  }
  throw new Error('httpServer 未在预期时间内就绪');
}

describe('FE-041 HTTP 链路请求头透传', () => {
  beforeAll(async () => {
    clearRoutes();
    registerRoute('GET', ECHO_PATH, async (req) => json({ received: req.headers ?? null }));
    await startHttpServer({ host: '127.0.0.1', port: TEST_PORT, corsOrigins: [ORIGIN] });
  });

  afterAll(async () => {
    await stopHttpServer();
    clearRoutes();
  });

  it('webServer.handleRequest 将 headers 透传到 ApiRequest', async () => {
    const resp = await handleRequest({
      method: 'GET',
      url: ECHO_PATH,
      headers: { authorization: 'Bearer unit-token', 'x-account-token': 'acc-1' },
    });
    expect(resp.status).toBe(200);
    const received = (resp.body as { data: { received: Record<string, string> } }).data.received;
    expect(received['authorization']).toBe('Bearer unit-token');
    expect(received['x-account-token']).toBe('acc-1');
  });

  it('未提供 headers 时行为不变（向后兼容）', async () => {
    const resp = await handleRequest({ method: 'GET', url: ECHO_PATH });
    expect(resp.status).toBe(200);
    const received = (resp.body as { data: { received: Record<string, string> | null } }).data.received;
    expect(received).toBeNull();
  });

  it('真实 httpServer 往返：Authorization 头到达处理器（方案 B 不再死代码）', async () => {
    await waitForServer();
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}${ECHO_PATH}`, {
      headers: { Authorization: 'Bearer e2e-token' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { received: Record<string, string> } };
    expect(body.data.received['authorization']).toBe('Bearer e2e-token');
  });

  it('X-Account-Token 同样到达处理器', async () => {
    await waitForServer();
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}${ECHO_PATH}`, {
      headers: { 'X-Account-Token': 'acc-token-42' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { received: Record<string, string> } };
    expect(body.data.received['x-account-token']).toBe('acc-token-42');
  });

  it('CORS 预检允许 Authorization / X-Account-Token', async () => {
    await waitForServer();
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}${ECHO_PATH}`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(204);
    const allow = res.headers.get('access-control-allow-headers') ?? '';
    expect(allow).toContain('Authorization');
    expect(allow).toContain('X-Account-Token');
  });
});
