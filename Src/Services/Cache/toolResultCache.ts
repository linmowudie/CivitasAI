/**
 * @module Cache/toolResultCache
 * @description
 * 工具结果缓存——幂等工具的结果可缓存复用，减少重复执行�?
 * 仅缓�?idempotency='YES' 的工具结果�?
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 类型 ──────────────────────────────────────────────

/** 工具结果缓存条目 */
export interface ToolResultCacheEntry {
  /** 缓存键（工具�?+ 输入 hash�?*/
  key: string;
  /** 工具�?*/
  toolName: string;
  /** 缓存的结�?*/
  result: unknown;
  /** 创建时间 */
  createdAt: number;
  /** TTL（ms�?*/
  ttlMs: number;
  /** 命中次数 */
  hitCount: number;
}

/** 缓存配置 */
export interface ToolResultCacheConfig {
  /** 最大条目数，默�?200 */
  maxEntries: number;
  /** 默认 TTL（ms），默认 5 分钟 */
  defaultTtlMs: number;
}

const DEFAULT_CONFIG: ToolResultCacheConfig = {
  maxEntries: 200,
  defaultTtlMs: 5 * 60 * 1000,
};

// ── 实现 ──────────────────────────────────────────────

const store = new Map<string, ToolResultCacheEntry>();
let config: ToolResultCacheConfig = { ...DEFAULT_CONFIG };

/** 初始化工具结果缓�?*/
export function initToolResultCache(userConfig?: Partial<ToolResultCacheConfig>): void {
  if (userConfig) {
    config = { ...DEFAULT_CONFIG, ...userConfig };
  }
  store.clear();
}

/** 生成缓存�?*/
export function makeCacheKey(toolName: string, input: Record<string, unknown>): string {
  const inputHash = simpleHash(JSON.stringify(input));
  return `${toolName}:${inputHash}`;
}

/** 缓存工具结果 */
export function cacheToolResult(
  toolName: string,
  input: Record<string, unknown>,
  result: unknown,
  ttlMs?: number,
): void {
  evictExpired();

  const key = makeCacheKey(toolName, input);

  if (store.size >= config.maxEntries) {
    evictOldest();
  }

  store.set(key, {
    key,
    toolName,
    result,
    createdAt: Date.now(),
    ttlMs: ttlMs ?? config.defaultTtlMs,
    hitCount: 0,
  });
}

/** 查询缓存的工具结�?*/
export function getCachedToolResult(
  toolName: string,
  input: Record<string, unknown>,
): Result<unknown> | null {
  const key = makeCacheKey(toolName, input);
  const entry = store.get(key);

  if (!entry) return null;

  // 检�?TTL
  if (Date.now() - entry.createdAt > entry.ttlMs) {
    store.delete(key);
    return null;
  }

  entry.hitCount++;
  return ok(entry.result);
}

/** 使缓存失�?*/
export function invalidateCache(toolName: string, input: Record<string, unknown>): boolean {
  const key = makeCacheKey(toolName, input);
  return store.delete(key);
}

/** 清空全部缓存 */
export function clearToolResultCache(): void {
  store.clear();
}

/** 获取缓存统计 */
export function getToolResultCacheStats(): { size: number; maxEntries: number } {
  return { size: store.size, maxEntries: config.maxEntries };
}

// ── 内部 ──────────────────────────────────────────────

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.createdAt > entry.ttlMs) {
      store.delete(key);
    }
  }
}

function evictOldest(): void {
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of store) {
    if (entry.createdAt < oldestTime) {
      oldestTime = entry.createdAt;
      oldestKey = key;
    }
  }
  if (oldestKey) store.delete(oldestKey);
}

function simpleHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
}
