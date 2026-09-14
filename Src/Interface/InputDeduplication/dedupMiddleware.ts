/**
 * @module Interface/InputDeduplication/dedupMiddleware
 * @description
 * 输入去重中间件——Docs/06 §5.1。
 * 5 道防风暴：去重键 / 冷却期 / 幂等 ID / 并发上限 / 熔断。
 * Phase 0-2：内存实现；Phase 3 接 Redis/DB。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 配置 ────────────────────────────────────────────────────────────

export interface DedupConfig {
  dedupTtlMs: number;           // 去重键 TTL（默认 5 min）
  cooldownMs: number;           // 同 Agent 冷却期（默认 30s）
  idempotencyTtlMs: number;     // 幂等 ID 保留（默认 24h）
  maxConcurrent: number;        // 全局并发上限（默认 20）
  maxPerUser: number;           // 单用户并发上限（默认 5）
  circuitBreakerThreshold: number; // 熔断阈值（默认 100 次/min）
  circuitBreakerCooldownMs: number; // 熔断冷却（默认 60s）
}

const DEFAULT_CONFIG: DedupConfig = {
  dedupTtlMs: 5 * 60 * 1000,
  cooldownMs: 30_000,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  maxConcurrent: 20,
  maxPerUser: 5,
  circuitBreakerThreshold: 100,
  circuitBreakerCooldownMs: 60_000,
};

// ── 内部状态 ────────────────────────────────────────────────────────

let config: DedupConfig = { ...DEFAULT_CONFIG };

// 去重键 → 时间戳
const dedupKeys: Map<string, number> = new Map();
// 幂等 ID → 结果
const idempotencyStore: Map<string, { result: unknown; timestamp: number }> = new Map();
// 并发追踪
let globalConcurrent = 0;
const userConcurrent: Map<string, number> = new Map();
// 熔断器
let circuitOpen = false;
let circuitOpenedAt = 0;
let recentRequests: number[] = []; // 时间戳列表

// ── 初始化 ──────────────────────────────────────────────────────────

export function initDedupMiddleware(cfg: Partial<DedupConfig> = {}): void {
  config = { ...DEFAULT_CONFIG, ...cfg };
}

// ── 去重键 ──────────────────────────────────────────────────────────

/**
 * 计算去重键：hash(source + intent + target)。
 */
export function computeDedupKey(source: string, intent: string, target: string): string {
  // 简单拼接（Phase 0-2）；Phase 3 用 SHA-256
  return `${source}:${intent}:${target}`;
}

/**
 * 检查去重键是否在 TTL 内已处理。
 */
export function checkDedup(key: string): { duplicate: boolean } {
  const now = Date.now();

  // 清理过期
  for (const [k, ts] of dedupKeys) {
    if (now - ts > config.dedupTtlMs) dedupKeys.delete(k);
  }

  const existing = dedupKeys.get(key);
  if (existing && now - existing < config.dedupTtlMs) {
    return { duplicate: true };
  }

  dedupKeys.set(key, now);
  return { duplicate: false };
}

// ── 冷却期 ──────────────────────────────────────────────────────────

export function checkCooldown(agentId: string): { blocked: boolean; remainingMs: number } {
  const key = `cooldown:${agentId}`;
  const now = Date.now();
  const last = dedupKeys.get(key);

  if (last && now - last < config.cooldownMs) {
    return { blocked: true, remainingMs: config.cooldownMs - (now - last) };
  }

  dedupKeys.set(key, now);
  return { blocked: false, remainingMs: 0 };
}

// ── 幂等 ID ─────────────────────────────────────────────────────────

export function checkIdempotency(idempotencyId: string): {
  alreadyProcessed: boolean;
  cachedResult?: unknown;
} {
  const now = Date.now();

  // 清理过期
  for (const [k, v] of idempotencyStore) {
    if (now - v.timestamp > config.idempotencyTtlMs) idempotencyStore.delete(k);
  }

  const existing = idempotencyStore.get(idempotencyId);
  if (existing) {
    return { alreadyProcessed: true, cachedResult: existing.result };
  }

  return { alreadyProcessed: false };
}

