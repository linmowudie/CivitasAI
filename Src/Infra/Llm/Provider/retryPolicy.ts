/**
 * 重试策略（Docs/02 §10.2）
 *
 * 根据错误分类决定重试次数和退避时间。
 */

import type { ErrorCategory } from '../Provider/providerBase.js';

// ===== 类型定义 =====

/** 重试决策 */
export interface RetryDecision {
  readonly shouldRetry: boolean;
  readonly maxRetries: number;
  readonly backoffMs: number[];
  readonly fallbackToNext: boolean;
}

// ===== 重试矩阵（Docs/02 §10.2）=====

const RETRY_MATRIX: Record<ErrorCategory, RetryDecision> = {
  auth: {
    shouldRetry: false,
    maxRetries: 0,
    backoffMs: [],
    fallbackToNext: false,
  },
  content_blocked: {
    shouldRetry: false,
    maxRetries: 0,
    backoffMs: [],
    fallbackToNext: false,
  },
  rate_limited: {
    shouldRetry: true,
    maxRetries: 1,
    backoffMs: [5000],
    fallbackToNext: true,
  },
  server_error: {
    shouldRetry: true,
    maxRetries: 2,
    backoffMs: [1000, 2000],
    fallbackToNext: false,
  },
  unavailable: {
    shouldRetry: true,
    maxRetries: 1,
    backoffMs: [0],
    fallbackToNext: true,
  },
  network: {
    shouldRetry: true,
    maxRetries: 2,
    backoffMs: [1000, 2000],
    fallbackToNext: false,
  },
  timeout: {
    shouldRetry: true,
    maxRetries: 2,
    backoffMs: [1000, 2000],
    fallbackToNext: false,
  },
  format_error: {
    shouldRetry: true,
    maxRetries: 1,
    backoffMs: [0],
    fallbackToNext: false,
  },
  unknown: {
    shouldRetry: false,
    maxRetries: 0,
    backoffMs: [],
    fallbackToNext: false,
  },
};

// ===== 公开 API =====

/**
 * 获取重试决策
 */
export function getRetryDecision(category: ErrorCategory): RetryDecision {
  return RETRY_MATRIX[category] ?? RETRY_MATRIX.unknown;
}

/**
 * 延迟指定毫秒数
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

/**
 * 分类网络错误
 */
export function classifyNetworkError(error: Error): ErrorCategory {
  const msg = error.message.toLowerCase();
  if (msg.includes('econnreset') || msg.includes('etimedout') ||
      msg.includes('fetch failed') || msg.includes('enotfound') ||
      msg.includes('econnrefused')) {
    return 'network';
  }
  if (msg.includes('aborted') || error.name === 'AbortError') {
    return 'timeout';
  }
  return 'unknown';
}
