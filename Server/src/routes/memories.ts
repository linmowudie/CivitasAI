/**
 * @module routes/memories
 * @description 记忆存储：列表（键集分页 + 检索）/ 详情 / 新建（幂等 upsert）/ 更新 / 删除 / 批量。
 */

import type { FastifyInstance } from 'fastify';
import {
  memoryBulkSchema,
  memoryCreateSchema,
  memoryListQuerySchema,
  memoryUpdateSchema,
} from '../http/schemas.js';
import { parseOrThrow } from '../http/validate.js';
import { ok } from '../http/respond.js';
import { createAuthGuard, requireAuth } from '../http/authGuard.js';
import type { AppContext } from '../app.js';

export function registerMemoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = createAuthGuard(ctx.cfg, ctx.db);
  const { memories } = ctx.services;

  app.get('/v1/memories', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const query = parseOrThrow(memoryListQuerySchema, request.query ?? {}, { scope: 'query' });
    const result = await memories.list(userId, {
      limit: query.limit,
      cursor: query.cursor,
      category: query.category,
      status: query.status,
      q: query.q,
    });
    return ok(reply, result);
  });

  app.get('/v1/memories/:id', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const id = (request.params as { id: string }).id;
    return ok(reply, await memories.get(userId, id));
  });

  /** 新建或按 clientMemoryId 幂等更新（重装后重新上传走这里） */
  app.post('/v1/memories', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(memoryCreateSchema, request.body, { scope: 'body' });
    const result = await memories.create(userId, body);
    return ok(reply, result, result.created ? 201 : 200);
  });

  app.patch('/v1/memories/:id', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const id = (request.params as { id: string }).id;
    const patch = parseOrThrow(memoryUpdateSchema, request.body, { scope: 'body' });
    return ok(reply, await memories.update(userId, id, patch));
  });

  /** 删除（默认软删除，保留墓碑便于多端同步）；?hard=true 物理删除 */
  app.delete('/v1/memories/:id', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const id = (request.params as { id: string }).id;
    const hard = String((request.query as { hard?: string }).hard ?? '') === 'true';
    await memories.remove(userId, id, hard);
    return ok(reply, { deleted: id, hard });
  });

  /** 批量 upsert（恢复/首次全量上传） */
  app.post('/v1/memories/bulk', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(memoryBulkSchema, request.body, { scope: 'body' });
    const result = await memories.bulkUpsert(userId, body.items);
    return ok(reply, result);
  });
}
