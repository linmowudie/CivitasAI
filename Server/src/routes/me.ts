/**
 * @module routes/me
 * @description 个人资料 / 登录设备 / 登录审计 / 注销账号。
 */

import type { FastifyInstance } from 'fastify';
import { deleteAccountSchema, updateProfileSchema } from '../http/schemas.js';
import { parseOrThrow } from '../http/validate.js';
import { ok } from '../http/respond.js';
import { createAuthGuard, requireAuth } from '../http/authGuard.js';
import { invalidCredentials, notFound } from '../http/errors.js';
import { listAuditForUser } from '../repositories/audit.js';
import { deleteUser, findUserById } from '../repositories/users.js';
import { verifyPassword } from '../security/password.js';
import type { AppContext } from '../app.js';

export function registerMeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = createAuthGuard(ctx.cfg, ctx.db);
  const { auth } = ctx.services;
  const { db } = ctx;

  app.get('/v1/me', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    return ok(reply, await auth.getProfile(userId));
  });

  app.patch('/v1/me', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(updateProfileSchema, request.body, { scope: 'body' });
    return ok(reply, await auth.updateProfile(userId, { displayName: body.displayName }));
  });

  /** 登录设备（活跃会话） */
  app.get('/v1/me/sessions', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    return ok(reply, { sessions: await auth.listSessions(userId) });
  });

  /** 按设备登出 */
  app.delete('/v1/me/sessions/:sessionId', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const sessionId = (request.params as { sessionId?: string }).sessionId ?? '';
    await auth.revokeSession(userId, sessionId);
    return ok(reply, { revoked: sessionId });
  });

  /** 登录/安全审计记录 */
  app.get('/v1/me/audit', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const limit = Math.min(200, Number((request.query as { limit?: string }).limit ?? 50) || 50);
    const rows = await listAuditForUser(db, userId, limit);
    return ok(reply, {
      entries: rows.map((r) => ({
        action: r.action,
        outcome: r.outcome,
        ip: r.ip,
        userAgent: r.user_agent,
        detail: r.detail,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  });

  /**
   * 注销账号：需密码确认；数据随外键级联删除（设置/记忆/统计/令牌）。
   * 审计记录保留（user_id 置空），用于安全追溯。
   */
  app.delete('/v1/me', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(deleteAccountSchema, request.body ?? {}, { scope: 'body' });
    const user = await findUserById(db, userId);
    if (!user) throw notFound('用户不存在');
    const okPassword = await verifyPassword(user.password_hash, body.password);
    if (!okPassword) throw invalidCredentials();

    await db.tx(async (tx) => {
      await tx.execute('UPDATE audit_log SET user_id = NULL WHERE user_id = $1', [userId]);
      await deleteUser(tx, userId);
    });
    return ok(reply, { deleted: true });
  });
}
