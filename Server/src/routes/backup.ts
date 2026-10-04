/**
 * @module routes/backup
 * @description 一键备份 / 恢复：
 *   GET  /v1/backup            导出完整数据包（设置 + 记忆 + 可选统计）
 *   POST /v1/restore           从数据包恢复（mode=merge 合并 / replace 重建）
 *   GET  /v1/backup/download   以附件形式下载（便于用户自行保存到本地）
 */

import type { FastifyInstance } from 'fastify';
import { backupExportQuerySchema, restoreSchema } from '../http/schemas.js';
import { parseOrThrow } from '../http/validate.js';
import { ok } from '../http/respond.js';
import { createAuthGuard, requireAuth } from '../http/authGuard.js';
import type { AppContext } from '../app.js';

export function registerBackupRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = createAuthGuard(ctx.cfg, ctx.db);
  const { backup } = ctx.services;

  app.get('/v1/backup', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const query = parseOrThrow(backupExportQuerySchema, request.query ?? {}, { scope: 'query' });
    // SV-001 闭环：透传 statsLimit——缺省时服务层走键集分页全量导出（无静默上限），
    // 显式传入时按 limit 截断并在包内 `truncated.stats` 如实标注。
    const bundle = await backup.export(userId, {
      includeStats: query.includeStats,
      ...(query.statsLimit !== undefined ? { statsLimit: query.statsLimit } : {}),
    });
    return ok(reply, bundle);
  });

  /** 下载为 JSON 附件（含文件名），方便"卸载前导出、重装后导入" */
  app.get('/v1/backup/download', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const query = parseOrThrow(backupExportQuerySchema, request.query ?? {}, { scope: 'query' });
    const bundle = await backup.export(userId, {
      includeStats: query.includeStats,
      ...(query.statsLimit !== undefined ? { statsLimit: query.statsLimit } : {}),
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="civitas-backup-${stamp}.json"`);
    return reply.send(bundle);
  });

  app.post('/v1/restore', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(restoreSchema, request.body, { scope: 'body' });
    const report = await backup.restore(userId, body.bundle, body.mode);
    return ok(reply, report);
  });
}
