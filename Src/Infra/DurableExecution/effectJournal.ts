/**
 * Effect Journal — 副作用意图日志（Docs/13 §4 / Gate G2）
 *
 * 职责：
 * - 副作用发生前写 INTENT 记录（D1 原则）
 * - 状态流转 INTENT → EXECUTING → SUCCEEDED/FAILED/UNKNOWN
 * - effect_journal 表使用 PRAGMA synchronous = FULL
 * - 满盘时拒绝新副作用（DUR-006）
 */

import { createHash } from 'node:crypto';

import { getMainDb } from '../Db/database.js';
import type { Result } from '../types.js';
import { ok, err } from '../types.js';

import type {
  EffectRecord, EffectKind, EffectStatus, ErrorClass,
  CreateEffectInput, UpdateEffectInput,
} from './schemas/EffectRecord.js';

// ===== 类型导出 =====
export type { EffectRecord, EffectKind, EffectStatus, ErrorClass, CreateEffectInput };

// ===== 内部状态 =====

let defaultTimeoutMs = 30_000;

// ===== 公开 API =====

/**
 * 初始化 Effect Journal 配置
 */
export function initEffectJournal(config: { defaultTimeoutMs?: number }): void {
  defaultTimeoutMs = config.defaultTimeoutMs ?? 30_000;
}

/**
 * 计算 payload 的 SHA-256 哈希
 */
export function hashPayload(payload: unknown): string {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHash('sha256').update(json).digest('hex');
}

/**
 * 记录副作用意图（INTENT）— 必须在副作用执行前调用
 *
 * Gate G2 (DUR-006)：满盘时拒绝新副作用
 */
export function recordIntent(input: CreateEffectInput): Result<EffectRecord> {
  try {
    const db = getMainDb();
    const now = Date.now();
    const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;

    const record: EffectRecord = {
      effectId: input.effectId,
      loopId: input.loopId,
      iteration: input.iteration,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      status: 'INTENT',
      startedAt: now,
      timeoutMs,
    };

    db.prepare(`
      INSERT INTO effect_journal
        (effect_id, loop_id, iteration, kind, idempotency_key, payload_hash,
         status, started_at, timeout_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'INTENT', ?, ?)
    `).run(
      record.effectId, record.loopId, record.iteration, record.kind,
      record.idempotencyKey, record.payloadHash,
      record.startedAt, record.timeoutMs,
    );

    return ok(record);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 满盘检测
    if (message.includes('database disk image') || message.includes('disk full')) {
      return err(`Effect Journal 满盘，拒绝新副作用 (DUR-006): ${message}`, 'FATAL');
    }
    return err(`记录副作用意图失败: ${message}`, 'ERROR');
  }
}

/**
 * 更新副作用状态
 */
export function updateEffectStatus(input: UpdateEffectInput): Result<void> {
  try {
    const db = getMainDb();
    const resultJson = input.result !== undefined ? JSON.stringify(input.result) : null;

    db.prepare(`
      UPDATE effect_journal
      SET status = ?, result_json = ?, completed_at = ?, error_class = ?
      WHERE effect_id = ?
    `).run(
      input.status, resultJson,
      input.completedAt ?? null,
      input.errorClass ?? null,
      input.effectId,
    );

    return ok(undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`更新副作用状态失败: ${message}`, 'ERROR');
  }
}

/**
 * 标记为 EXECUTING
 */
export function markExecuting(effectId: string): Result<void> {
  return updateEffectStatus({ effectId, status: 'EXECUTING' });
}

/**
 * 标记为 SUCCEEDED
 */
export function markSucceeded(effectId: string, result?: unknown): Result<void> {
  return updateEffectStatus({
    effectId,
    status: 'SUCCEEDED',
    result,
    completedAt: Date.now(),
  });
}

/**
 * 标记为 FAILED
 */
export function markFailed(effectId: string, errorClass: ErrorClass, result?: unknown): Result<void> {
  return updateEffectStatus({
    effectId,
    status: 'FAILED',
    result,
    completedAt: Date.now(),
    errorClass,
  });
}

/**
 * 查找超时的 EXECUTING 记录并标记为 UNKNOWN（Docs/13 §4.3）
 *
 * 判据：status == 'EXECUTING' AND startedAt + timeoutMs < now
 */
export function resolveTimedOutEffects(): Result<number> {
  try {
    const db = getMainDb();
    const now = Date.now();

    const result = db.prepare(`
      UPDATE effect_journal
      SET status = 'UNKNOWN'
      WHERE status = 'EXECUTING' AND (started_at + timeout_ms) < ?
    `).run(now);

    return ok(result.changes);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`解析超时副作用失败: ${message}`, 'ERROR');
  }
}

/**
 * 查询指定 Loop 的所有 UNKNOWN 副作用
 */
export function getUnknownEffects(loopId: string): Result<EffectRecord[]> {
  try {
    const db = getMainDb();
    const rows = db.prepare(`
      SELECT * FROM effect_journal WHERE loop_id = ? AND status = 'UNKNOWN'
    `).all(loopId) as EffectRow[];

    return ok(rows.map(rowToEffect));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`查询 UNKNOWN 副作用失败: ${message}`, 'ERROR');
  }
}

/**
 * 查询指定 Loop 的所有待处理副作用
 */
export function getPendingEffects(loopId: string): Result<EffectRecord[]> {
  try {
    const db = getMainDb();
    const rows = db.prepare(`
      SELECT * FROM effect_journal
      WHERE loop_id = ? AND status IN ('INTENT', 'EXECUTING')
      ORDER BY started_at ASC
    `).all(loopId) as EffectRow[];

    return ok(rows.map(rowToEffect));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`查询待处理副作用失败: ${message}`, 'ERROR');
  }
}

/**
 * 根据幂等键查询已有记录
 */
export function findByIdepotencyKey(loopId: string, idempotencyKey: string): Result<EffectRecord | null> {
  try {
    const db = getMainDb();
    const row = db.prepare(`
      SELECT * FROM effect_journal
      WHERE loop_id = ? AND idempotency_key = ?
    `).get(loopId, idempotencyKey) as EffectRow | undefined;

    return ok(row ? rowToEffect(row) : null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`查询幂等记录失败: ${message}`, 'ERROR');
  }
}

/**
 * 获取待处理副作用数量（用于告警阈值检测）
 */
export function getPendingCount(): number {
  try {
    const db = getMainDb();
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM effect_journal
      WHERE status IN ('INTENT', 'EXECUTING')
    `).get() as { cnt: number };
    return row.cnt;
  } catch {
    return 0;
  }
}

// ===== 内部类型与函数 =====

interface EffectRow {
  effect_id: string;
  loop_id: string;
  iteration: number;
  kind: EffectKind;
  idempotency_key: string;
  payload_hash: string;
  status: EffectStatus;
  result_json: string | null;
  error_class: ErrorClass | null;
  started_at: number;
  timeout_ms: number;
  completed_at: number | null;
}

function rowToEffect(row: EffectRow): EffectRecord {
  return {
    effectId: row.effect_id,
    loopId: row.loop_id,
    iteration: row.iteration,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    status: row.status,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    startedAt: row.started_at,
    timeoutMs: row.timeout_ms,
    completedAt: row.completed_at ?? undefined,
    errorClass: row.error_class ?? undefined,
  };
}
