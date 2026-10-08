/**
 * @module routes/a2a
 * @description A2A 镜像面（P0c）—— 设计 §15.3。
 *
 *   POST /v1/a2a/messages/bulk   批量 upsert（幂等，≤500/批；服务端二次脱敏 + 限额截断）
 *   GET  /v1/a2a/messages        增量拉取（游标 `(created_at, message_id)`）
 *   POST /v1/a2a/cards/bulk      卡片镜像上行（≤500/批）
 *
 * 说明：服务端只做**镜像**（本机为权威）。刻意不提供删除/覆盖本机判定的接口。
 */

import type { FastifyInstance } from 'fastify';
import { a2aCardBulkSchema, a2aMessageBulkSchema, a2aMessageListQuerySchema } from '../http/schemas.js';
import { parseOrThrow } from '../http/validate.js';
import { ok } from '../http/respond.js';
import { createAuthGuard, requireAuth } from '../http/authGuard.js';
import type { AppContext } from '../app.js';

export function registerA2ARoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = createAuthGuard(ctx.cfg, ctx.db);
  const { a2a } = ctx.services;

  app.post('/v1/a2a/messages/bulk', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(a2aMessageBulkSchema, request.body, { scope: 'body' });
    const result = await a2a.upsertMessages(userId, body.items);
    return ok(reply, result);
  });

  app.get('/v1/a2a/messages', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const query = parseOrThrow(a2aMessageListQuerySchema, request.query ?? {}, { scope: 'query' });
    const result = await a2a.listMessages(userId, {
      ...(query.taskId ? { taskId: query.taskId } : {}),
      ...(query.agentId ? { agentId: query.agentId } : {}),
      ...(query.since !== undefined ? { since: query.since } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return ok(reply, result);
  });

  app.post('/v1/a2a/cards/bulk', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(a2aCardBulkSchema, request.body, { scope: 'body' });
    const result = await a2a.upsertCards(userId, body.items);
    return ok(reply, result);
  });
}
