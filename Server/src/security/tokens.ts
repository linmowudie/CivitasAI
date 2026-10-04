/**
 * @module security/tokens
 * @description 令牌：
 *  - 访问令牌：JWT（HS256，短时效），只放最小声明（sub / sid / typ），不放邮箱等 PII
 *  - 刷新令牌：256 位随机不透明串，服务端只存 sha256 哈希；按"家族"轮换，
 *    检测到旧令牌被再次使用即判定为盗用并吊销整族
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { AuthConfig } from '../config.js';
import { AppError, unauthenticated } from '../http/errors.js';

export const JWT_ISSUER = 'civitas-server';
export const JWT_AUDIENCE = 'civitas-client';

export interface AccessTokenClaims {
  /** 用户 ID */
  sub: string;
  /** 会话（刷新令牌）ID，便于"按设备登出" */
  sid: string;
}

function secretKey(cfg: AuthConfig): Uint8Array {
  return new TextEncoder().encode(cfg.jwtSecret);
}

/** 签发访问令牌 */
export async function signAccessToken(
  cfg: AuthConfig,
  claims: AccessTokenClaims,
  now: number = Date.now(),
): Promise<{ token: string; expiresIn: number; expiresAt: number }> {
  const iat = Math.floor(now / 1000);
  const exp = iat + cfg.accessTokenTtlSec;
  const token = await new SignJWT({ sid: claims.sid, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretKey(cfg));
  return { token, expiresIn: cfg.accessTokenTtlSec, expiresAt: exp * 1000 };
}

/** 校验访问令牌；过期与非法分别抛出可区分的错误码 */
export async function verifyAccessToken(cfg: AuthConfig, token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(cfg), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ['HS256'],
    });
    const sub = payload['sub'];
    const sid = payload['sid'];
    if (typeof sub !== 'string' || typeof sid !== 'string') {
      throw unauthenticated('令牌缺少必要声明');
    }
    return { sub, sid };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof joseErrors.JWTExpired) {
      throw new AppError('TOKEN_EXPIRED', '访问令牌已过期，请刷新令牌');
    }
    throw unauthenticated('访问令牌无效');
  }
}

// ── 刷新令牌（不透明串）─────────────────────────────────────────────

export interface GeneratedRefreshToken {
  /** 明文（只在签发时返回给客户端一次） */
  raw: string;
  /** 入库用的 sha256 哈希 */
  hash: string;
}

export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateRefreshToken(): GeneratedRefreshToken {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashRefreshToken(raw) };
}

export function newFamilyId(): string {
  return randomUUID();
}
