/**
 * @module services/serverApi
 * @description
 * **服务端**（`Server/`，默认 `http://127.0.0.1:8787`）HTTP 客户端。
 *
 * 与 `api.ts`（本地进程内服务）的区别：
 *  - 需要 Bearer 访问令牌；访问令牌过期时用刷新令牌**自动续期并重试一次**（单飞，避免并发风暴）
 *  - 统一解析服务端响应约定 `{ok,data}` / `{ok:false,error:{code,message,details}}`
 *  - 令牌相关错误（`TOKEN_REUSED`/`UNAUTHENTICATED` 且刷新失败）→ 通过回调通知上层清空登录态
 *
 * 依赖倒置：本模块**不 import 任何 store**，由 `accountStore` 在初始化时注入
 * `getTokens` / `refresh` / `onAuthLost`，从而避免循环依赖并便于测试。
 */

// ── 类型 ────────────────────────────────────────────────────────────

export interface ServerTokens {
  tokenType: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  accessExpiresAt: number;
  refreshExpiresAt: string;
}

export interface ServerError {
  code: string;
  message: string;
  status?: number;
  details?: unknown;
}

export type ServerResult<T> = { ok: true; data: T } | { ok: false; error: ServerError };

export interface ServerUser {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
  /** 绑定的设备 ID（null 表示未绑定） */
  boundDeviceId?: string | null;
}

export interface ServerSession {
  sessionId: string;
  deviceLabel: string | null;
  userAgent: string | null;
  ip: string | null;
  issuedAt: string;
  expiresAt: string;
}

/** 登录设备（安装期设备凭据；严格设备模式下的解绑对象，FE-033） */
export interface ServerDevice {
  deviceId: string;
  label: string | null;
  kind: string;
  ip: string | null;
  userAgent: string | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  isPrimary: boolean;
}

export interface AuthPayload {
  user: ServerUser;
  tokens: ServerTokens;
}

// ── 配置 ────────────────────────────────────────────────────────────

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 15_000;

let baseUrl = DEFAULT_SERVER_URL;

/** 规范化服务端地址：补协议、去尾斜杠、去空白 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return DEFAULT_SERVER_URL;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

export function setServerBaseUrl(url: string): string {
  baseUrl = normalizeServerUrl(url);
  return baseUrl;
}

export function getServerBaseUrl(): string {
  return baseUrl;
}

// ── 鉴权钩子（由 accountStore 注入）─────────────────────────────────

export interface ServerAuthHooks {
  /** 取当前令牌（未登录返回 null） */
  getTokens: () => ServerTokens | null;
  /** 用刷新令牌换新令牌（成功返回新令牌；失败返回 null） */
  refresh: () => Promise<ServerTokens | null>;
  /** 登录态失效（刷新失败 / 令牌被重用） */
  onAuthLost: (reason: string) => void;
}

let authHooks: ServerAuthHooks | null = null;

export function configureServerAuth(hooks: ServerAuthHooks | null): void {
  authHooks = hooks;
}

// ── 核心请求 ────────────────────────────────────────────────────────

interface RequestOptions {
  body?: unknown;
  token?: string | null;
  timeoutMs?: number;
  /** 附加查询参数 */
  query?: Record<string, string | number | boolean | undefined>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/** Electron 主进程转发通道（规避渲染进程 CORS；打包后 file:// 同样可用） */
interface ElectronServerFetch {
  serverFetch(req: { method: string; url: string; headers?: Record<string, string>; body?: string }): Promise<
    { ok: true; status: number; body: string } | { ok: false; status: 0; error: string }
  >;
}

function electronServerFetch(): ElectronServerFetch | null {
  const api = (globalThis as { electronAPI?: Partial<ElectronServerFetch> }).electronAPI;
  return typeof api?.serverFetch === 'function' ? (api as ElectronServerFetch) : null;
}

/** 统一传输层：Electron 走主进程；浏览器/测试走原生 fetch */
async function transport(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
): Promise<{ status: number; text: string }> {
  const bridge = electronServerFetch();
  if (bridge) {
    const res = await bridge.serverFetch({
      method: init.method,
      url,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    if (!res.ok) throw new Error(res.error);
    return { status: res.status, text: res.body };
  }
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal,
  });
  return { status: res.status, text: await res.text() };
}

/** 单次请求（不涉及令牌续期） */
async function rawRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<ServerResult<T>> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

