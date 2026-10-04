/**
 * API 服务层——Docs/Client/02 F1.2。
 * 原生 fetch 封装：超时、错误分类、统一 Result<T>。
 * 视图层禁止直接调用 fetch，一律经本模块。
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
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timer);

    // 429 限流处理——通知 UI + 自动等待 Retry-After 后重试一次
    if (res.status === 429 && retryOnRateLimit) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
      useSystemStore.getState().setRateLimited(retryAfter);
      await new Promise(r => setTimeout(r, Math.min(retryAfter * 1000, 30_000)));
      // 重试一次（不再递归重试）
      return api<T>(path, { ...options, retryOnRateLimit: false });
    }

    const json = await res.json() as { ok: boolean; data?: T; error?: string };

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
        error.retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
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
