/**
 * @module routes/settings
 * @description 设置管理：GET / PUT（整体）/ PATCH（浅合并）。
 */

import type { FastifyInstance } from 'fastify';
import { settingsPatchSchema, settingsPutSchema } from '../http/schemas.js';
import { parseOrThrow } from '../http/validate.js';
import { ok } from '../http/respond.js';
import { createAuthGuard, requireAuth } from '../http/authGuard.js';
import type { AppContext } from '../app.js';

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = createAuthGuard(ctx.cfg, ctx.db);
  const { settings } = ctx.services;

  app.get('/v1/settings', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    return ok(reply, await settings.get(userId));
  });

  /** 整体替换（expectedRevision 传入时做乐观并发校验） */
  app.put('/v1/settings', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(settingsPutSchema, request.body, { scope: 'body' });
    return ok(reply, await settings.put(userId, body.data, body.expectedRevision));
  });

  /** 浅合并：值为 null 表示删除该键 */
  app.patch('/v1/settings', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(settingsPatchSchema, request.body, { scope: 'body' });
    return ok(reply, await settings.patch(userId, body.patch, body.expectedRevision));
  });

  /** 重置为默认（删除服务端设置记录） */
  app.delete('/v1/settings', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    await settings.reset(userId);
    return ok(reply, { reset: true });
  });
}
