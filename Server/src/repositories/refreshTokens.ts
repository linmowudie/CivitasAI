/**
 * @module repositories/refreshTokens
 * @description 刷新令牌读写（只存哈希）+ 会话管理。
 */

import type { Db } from '../db/pool.js';

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  device_label: string | null;
  user_agent: string | null;
  ip: string | null;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  rotated_to: string | null;
}

const COLUMNS = `id, user_id, token_hash, family_id, device_label, user_agent, ip,
                 issued_at, expires_at, revoked_at, revoked_reason, rotated_to`;

export interface InsertRefreshTokenInput {
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  deviceLabel?: string | null;
  userAgent?: string | null;
  ip?: string | null;
}

export async function insertRefreshToken(db: Db, input: InsertRefreshTokenInput): Promise<RefreshTokenRow> {
  const row = await db.one<RefreshTokenRow>(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, device_label, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      input.userId,
      input.tokenHash,
      input.familyId,
      input.expiresAt,
      input.deviceLabel ?? null,
      input.userAgent ?? null,
      input.ip ?? null,
    ],
  );
  if (!row) throw new Error('刷新令牌写入失败');
  return row;
}

export async function findByHash(db: Db, tokenHash: string): Promise<RefreshTokenRow | null> {
  return db.one<RefreshTokenRow>(`SELECT ${COLUMNS} FROM refresh_tokens WHERE token_hash = $1`, [tokenHash]);
}

export async function findById(db: Db, id: string): Promise<RefreshTokenRow | null> {
  return db.one<RefreshTokenRow>(`SELECT ${COLUMNS} FROM refresh_tokens WHERE id = $1`, [id]);
}

export async function revokeById(db: Db, id: string, reason: string): Promise<void> {
  await db.execute(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2
     WHERE id = $1 AND revoked_at IS NULL`,
    [id, reason],
  );
}

/** 吊销整个轮换家族（检测到令牌重用时的标准处置） */
export async function revokeFamily(db: Db, familyId: string, reason: string): Promise<number> {
  return db.execute(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2
     WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason],
  );
}

export async function revokeAllForUser(db: Db, userId: string, reason: string): Promise<number> {
  return db.execute(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
}

export async function markRotated(db: Db, oldId: string, newId: string): Promise<void> {
  await db.execute('UPDATE refresh_tokens SET rotated_to = $2 WHERE id = $1', [oldId, newId]);
}

/** 活跃会话（未吊销且未过期） */
export async function listActiveSessions(db: Db, userId: string): Promise<RefreshTokenRow[]> {
  return db.query<RefreshTokenRow>(
    `SELECT ${COLUMNS} FROM refresh_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY issued_at DESC`,
    [userId],
  );
}

export async function countActiveSessions(db: Db, userId: string): Promise<number> {
  const row = await db.one<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM refresh_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [userId],
  );
  return row?.count ?? 0;
}

/** 清理过期/已吊销的历史记录（定期维护用） */
export async function purgeInactive(db: Db, olderThanDays = 60): Promise<number> {
  return db.execute(
    `DELETE FROM refresh_tokens
     WHERE (revoked_at IS NOT NULL OR expires_at < now())
       AND issued_at < now() - ($1 || ' days')::interval`,
    [String(olderThanDays)],
  );
}
