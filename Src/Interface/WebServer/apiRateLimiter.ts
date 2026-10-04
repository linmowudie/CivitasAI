/**
 * @module Interface/WebServer/apiRateLimiter
 * @description
 * HTTP API 层限流中间件——基于 IP + session_key 的滑动窗口限流。
 *
 * 配置事实源：`Configs/supervision.json → supervision.apiRateLimit`（FE-040：独立键，
 * 与监管侧的 supervision.rateLimit 解耦——为 UI 放宽 API 额度不影响 Agent 监管阈值）。
 * 运行时通过 `initApiRateLimiter()` 注入配置。
 *
 * 返回标准 429 响应 + `Retry-After` 头，响应体包含：
 * `{ ok: false, error: 'rate_limited', retryAfter: number }`
 *
 * 设计依据：Docs/Agent/02 §3 步骤② 前置监管的频率限制在 HTTP 层的投影。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiRateLimitConfig } from '../../Infra/Contracts/rateLimitTypes.js';
import { DEFAULT_API_RATE_LIMIT_CONFIG } from '../../Infra/Contracts/rateLimitTypes.js';

// ── 滑动窗口计数器（IP 维度）───────────────────────────────────────

interface BucketEntry {
  count: number;
  windowStart: number;
}

// ── 模块级状态 ──────────────────────────────────────────────────────

let config: ApiRateLimitConfig = { ...DEFAULT_API_RATE_LIMIT_CONFIG };
const ipBuckets = new Map<string, BucketEntry>();

const WINDOW_MS = 60_000; // 固定 60 秒窗口

/** 初始化/更新 API 限流配置 */
export function initApiRateLimiter(overrides: Partial<ApiRateLimitConfig> = {}): void {
  config = { ...DEFAULT_API_RATE_LIMIT_CONFIG, ...overrides };
  ipBuckets.clear();
}

/** 获取客户端 IP（支持代理转发） */
function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** 检查并更新限，返回是否被限流 */
function checkAndUpdateLimit(clientKey: string): {
  limited: boolean;
  retryAfterSec: number;
  remaining: number;
} {
  const now = Date.now();
  const effectiveMax = Math.floor(config.maxRequestsPerMinute * config.burstAllowance);

  let entry = ipBuckets.get(clientKey);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    // 新窗口
    entry = { count: 0, windowStart: now };
    ipBuckets.set(clientKey, entry);
  }

  // 清理过期条目（防止内存泄漏）
  for (const [key, e] of ipBuckets.entries()) {
    if (now - e.windowStart >= WINDOW_MS * 2) ipBuckets.delete(key);
  }

  entry.count++;
  const remaining = Math.max(0, effectiveMax - entry.count);
  const limited = entry.count > effectiveMax;
  const retryAfterSec = limited
    ? Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000)
    : 0;

  return { limited, retryAfterSec: Math.max(1, retryAfterSec), remaining };
}

// ── 中间件函数 ──────────────────────────────────────────────────────

/**
 * API 限流中间件——在路由处理前调用。
 * 返回 `true` 表示请求被限流（已写 429 响应），`false` 表示放行。
 */
export function applyApiRateLimit(req: IncomingMessage, res: ServerResponse): boolean {
  const ip = getClientIp(req);
  const { limited, retryAfterSec, remaining } = checkAndUpdateLimit(ip);

  // 设置限流相关响应头（无论是否限流都提供信息）
  res.setHeader('X-RateLimit-Limit', String(Math.floor(config.maxRequestsPerMinute * config.burstAllowance)));
  res.setHeader('X-RateLimit-Remaining', String(remaining));

  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSec));
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: false,
      error: 'rate_limited',
      message: `Too many requests. Retry after ${retryAfterSec}s.`,
      retryAfter: retryAfterSec,
    }));
    return true;
  }

  return false;
}

/** 重置 API 限流状态（仅测试使用） */
export function resetApiRateLimiter(): void {
  config = { ...DEFAULT_API_RATE_LIMIT_CONFIG };
  ipBuckets.clear();
}
