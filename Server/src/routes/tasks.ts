/**
 * @module routes/tasks
 * @description 任务（会话）元数据：标题 + 归档状态。
 *   GET  /v1/tasks?archived=true|false|all   列出任务元数据
 *   POST /v1/tasks/bulk                      批量 upsert（幂等，≤500/批）
 *
 * 说明：仅元数据；消息正文与工具轨迹只存本机（见 Docs/Server/01 与 Docs/Client/04）。
 */

import type { FastifyInstance } from 'fastify';
import { taskBulkSchema, taskListQuerySchema } from '../http/schemas.js';
import { parseOrThrow } from '../http/validate.js';
import { ok } from '../http/respond.js';
import { createAuthGuard, requireAuth } from '../http/authGuard.js';
import type { AppContext } from '../app.js';

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = createAuthGuard(ctx.cfg, ctx.db);
  const { tasks } = ctx.services;

  app.get('/v1/tasks', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const query = parseOrThrow(taskListQuerySchema, request.query ?? {}, { scope: 'query' });
    const archived = query.archived === 'all' ? undefined : query.archived;
    const result = await tasks.list(userId, { archived, limit: query.limit });
    return ok(reply, result);
  });

  app.post('/v1/tasks/bulk', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(taskBulkSchema, request.body, { scope: 'body' });
    const result = await tasks.upsertMany(userId, body.items);
    return ok(reply, result);
  });
}
