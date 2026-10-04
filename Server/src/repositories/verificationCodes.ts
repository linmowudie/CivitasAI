/**
 * @module repositories/verificationCodes
 * @description 验证码存储与校验（安全审计 SV-012 加固后）。
 *
 * 加固点：
 *  - **只存哈希**：`code_hash = sha256(code)`，明文不落库（对齐刷新令牌的做法）；
 *  - **CSPRNG**：`crypto.randomInt` 生成 6 位码（原先 `Math.random()` 可预测）；
 *  - **失败锁定**：`attempts` 计数，达到上限即作废；
 *  - **单活码**：签发新码时作废该邮箱同用途的旧码（避免"多个码同时有效"）；
 *  - **配额与冷却**：提供 `countRecentCodes` / `lastIssuedAt` 供服务层限流。
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/pool.js';

export interface VerificationCodeRow {
  id: string;
  email_lower: string;
  code_hash: string;
  purpose: 'register' | 'login' | 'reset_password';
  expires_at: string;
  used_at: string | null;
  attempts: number;
  created_at: string;
}

export interface CreateCodeInput {
  email: string;
  code: string;
  purpose: VerificationCodeRow['purpose'];
  /** 有效期（毫秒），默认 5 分钟 */
  ttlMs?: number;
}

/** 生成 6 位数字验证码（密码学安全随机） */
export function generateCode(): string {
  return randomInt(100_000, 1_000_000).toString();
}

/** 验证码哈希（sha256 十六进制） */
export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** 常量时间比较（防时序侧信道） */
export function verifyCodeHash(storedHash: string, code: string): boolean {
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(hashCode(code), 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * 签发验证码：先作废该邮箱同用途的未用码（保证**同一时刻只有一个有效码**），再插入新码（存哈希）。
 */
export async function createVerificationCode(db: Db, input: CreateCodeInput): Promise<VerificationCodeRow> {
  const ttlMs = input.ttlMs ?? 5 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);

  return db.tx(async (tx) => {
    await tx.execute(
      `UPDATE verification_codes SET used_at = now()
       WHERE email_lower = $1 AND purpose = $2 AND used_at IS NULL`,
      [input.email.toLowerCase(), input.purpose],
    );
    const rows = await tx.query<VerificationCodeRow>(
      `INSERT INTO verification_codes (email_lower, code_hash, purpose, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.email.toLowerCase(), hashCode(input.code), input.purpose, expiresAt],
    );
    const row = rows[0];
    if (!row) throw new Error('验证码写入失败');
    return row;
  });
}

/** 查找当前有效验证码（未过期 + 未使用 + 未超失败次数），返回最新一条 */
export async function findValidCode(
  db: Db,
  email: string,
  purpose: VerificationCodeRow['purpose'],
  maxAttempts = 5,
): Promise<VerificationCodeRow | null> {
  const rows = await db.query<VerificationCodeRow>(
    `SELECT * FROM verification_codes
     WHERE email_lower = $1
       AND purpose = $2
       AND used_at IS NULL
       AND expires_at > now()
       AND attempts < $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [email.toLowerCase(), purpose, maxAttempts],
  );
  return rows[0] ?? null;
}

/** 记录一次失败尝试；达到上限即作废（返回是否已作废） */
export async function registerFailedAttempt(
  db: Db,
  codeId: string,
  maxAttempts: number,
): Promise<{ attempts: number; invalidated: boolean }> {
  const row = await db.one<{ attempts: number }>(
    `UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
    [codeId],
  );
  const attempts = row?.attempts ?? 0;
  const invalidated = attempts >= maxAttempts;
  if (invalidated) {
    await db.execute(`UPDATE verification_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [codeId]);
  }
  return { attempts, invalidated };
}

/** 标记验证码已使用 */
export async function markCodeUsed(db: Db, codeId: string): Promise<void> {
  await db.execute(`UPDATE verification_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [codeId]);
}

/** 统计窗口内该邮箱签发次数（发送配额） */
export async function countRecentCodes(
  db: Db,
  email: string,
  purpose: VerificationCodeRow['purpose'],
  windowSec: number,
): Promise<number> {
  const row = await db.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM verification_codes
     WHERE email_lower = $1 AND purpose = $2 AND created_at > now() - ($3 || ' seconds')::interval`,
    [email.toLowerCase(), purpose, String(Math.max(1, Math.floor(windowSec)))],
  );
  return row?.n ?? 0;
}

/** 最近一次签发时间（冷却判断） */
export async function lastIssuedAt(
  db: Db,
  email: string,
  purpose: VerificationCodeRow['purpose'],
): Promise<Date | null> {
  const row = await db.one<{ created_at: Date }>(
    `SELECT created_at FROM verification_codes
     WHERE email_lower = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1`,
    [email.toLowerCase(), purpose],
  );
  return row?.created_at ? new Date(row.created_at) : null;
}

/** 清理过期验证码（定期维护） */
export async function cleanupExpiredCodes(db: Db, olderThanDays = 1): Promise<number> {
  return db.execute(
    `DELETE FROM verification_codes WHERE expires_at < now() - ($1 || ' days')::interval`,
    [String(Math.max(1, Math.floor(olderThanDays)))],
  );
}
