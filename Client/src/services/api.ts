/**
 * API 服务层——Docs/Client/02 F1.2。
 * 原生 fetch 封装：超时、错误分类、统一 Result<T>。
 * 视图层禁止直接调用 fetch，一律经本模块。
 *
 * 2026-10-06（安装包改造）：桌面端打包后页面来源是 `file://`，
 * 相对路径 `fetch('/api/...')` 会解析成 `file:///api/...` 必然失败。
 * 因此在 Electron 环境下把 `/api/*` 请求经主进程 `serverFetch` 转发
 * （Node fetch 无 CORS/来源限制）；浏览器与测试环境仍走原生 fetch。
 */

import { useSystemStore } from '@/stores/systemStore';

// ── 类型 ────────────────────────────────────────────────────────────

export type ApiErrorType = 'network' | 'timeout' | '4xx' | '5xx' | 'rate_limited' | 'unknown';

export interface ApiError {
  type: ApiErrorType;
  message: string;
  status?: number;
  /** 429 限流时的重试等待秒数 */
  retryAfter?: number;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

// ── 配置 ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;

// ── 传输层：Electron 主进程转发 ─────────────────────────────────────

/** electronAPI 的 serverFetch 通道（preload 暴露；浏览器/测试环境为 undefined） */
interface ElectronTransport {
  getServerPorts: () => Promise<{ httpPort: number } | null>;
  serverFetch: (req: { method: string; url: string; headers?: Record<string, string>; body?: string }) =>
    Promise<{ ok: true; status: number; body: string } | { ok: false; status: 0; error: string }>;
}

function electronTransport(): ElectronTransport | null {
  const api = (globalThis as { window?: { electronAPI?: ElectronTransport } }).window?.electronAPI;
  if (!api) return null;
  return typeof api.serverFetch === 'function' && typeof api.getServerPorts === 'function' ? api : null;
}

/** 后端基址缓存（undefined=未解析，null=不可用） */
let cachedBaseUrl: string | null | undefined;

async function resolveBackendBaseUrl(): Promise<string | null> {
  if (cachedBaseUrl !== undefined) return cachedBaseUrl;
  const transport = electronTransport();
  if (!transport) {
    cachedBaseUrl = null;
    return null;
  }
  try {
    const ports = await transport.getServerPorts();
    cachedBaseUrl = ports?.httpPort ? `http://127.0.0.1:${ports.httpPort}` : null;
  } catch {
    cachedBaseUrl = null;
  }
  return cachedBaseUrl;
}

/** 统一响应视图：屏蔽 fetch Response 与 IPC 转发的差异 */
interface ApiResponseLike {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  header: (name: string) => string | null;
}

async function requestViaElectron(
  baseUrl: string,
  path: string,
  method: string,
  headers: Record<string, string> | undefined,
  body: string | undefined,
  signal: AbortSignal,
): Promise<ApiResponseLike> {
  const transport = electronTransport();
  if (!transport) throw new Error('Electron 传输通道不可用');

  // 主进程 fetch 不支持 AbortSignal：这里用"超时后忽略结果"的方式保持调用方语义
  const raceAbort = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });

  const result = await Promise.race([
    transport.serverFetch({ method, url: `${baseUrl}${path}`, headers, body }),
    raceAbort,
  ]);

  if (!result.ok) {
    throw new Error(result.error || '网络错误');
  }
  return {
    status: result.status,
    ok: result.status >= 200 && result.status < 300,
    text: async () => result.body,
    header: () => null, // 主进程未回传响应头；429 的重试等待退化为默认值
  };
}

// ── 核心请求函数 ────────────────────────────────────────────────────

export async function api<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    body?: unknown;
    timeoutMs?: number;
    /** 是否自动重试 429（默认 true，仅重试一次） */
    retryOnRateLimit?: boolean;
  } = {},
): Promise<ApiResult<T>> {
  const { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, retryOnRateLimit = true } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const reqHeaders = body ? { 'Content-Type': 'application/json' } : undefined;
    const reqBody = body ? JSON.stringify(body) : undefined;

    // 桌面端：相对 `/api/*` 经主进程转发（规避 file:// 与 CORS）
    let res: ApiResponseLike;
    const baseUrl = path.startsWith('/') ? await resolveBackendBaseUrl() : null;
    if (baseUrl) {
      res = await requestViaElectron(baseUrl, path, method, reqHeaders, reqBody, controller.signal);
    } else {
      const raw = await fetch(path, {
        method,
        headers: reqHeaders,
        body: reqBody,
        signal: controller.signal,
      });
      res = {
        status: raw.status,
        ok: raw.ok,
        // 真实 Response 一定有 text()；测试里的轻量 mock 可能只提供 json()，
        // 这里两种都兼容，避免"mock 形状"决定业务成败
        text: async () => {
          if (typeof raw.text === 'function') return raw.text();
          const asJson = (raw as unknown as { json?: () => Promise<unknown> }).json;
          return typeof asJson === 'function' ? JSON.stringify(await asJson()) : '';
        },
        header: (name: string) => raw.headers?.get?.(name) ?? null,
      };
    }

    clearTimeout(timer);

    // 429 限流处理——通知 UI + 自动等待 Retry-After 后重试一次
    if (res.status === 429 && retryOnRateLimit) {
      const retryAfter = parseInt(res.header('Retry-After') ?? '5', 10);
      useSystemStore.getState().setRateLimited(retryAfter);
      await new Promise(r => setTimeout(r, Math.min(retryAfter * 1000, 30_000)));
      // 重试一次（不再递归重试）
      return api<T>(path, { ...options, retryOnRateLimit: false });
    }

    const json = JSON.parse(await res.text()) as { ok: boolean; data?: T; error?: string };

    if (!res.ok || !json.ok) {
      const type: ApiErrorType =
        res.status === 429 ? 'rate_limited'
        : res.status >= 500 ? '5xx'
        : res.status >= 400 ? '4xx'
        : 'unknown';
      const error: ApiError = {
        type,
        message: json.error ?? `HTTP ${res.status}`,
        status: res.status,
      };
      if (res.status === 429) {
        error.retryAfter = parseInt(res.header('Retry-After') ?? '5', 10);
      }
      return { ok: false, error };
    }

    return { ok: true, data: json.data as T };
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, error: { type: 'timeout', message: `请求超时 (${timeoutMs}ms)` } };
    }
    return { ok: false, error: { type: 'network', message: e instanceof Error ? e.message : '网络错误' } };
  }
}

// ── 便捷方法 ────────────────────────────────────────────────────────

export const apiGet = <T>(path: string) => api<T>(path);
export const apiPost = <T>(path: string, body: unknown) => api<T>(path, { method: 'POST', body });
export const apiPut = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const apiPatch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const apiDelete = <T>(path: string) => api<T>(path, { method: 'DELETE' });
