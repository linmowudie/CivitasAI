/**
 * @module Governance/serverIdentity
 * @description 服务端令牌 → 用户身份的验真（2026-10-04，落地清单 G-09 方案 B）。
 *
 * 背景：方案 A 把 `user` 角色绑定到**本地活动账号**（`getActiveOwner()`），
 *   但该账号是本地状态，可由本地环境伪造。方案 B 用**服务端签发的访问令牌**验真：
 *   本地后端拿令牌向服务端 `GET /v1/me` 查证，得到的 `userId` 才是可信身份。
 *
 * 设计：
 *  - 令牌来源：本地 REST 请求的 `Authorization: Bearer <token>`（或 `X-Account-Token`）；
 *  - 服务端地址：`CIVITAS_SERVER_URL` 环境变量 → 默认 `http://127.0.0.1:8787`；
 *  - **短 TTL 缓存**（默认 60s）避免每次审批都打服务端；缓存键为令牌的哈希（不存原文）；
 *  - 验真失败一律 fail-closed（返回 err），调用方据此拒绝（403）；
 *  - 未提供令牌时返回 `null` 而非错误 → 由调用方回退方案 A（本地活动账号）。
 */

import { createHash } from 'node:crypto';

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { logger } from '../../Infra/Logging/logger.js';

/** 验真结果 */
export interface VerifiedServerIdentity {
  readonly userId: string;
  /** 服务端返回的其它字段（如 email/nickname），仅用于留痕 */
  readonly profile?: Record<string, unknown>;
}

/** 缓存条目 */
interface CacheEntry {
  readonly identity: VerifiedServerIdentity;
  readonly expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/** 令牌 → 缓存键（只存哈希，避免明文令牌驻留内存） */
function cacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

/** 服务端基址（可被测试注入覆盖） */
export function serverBaseUrl(override?: string): string {
  return (override ?? process.env['CIVITAS_SERVER_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
}

export interface ResolveDeps {
  /** 注入的 fetch（测试用）；默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 覆盖服务端基址（测试用） */
  baseUrl?: string;
  /** 覆盖缓存 TTL（测试用；0 表示不缓存） */
  cacheTtlMs?: number;
}

/**
 * 从访问令牌解析并验真服务端身份。
 *
 * @param token 访问令牌（Bearer 之后的原文）
 * @returns `ok(identity)` 验真通过；`err` 验真失败（fail-closed）
 */
export async function resolveServerIdentity(
  token: string,
  deps: ResolveDeps = {},
): Promise<Result<VerifiedServerIdentity>> {
  if (!token || typeof token !== 'string') return err('缺少访问令牌');

  const ttl = deps.cacheTtlMs ?? CACHE_TTL_MS;
  const key = cacheKey(token);
  if (ttl > 0) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return ok(hit.identity);
    if (hit) cache.delete(key);
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${serverBaseUrl(deps.baseUrl)}/v1/me`;
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      logger.warn('服务端身份验真失败', {
        source: 'serverIdentity/resolveServerIdentity',
        status: res.status,
      });
      return err(`服务端身份验真失败（HTTP ${res.status}）`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    // 服务端 `/v1/me` 返回体形如 `{ ok:true, data:{ user:{ id } } }` 或 `{ id }`，两种都兼容
    const data = (body['data'] ?? body) as Record<string, unknown>;
    const user = (data['user'] ?? data) as Record<string, unknown>;
    const userId = String(user['id'] ?? user['userId'] ?? '');
    if (!userId || userId === 'undefined' || userId === 'null') {
      return err('服务端身份验真失败：返回体缺少用户 ID');
    }

    const identity: VerifiedServerIdentity = { userId, profile: user };
    if (ttl > 0) cache.set(key, { identity, expiresAt: Date.now() + ttl });
    return ok(identity);
  } catch (e) {
    logger.warn('服务端身份验真异常', {
      source: 'serverIdentity/resolveServerIdentity',
      error: e instanceof Error ? e.message : String(e),
    });
    return err(`服务端身份验真异常：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 从请求头解析访问令牌（兼容 `Authorization: Bearer` 与 `X-Account-Token`） */
export function extractBearerToken(headers: Record<string, unknown> | undefined): string | null {
  if (!headers) return null;
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  const direct = lower['x-account-token'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const auth = lower['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

/** 清空验真缓存（测试/切号时用） */
export function resetServerIdentityCache(): void {
  cache.clear();
}
