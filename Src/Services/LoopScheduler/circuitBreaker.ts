/**
 * @module LoopScheduler/circuitBreaker
 * @description
 * 熔断器——Docs/14 §S8 Gate G8。
 * 60s 内重复 100 次触发 → 熔断生效，只启动 1 个 Loop。
 * 防风暴 5 道之一。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 内部状态 ────────────────────────────────────────────────────────

interface BreakerEntry {
  key: string;
  count: number;
  windowStart: number;
  tripped: boolean;
  trippedAt?: number;
}

const breakers: Map<string, BreakerEntry> = new Map();
let threshold = 100;
let windowMs = 60_000;
let cooldownMs = 120_000; // 熔断后冷却时间

// ── 配置 ────────────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  threshold?: number;       // 触发熔断的阈值（默认 100）
  windowMs?: number;        // 滑动窗口（默认 60s）
  cooldownMs?: number;      // 熔断冷却时间（默认 120s）
}

export function initCircuitBreaker(config: CircuitBreakerConfig = {}): void {
  threshold = config.threshold ?? 100;
  windowMs = config.windowMs ?? 60_000;
  cooldownMs = config.cooldownMs ?? 120_000;
}

// ── 检查 ────────────────────────────────────────────────────────────

/**
 * 检查是否允许通过：
 * - 窗口内计数 < threshold → 放行 + 计数
 * - 窗口内计数 >= threshold → 熔断 → 拒绝
 * - 冷却期已过 → 半开（允许一次探测）
 */
export function checkBreaker(key: string, now: number = Date.now()): Result<{ allowed: boolean; count: number }> {
  let entry = breakers.get(key);

  // 首次或窗口已过期
  if (!entry || (now - entry.windowStart) > windowMs) {
    entry = { key, count: 1, windowStart: now, tripped: false };
    breakers.set(key, entry);
    return ok({ allowed: true, count: 1 });
  }

  // 已熔断 → 检查冷却
  if (entry.tripped) {
    if (entry.trippedAt && (now - entry.trippedAt) > cooldownMs) {
      // 冷却结束 → 半开，允许一次探测
      entry.tripped = false;
      entry.count = 1;
      entry.windowStart = now;
      return ok({ allowed: true, count: 1 });
    }
    return err(`熔断器已触发: key="${key}", 冷却中 (${cooldownMs}ms)`);
  }

  // 计数递增
  entry.count++;

  // 达到阈值 → 熔断
  if (entry.count >= threshold) {
    entry.tripped = true;
    entry.trippedAt = now;
    return err(`熔断器触发: key="${key}", count=${entry.count} >= threshold=${threshold}`);
  }

  return ok({ allowed: true, count: entry.count });
}

export function isTripped(key: string, now: number = Date.now()): boolean {
  const entry = breakers.get(key);
  if (!entry || !entry.tripped) return false;
  if (entry.trippedAt && (now - entry.trippedAt) > cooldownMs) return false;
  return true;
}

export function getBreakerStatus(key: string): { count: number; tripped: boolean } | null {
  const entry = breakers.get(key);
  if (!entry) return null;
  return { count: entry.count, tripped: entry.tripped };
}

// ── 清理 ────────────────────────────────────────────────────────────

export function resetCircuitBreaker(): void {
  breakers.clear();
}