export function storeIdempotency(idempotencyId: string, result: unknown): void {
  idempotencyStore.set(idempotencyId, { result, timestamp: Date.now() });
}

// ── 并发控制 ────────────────────────────────────────────────────────

export function acquireConcurrencySlot(userId: string): Result<void> {
  if (globalConcurrent >= config.maxConcurrent) {
    return err(`全局并发上限：${config.maxConcurrent}`);
  }

  const userCount = userConcurrent.get(userId) ?? 0;
  if (userCount >= config.maxPerUser) {
    return err(`用户 ${userId} 并发上限：${config.maxPerUser}`);
  }

  globalConcurrent++;
  userConcurrent.set(userId, userCount + 1);
  return ok(undefined);
}

export function releaseConcurrencySlot(userId: string): void {
  globalConcurrent = Math.max(0, globalConcurrent - 1);
  const userCount = userConcurrent.get(userId) ?? 0;
  userConcurrent.set(userId, Math.max(0, userCount - 1));
}

// ── 熔断器 ──────────────────────────────────────────────────────────

export function checkCircuitBreaker(): { open: boolean; reason?: string } {
  const now = Date.now();

  // 熔断冷却检查
  if (circuitOpen) {
    if (now - circuitOpenedAt < config.circuitBreakerCooldownMs) {
      return { open: true, reason: '熔断冷却中' };
    }
    // 冷却结束，恢复
    circuitOpen = false;
    recentRequests = [];
  }

  // 记录请求
  recentRequests.push(now);

  // 清理 1 分钟前的数据
  const windowStart = now - 60_000;
  recentRequests = recentRequests.filter(t => t >= windowStart);

  // 检查是否超阈值
  if (recentRequests.length > config.circuitBreakerThreshold) {
    circuitOpen = true;
    circuitOpenedAt = now;
    return { open: true, reason: `1 分钟内 ${recentRequests.length} 次请求超阈值 ${config.circuitBreakerThreshold}` };
  }

  return { open: false };
}

// ── 完整中间件检查 ──────────────────────────────────────────────────

export function dedupCheck(params: {
  source: string;
  intent: string;
  target: string;
  agentId: string;
  idempotencyId?: string;
}): Result<{ dedupKey: string }> {
  // 1. 熔断器
  const circuit = checkCircuitBreaker();
  if (circuit.open) return err(`熔断中：${circuit.reason}`);

  // 2. 去重键
  const dedupKey = computeDedupKey(params.source, params.intent, params.target);
  const dedup = checkDedup(dedupKey);
  if (dedup.duplicate) return err(`重复请求：${dedupKey}`);

  // 3. 冷却期
  const cooldown = checkCooldown(params.agentId);
  if (cooldown.blocked) return err(`冷却中：剩余 ${cooldown.remainingMs}ms`);

  // 4. 幂等 ID
  if (params.idempotencyId) {
    const idem = checkIdempotency(params.idempotencyId);
    if (idem.alreadyProcessed) {
      return ok({ dedupKey }); // 幂等：返回缓存
    }
  }

  // 5. 并发控制
  const slot = acquireConcurrencySlot(params.agentId);
  if (!slot.ok) return err(slot.error);

  return ok({ dedupKey });
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getDedupStats(): {
  dedupKeysCount: number;
  idempotencyCount: number;
  globalConcurrent: number;
  circuitOpen: boolean;
  recentRequestCount: number;
} {
  return {
    dedupKeysCount: dedupKeys.size,
    idempotencyCount: idempotencyStore.size,
    globalConcurrent,
    circuitOpen,
    recentRequestCount: recentRequests.length,
  };
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetDedupMiddleware(): void {
  config = { ...DEFAULT_CONFIG };
  dedupKeys.clear();
  idempotencyStore.clear();
  globalConcurrent = 0;
  userConcurrent.clear();
  circuitOpen = false;
  circuitOpenedAt = 0;
  recentRequests = [];
}
