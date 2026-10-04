/**
 * @module http/authGuard
 * @description 访问令牌校验 preHandler：验签 + 回查会话状态（SV-002），把 `req.auth` 注入请求上下文。
 */

import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { unauthenticated } from './errors.js';
import { verifyAccessToken } from '../security/tokens.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** 从 Authorization 头取 Bearer 令牌 */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function createAuthGuard(cfg: ServerConfig, db: Db): preHandlerHookHandler {
  return async function authGuard(request: FastifyRequest): Promise<void> {
    const token = extractBearer(request.headers.authorization);
    if (!token) throw unauthenticated('缺少 Bearer 访问令牌');
    const claims = await verifyAccessToken(cfg.auth, token);
    // SV-002：访问令牌自身无状态，但 `sid` 指向会话行（refresh_tokens.id）——
    // 改密/登出/单会话吊销会立即吊销该行，旧访问令牌不等 TTL 到期即失效
    const session = await db.one<{ revoked_at: Date | null; expires_at: Date }>(
      'SELECT revoked_at, expires_at FROM refresh_tokens WHERE id = $1',
      [claims.sid],
    );
    if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
      throw unauthenticated('会话已失效，请重新登录');
    }
    request.auth = { userId: claims.sub, sessionId: claims.sid };
  };
}

/** 取当前用户（断言已通过 authGuard） */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}
