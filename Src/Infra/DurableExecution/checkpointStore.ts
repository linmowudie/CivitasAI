/**
 * Checkpoint Store — 快照读写（Docs/13 §5 / Gate G2 DUR-003）
 *
 * 职责：
 * - 每轮 iteration 末尾原子写入 Checkpoint
 * - DB 事务为主干（Docs/13 §5.3），文件副本为辅助
 * - 支持加载最新/指定 Checkpoint
 */

import { getMainDb } from '../Db/database.js';
import type { Result } from '../types.js';
import { ok, err } from '../types.js';

import type { Checkpoint, CheckpointRow, CreateCheckpointInput } from './schemas/Checkpoint.js';

// ===== 类型导出 =====
export type { Checkpoint, CreateCheckpointInput };

// ===== 公开 API =====

/**
 * 生成 Checkpoint ID
 *
 * 格式：{loopId}#{iteration}#{ts}
 */
export function makeCheckpointId(loopId: string, iteration: number): string {
  return `${loopId}#${iteration}#${Date.now()}`;
}

/**
 * 创建 Checkpoint（原子写入）
 *
 * Gate G2 (DUR-003)：Checkpoint 写一半断电，旧快照完好
 * 实现：DB 事务保证原子性，写入失败不损坏旧数据
 */
export function createCheckpoint(input: CreateCheckpointInput): Result<Checkpoint> {
  try {
    const db = getMainDb();
    const checkpointId = makeCheckpointId(input.loopId, input.iteration);
    const now = Date.now();

    const checkpoint: Checkpoint = {
      checkpointId,
      loopId: input.loopId,
      iteration: input.iteration,
      stateSnapshot: input.stateSnapshot,
      artifactManifest: input.artifactManifest,
      pendingEffects: input.pendingEffects,
      nextStepHint: input.nextStepHint,
      createdAt: now,
    };

    // DB 事务写入
    const insertTx = db.transaction(() => {
      db.prepare(`
        INSERT INTO loop_checkpoints
          (checkpoint_id, loop_id, iteration, state_snapshot_json,
           artifact_manifest_json, pending_effects_json, next_step_hint, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpointId, input.loopId, input.iteration,
        JSON.stringify(input.stateSnapshot),
        JSON.stringify(input.artifactManifest),
        JSON.stringify(input.pendingEffects),
        input.nextStepHint ?? null,
        now,
      );
    });

    insertTx();

    return ok(checkpoint);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`创建 Checkpoint 失败: ${message}`, 'ERROR');
  }
}

/**
 * 加载指定 Loop 的最新 Checkpoint
 */
export function loadLatestCheckpoint(loopId: string): Result<Checkpoint | null> {
  try {
    const db = getMainDb();
    const row = db.prepare(`
      SELECT * FROM loop_checkpoints
      WHERE loop_id = ?
      ORDER BY iteration DESC, created_at DESC
      LIMIT 1
    `).get(loopId) as CheckpointRow | undefined;

    return ok(row ? rowToCheckpoint(row) : null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`加载最新 Checkpoint 失败: ${message}`, 'ERROR');
  }
}

/**
 * 加载指定 Checkpoint
 */
export function loadCheckpoint(checkpointId: string): Result<Checkpoint | null> {
  try {
    const db = getMainDb();
    const row = db.prepare(`
      SELECT * FROM loop_checkpoints WHERE checkpoint_id = ?
    `).get(checkpointId) as CheckpointRow | undefined;

    return ok(row ? rowToCheckpoint(row) : null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`加载 Checkpoint 失败: ${message}`, 'ERROR');
  }
}

/**
 * 获取指定 Loop 的所有 Checkpoint（按迭代降序）
 */
export function listCheckpoints(loopId: string, limit: number = 20): Result<Checkpoint[]> {
  try {
    const db = getMainDb();
    const rows = db.prepare(`
      SELECT * FROM loop_checkpoints
      WHERE loop_id = ?
      ORDER BY iteration DESC, created_at DESC
      LIMIT ?
    `).all(loopId, limit) as CheckpointRow[];

    return ok(rows.map(rowToCheckpoint));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`列出 Checkpoint 失败: ${message}`, 'ERROR');
  }
}

/**
 * 删除旧 Checkpoint（保留最近 N 个）
 */
export function pruneCheckpoints(loopId: string, keepLast: number = 20): Result<number> {
  try {
    const db = getMainDb();

    // 获取第 N 新的 checkpoint 的 created_at
    const cutoff = db.prepare(`
      SELECT created_at FROM loop_checkpoints
      WHERE loop_id = ?
      ORDER BY created_at DESC
      LIMIT 1 OFFSET ?
    `).get(loopId, keepLast - 1) as { created_at: number } | undefined;

    if (!cutoff) return ok(0);

    const result = db.prepare(`
      DELETE FROM loop_checkpoints
      WHERE loop_id = ? AND created_at < ?
    `).run(loopId, cutoff.created_at);

    return ok(result.changes);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`清理旧 Checkpoint 失败: ${message}`, 'ERROR');
  }
}

// ===== 内部函数 =====

function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    checkpointId: row.checkpoint_id,
    loopId: row.loop_id,
    iteration: row.iteration,
    stateSnapshot: JSON.parse(row.state_snapshot_json),
    artifactManifest: JSON.parse(row.artifact_manifest_json),
    pendingEffects: JSON.parse(row.pending_effects_json),
    nextStepHint: row.next_step_hint ?? undefined,
    createdAt: row.created_at,
  };
}