  try {
    const { status, text } = await transport(buildUrl(path, options.query), {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
    clearTimeout(timer);

    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        return {
          ok: false,
          error: { code: 'BAD_RESPONSE', message: `服务端返回非 JSON（HTTP ${status}）`, status },
        };
      }
    }

    // 服务端失败约定：{ ok:false, error:{...} }
    if (payload && typeof payload === 'object' && 'ok' in payload && (payload as { ok: boolean }).ok === false) {
      const err = (payload as { error?: { code?: string; message?: string; details?: unknown } }).error ?? {};
      return {
        ok: false,
        error: {
          code: err.code ?? 'UNKNOWN',
          message: err.message ?? `请求失败（HTTP ${status}）`,
          status,
          details: err.details,
        },
      };
    }

    if (status < 200 || status >= 300) {
      return { ok: false, error: { code: 'HTTP_ERROR', message: `HTTP ${status}`, status } };
    }

    // 成功约定：{ ok:true, data } ；兼容无外壳的裸响应（如 /v1/backup/download）
    if (payload && typeof payload === 'object' && 'ok' in payload && (payload as { ok: boolean }).ok === true) {
      return { ok: true, data: (payload as unknown as { data: T }).data };
    }
    return { ok: true, data: payload as T };
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    return {
      ok: false,
      error: aborted
        ? { code: 'TIMEOUT', message: `请求超时（${timeoutMs}ms）` }
        : {
            code: 'NETWORK',
            message: `无法连接服务端 ${baseUrl}（请确认已启动且地址正确；浏览器模式还需服务端 CORS_ORIGINS 允许本页来源）`,
          },
    };
  }
}

/** 无需鉴权的请求（注册/登录/刷新/健康检查） */
export function serverRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<ServerResult<T>> {
  return rawRequest<T>(method, path, options);
}

/** 刷新令牌时应清除登录态的错误码 */
const FATAL_AUTH_CODES = new Set(['TOKEN_REUSED', 'UNAUTHENTICATED', 'INVALID_CREDENTIALS', 'FORBIDDEN']);

/** 是否需要用刷新令牌续期（访问令牌过期/无效） */
function needsRefresh(code: string, status?: number): boolean {
  if (code === 'TOKEN_EXPIRED') return true;
  if (code === 'UNAUTHENTICATED' && status === 401) return true;
  return false;
}

/** 单飞刷新：并发请求只触发一次续期 */
let refreshInFlight: Promise<ServerTokens | null> | null = null;

async function refreshOnce(): Promise<ServerTokens | null> {
  if (!authHooks) return null;
  if (!refreshInFlight) {
    refreshInFlight = authHooks
      .refresh()
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/**
 * 带鉴权的请求：自动附带访问令牌；遇到"令牌过期/无效"时刷新一次并重试。
 */
export async function authedRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<ServerResult<T>> {
  const tokens = authHooks?.getTokens() ?? null;
  if (!tokens) {
    return { ok: false, error: { code: 'NOT_LOGGED_IN', message: '尚未登录账号' } };
  }

  const first = await rawRequest<T>(method, path, { ...options, token: tokens.accessToken });
  if (first.ok) return first;

  if (!needsRefresh(first.error.code, first.error.status)) {
    if (FATAL_AUTH_CODES.has(first.error.code) && first.error.code !== 'UNAUTHENTICATED') {
      authHooks?.onAuthLost(first.error.code);
    }
    return first;
  }

  // 续期后重试一次
  const refreshed = await refreshOnce();
  if (!refreshed) {
    authHooks?.onAuthLost('refresh_failed');
    return {
      ok: false,
      error: { code: 'SESSION_EXPIRED', message: '登录已过期，请重新登录', status: 401 },
    };
  }

  const retry = await rawRequest<T>(method, path, { ...options, token: refreshed.accessToken });
  if (!retry.ok && FATAL_AUTH_CODES.has(retry.error.code)) {
    authHooks?.onAuthLost(retry.error.code);
  }
  return retry;
}

// ── 便捷方法 ────────────────────────────────────────────────────────

export const serverGet = <T>(path: string, query?: RequestOptions['query'], token?: string | null) =>
  token === undefined
    ? authedRequest<T>('GET', path, { query })
    : rawRequest<T>('GET', path, { query, token });

export const serverPost = <T>(path: string, body?: unknown, token?: string | null) =>
  token === undefined ? authedRequest<T>('POST', path, { body }) : rawRequest<T>('POST', path, { body, token });

export const serverPut = <T>(path: string, body?: unknown) => authedRequest<T>('PUT', path, { body });
export const serverPatch = <T>(path: string, body?: unknown) => authedRequest<T>('PATCH', path, { body });
export const serverDelete = <T>(path: string, query?: RequestOptions['query']) =>
  authedRequest<T>('DELETE', path, { query });
