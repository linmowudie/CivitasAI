/**
 * @module test/helpers/app
 * @description 测试用应用构建与轻量客户端封装（基于 fastify.inject，无需监听端口）。
 */

import type { FastifyInstance } from 'fastify';
import { buildApp, type AppContext } from '../../src/app.js';
import type { ServerConfig } from '../../src/config.js';
import type { Db } from '../../src/db/pool.js';
import { createRateLimiter, type RateLimiter } from '../../src/http/rateLimit.js';

/** 测试配置：短时效、宽松限流（需要严格限流的用例自行注入限流器） */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const base: ServerConfig = {
    env: 'test',
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://unused',
    db: { poolMax: 5, idleTimeoutMs: 1_000, connectionTimeoutMs: 1_000, statementTimeoutMs: 10_000 },
    auth: {
      jwtSecret: 'test-secret-test-secret-test-secret-1234',
      accessTokenTtlSec: 900,
      refreshTokenTtlDays: 30,
      allowRefreshReuse: false,
      deviceBindingMode: 'warn',
      /** 测试默认开启：便于断言验证码流程（生产会被 config 拒绝） */
      allowDevCode: true,
      codeTtlSec: 300,
      codeMaxPerWindow: 3,
      codeWindowSec: 600,
      codeResendCooldownSec: 0,
      codeMaxAttempts: 5,
    },
    mail: {
      webhookUrl: '',
      from: 'Civitas Test <no-reply@test.local>',
      timeoutMs: 2000,
    },
    limits: {
      authPerMin: 10_000,
      apiPerMin: 10_000,
      writePerMin: 10_000,
      bodyLimitBytes: 1024 * 1024,
      maxSettingsBytes: 4096,
      maxMemoriesPerBulk: 100,
      maxStatsEventsPerBatch: 50,
    },
    corsOrigins: [],
    logLevel: 'silent',
    statsTimezone: 'Asia/Shanghai',
    trustProxy: false,
    // 测试默认进程内限流（PG 共享计数见 rateLimitStore.spec.ts）
    rateLimitStore: 'memory',
  };
  return {
    ...base,
    ...overrides,
    auth: { ...base.auth, ...overrides.auth },
    mail: { ...base.mail, ...overrides.mail },
    limits: { ...base.limits, ...overrides.limits },
  };
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  rateLimiter: RateLimiter;
  close(): Promise<void>;
}

export async function buildTestApp(db: Db, options: { cfg?: ServerConfig } = {}): Promise<TestApp> {
  const cfg = options.cfg ?? testConfig();
  // 仅"进程内限流"注入测试限流器；配置为 postgres（共享计数，SV-003）时
  // 让 buildApp 按配置自行构造，避免测试覆盖真实路径。
  const injectMemoryLimiter = cfg.rateLimitStore !== 'postgres';
  const rateLimiter = createRateLimiter({ cleanupIntervalMs: 0 });
  const { app, ctx } = buildApp({
    cfg,
    db,
    disableLogger: true,
    ...(injectMemoryLimiter ? { rateLimiter } : {}),
  });
  await app.ready();
  return {
    app,
    ctx,
    rateLimiter,
    async close() {
      await app.close();
      rateLimiter.dispose();
    },
  };
}

// ── 轻量客户端 ──────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  status: number;
  body: { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: unknown } };
  headers: Record<string, string | string[] | number | undefined>;
}

/** 读取响应头（大小写不敏感；缺失时 undefined） */
export function headerOf(res: ApiResponse<unknown>, name: string): string | undefined {
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(res.headers)) {
    if (k.toLowerCase() === key) return Array.isArray(v) ? v[0] : v === undefined ? undefined : String(v);
  }
  return undefined;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  accessExpiresAt: number;
  refreshExpiresAt: string;
  tokenType: string;
}

export interface AuthedUser {
  user: { id: string; email: string; displayName: string | null };
  tokens: TokenPair;
}

export function createClient(app: FastifyInstance) {
  async function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options: { payload?: unknown; token?: string; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token) headers['authorization'] = `Bearer ${options.token}`;
    const res = await app.inject({
      method,
      url,
      headers,
      ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
    });
    let body: ApiResponse<T>['body'];
    try {
      body = JSON.parse(res.body) as ApiResponse<T>['body'];
    } catch {
      body = { ok: false, error: { code: 'PARSE_ERROR', message: res.body } };
    }
    return { status: res.statusCode, body, headers: res.headers };
  }

  return {
    request,
    get: <T>(url: string, token?: string) => request<T>('GET', url, { token }),
    post: <T>(url: string, payload?: unknown, token?: string) =>
      request<T>('POST', url, { payload, token }),
    put: <T>(url: string, payload?: unknown, token?: string) =>
      request<T>('PUT', url, { payload, token }),
    patch: <T>(url: string, payload?: unknown, token?: string) =>
      request<T>('PATCH', url, { payload, token }),
    del: <T>(url: string, token?: string) => request<T>('DELETE', url, { token }),

    /** 注册并返回令牌 */
    async register(email: string, password = 'Passw0rd123', displayName?: string): Promise<AuthedUser> {
      const res = await request<AuthedUser>('POST', '/v1/auth/register', {
        payload: { email, password, ...(displayName ? { displayName } : {}) },
      });
      if (res.status !== 201 || !res.body.ok) {
        throw new Error(`注册失败: ${res.status} ${JSON.stringify(res.body)}`);
      }
      return res.body.data;
    },

    async login(email: string, password = 'Passw0rd123'): Promise<ApiResponse<AuthedUser>> {
      return request<AuthedUser>('POST', '/v1/auth/login', { payload: { email, password } });
    },
  };
}

export type TestClient = ReturnType<typeof createClient>;

/** 断言辅助：取出成功响应的 data（失败时给出可读错误） */
export function dataOf<T>(res: ApiResponse<T>): T {
  if (!res.body.ok) {
    throw new Error(`期望成功响应，实际 ${res.status}: ${JSON.stringify(res.body.error)}`);
  }
  return res.body.data;
}

/** 断言辅助：取出错误码 */
export function errorCodeOf(res: ApiResponse<unknown>): string {
  return res.body.ok ? '' : res.body.error.code;
}
