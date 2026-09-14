/**
 * @module Cache/promptCache
 * @description
 * Prompt Cache 管理——Docs/02 §5.1�?
 *
 * S 区因 Prompt Cache 命中而实际只�?5% 价格（分件系�?0.05）�?
 * 通过前缀 hash 检�?Cache 命中情况�?
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 类型 ──────────────────────────────────────────────

/** Cache 条目 */
export interface CacheEntry {
  /** 前缀 hash */
  prefixHash: string;
  /** 缓存�?token �?*/
  cachedTokens: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后命中时�?*/
  lastHitAt: number;
  /** 命中次数 */
  hitCount: number;
}

/** Cache 统计 */
export interface CacheStats {
  totalLookups: number;
  totalHits: number;
  hitRate: number;
  totalCachedTokens: number;
  estimatedSavings: number;
}

/** Cache 配置 */
export interface PromptCacheConfig {
  /** 最大缓存条目数，默�?100 */
  maxEntries: number;
  /** 条目 TTL（ms），默认 1 小时 */
  entryTtlMs: number;
  /** S 区分件系数（Cache 命中后实际支付比例） */
  staticCoefficient: number;
}

const DEFAULT_CACHE_CONFIG: PromptCacheConfig = {
  maxEntries: 100,
  entryTtlMs: 60 * 60 * 1000,
  staticCoefficient: 0.05,
};

// ── 实现 ──────────────────────────────────────────────

const cacheStore = new Map<string, CacheEntry>();
let config: PromptCacheConfig = { ...DEFAULT_CACHE_CONFIG };
let totalLookups = 0;
let totalHits = 0;

/** 初始�?Prompt Cache */
export function initPromptCache(userConfig?: Partial<PromptCacheConfig>): void {
  if (userConfig) {
    config = { ...DEFAULT_CACHE_CONFIG, ...userConfig };
  }
  cacheStore.clear();
  totalLookups = 0;
  totalHits = 0;
}

/** 注册/更新 Cache 条目 */
export function registerCacheEntry(prefixHash: string, cachedTokens: number): void {
  // 清理过期条目
  evictExpired();

  const existing = cacheStore.get(prefixHash);
  if (existing) {
    existing.lastHitAt = Date.now();
    existing.hitCount++;
    existing.cachedTokens = cachedTokens;
  } else {
    // 如果已满，淘汰最旧条�?
    if (cacheStore.size >= config.maxEntries) {
      evictOldest();
    }
    cacheStore.set(prefixHash, {
      prefixHash,
      cachedTokens,
      createdAt: Date.now(),
      lastHitAt: Date.now(),
      hitCount: 0,
    });
  }
}

/** 查询 Cache 命中 */
export function lookupCache(prefixHash: string): CacheEntry | null {
  totalLookups++;
  const entry = cacheStore.get(prefixHash);
  if (!entry) return null;

  // 检�?TTL
  if (Date.now() - entry.createdAt > config.entryTtlMs) {
    cacheStore.delete(prefixHash);
    return null;
  }

  totalHits++;
  entry.lastHitAt = Date.now();
  entry.hitCount++;
  return entry;
}

/** 获取 Cache 统计 */
export function getCacheStats(): CacheStats {
  let totalCachedTokens = 0;
  for (const entry of cacheStore.values()) {
    totalCachedTokens += entry.cachedTokens;
  }

  return {
    totalLookups,
    totalHits,
    hitRate: totalLookups > 0 ? totalHits / totalLookups : 0,
    totalCachedTokens,
    estimatedSavings: totalCachedTokens * (1 - config.staticCoefficient),
  };
}

/** 清理过期条目 */
function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cacheStore) {
    if (now - entry.createdAt > config.entryTtlMs) {
      cacheStore.delete(key);
    }
  }
}

/** 淘汰最旧条�?*/
function evictOldest(): void {
  let oldestKey: string | null = null;
  let oldestTime = Infinity;

  for (const [key, entry] of cacheStore) {
    if (entry.lastHitAt < oldestTime) {
      oldestTime = entry.lastHitAt;
      oldestKey = key;
    }
  }

  if (oldestKey) cacheStore.delete(oldestKey);
}

/** 清空 Cache */
export function clearCache(): void {
  cacheStore.clear();
  totalLookups = 0;
  totalHits = 0;
}
