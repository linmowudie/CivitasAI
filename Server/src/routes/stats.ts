/**
 * @module routes/stats
 * @description 个人数据统计：上报事件 / 区间汇总 / 按日曲线 / 概览 / 清空。
 */

import type { FastifyInstance } from 'fastify';
import { statsIngestSchema, statsRangeQuerySchema } from '../http/schemas.js';
import { parseOrThrow } from '../http/validate.js';
import { ok } from '../http/respond.js';
import { createAuthGuard, requireAuth } from '../http/authGuard.js';
import type { AppContext } from '../app.js';

const DEFAULT_RANGE_DAYS = 30;

/** 解析区间：缺省为最近 30 天；to 缺省为当前时间 */
export function resolveRange(
  query: { from?: Date; to?: Date },
  now: Date = new Date(),
): { from: Date; to: Date } {
  const to = query.to ?? now;
  const from = query.from ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { from, to };
}

export function registerStatsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = createAuthGuard(ctx.cfg, ctx.db);
  const { stats } = ctx.services;

  /** 上报事件（批量、可带 clientEventId 做幂等） */
  app.post('/v1/stats/events', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(statsIngestSchema, request.body, { scope: 'body' });
    const result = await stats.ingest(
      userId,
      body.events.map((e) => ({
        kind: e.kind,
        value: e.value ?? 0,
        occurredAt: e.occurredAt,
        meta: e.meta ?? null,
        clientEventId: e.clientEventId ?? null,
      })),
    );
    return ok(reply, result, 201);
  });

  /** 区间汇总（按种类） */
  app.get('/v1/stats/summary', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const query = parseOrThrow(statsRangeQuerySchema, request.query ?? {}, { scope: 'query' });
    const { from, to } = resolveRange(query);
    return ok(reply, await stats.summary(userId, from, to));
  });

  /** 按日曲线（可指定 kind） */
  app.get('/v1/stats/daily', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const query = parseOrThrow(statsRangeQuerySchema, request.query ?? {}, { scope: 'query' });
    const { from, to } = resolveRange(query);
    return ok(reply, await stats.daily(userId, from, to, query.kind));
  });

  /** 个人中心概览（终身统计 + 记忆数 + 活跃设备数） */
  app.get('/v1/stats/overview', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    return ok(reply, await stats.overview(userId));
  });

  /** 清空统计事件 */
  app.delete('/v1/stats/events', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    return ok(reply, await stats.clear(userId));
  });
}
