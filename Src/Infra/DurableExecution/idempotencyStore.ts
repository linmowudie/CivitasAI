/**
 * Idempotency Store — 幂等缓存（Docs/13 §7.3 / Gate G2 DUR-005）
 *
 * 职责：
 * - 缓存已完成的副作用结果，相同幂等键二次调用直接返回首次结果
 * - 自动过期清理（默认 24h）
 * - DUR-005：同 idempotencyKey 二次调用返回首次结果，无副作用
 */

import { createHash } from 'node:crypto';
import { getMainDb } from '../Db/database.js';
import type { Result } from '../types.js';
import { ok, err } from '../types.js';

// ===== 类型定义 =====

/** 幂等缓存记录 */
export interface IdempotencyRecord {
  readonly idemKey: string;
  readonly loopId: string;
  readonly resultJson: string;
  readonly resultHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** 幂等查询结果 */
export interface IdempotencyLookup {
  readonly hit: boolean;
  readonly result?: unknown;
}

// ===== 内部状态 =====

let cacheTtlMs = 24 * 60 * 60 * 1000; // 默认 24h

// ===== 公开 API =====

/**
 * 初始化幂等存储配置
 */
export function initIdempotencyStore(config: { cacheTtlHour?: number }): void {
  cacheTtlMs = (config.cacheTtlHour ?? 24) * 60 * 60 * 1000;
}

/**
 * 生成幂等键（Docs/13 §7.2）
 *
 * idempotencyKey = SHA-256(toolName + canonicalJson(args) + loopId)
 */
export function makeIdempotencyKey(toolName: string, args: unknown, loopId: string): string {
  const canonical = JSON.stringify(args, Object.keys(args as Record<string, unknown>).sort());
  const input = toolName + canonical + loopId;
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 查询幂等缓存（DUR-005）
 *
 * @returns hit=true 且 result 为首次结果；hit=false 表示无缓存
 */
export function lookup(idemKey: string): Result<IdempotencyLookup> {
  try {
    const db = getMainDb();
    const now = Date.now();

    const row = db.prepare(`
      SELECT result_json FROM idempotency_cache
      WHERE idem_key = ? AND expires_at > ?
    `).get(idemKey, now) as { result_json: string } | undefined;

    if (!row) return ok({ hit: false });

    return ok({ hit: true, result: JSON.parse(row.result_json) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`查询幂等缓存失败: ${message}`, 'ERROR');
  }
}

/**
 * 写入幂等缓存
 */
export function store(idemKey: string, loopId: string, result: unknown): Result<void> {
  try {
    const db = getMainDb();
    const resultJson = JSON.stringify(result);
    const resultHash = createHash('sha256').update(resultJson).digest('hex');
    const now = Date.now();
    const expiresAt = now + cacheTtlMs;

    db.prepare(`
      INSERT OR REPLACE INTO idempotency_cache
        (idem_key, loop_id, result_json, result_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(idemKey, loopId, resultJson, resultHash, now, expiresAt);

    return ok(undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`写入幂等缓存失败: ${message}`, 'ERROR');
  }
}

/**
 * 清理过期缓存
 */
export function purgeExpired(): Result<number> {
  try {
    const db = getMainDb();
    const now = Date.now();

    const result = db.prepare(`
      DELETE FROM idempotency_cache WHERE expires_at < ?
    `).run(now);

    return ok(result.changes);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`清理过期幂等缓存失败: ${message}`, 'ERROR');
  }
}

/**
 * 获取缓存大小
 */
export function getCacheSize(): number {
  try {
    const db = getMainDb();
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM idempotency_cache WHERE expires_at > ?
    `).get(Date.now()) as { cnt: number };
    return row.cnt;
  } catch {
    return 0;
  }
}
