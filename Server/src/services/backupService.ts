/**
 * @module services/backupService
 * @description 一键备份 / 恢复 —— "卸载重装后重建"的核心能力。
 *
 * 备份包（version=1）自包含：账户摘要 + 设置 + 记忆（+ 可选统计事件）。
 * 恢复在**单个事务**内完成：
 *   - mode=replace：清空该用户的设置/记忆/统计后写入（"重建"语义）
 *   - mode=merge  ：按 client_memory_id 幂等 upsert，不删除既有数据（"合并"语义）
 *
 * 完整性（安全审计 SV-001）：导出默认**全量**（记忆与统计均走键集分页循环，无 10 000
 * 条静默上限）；仅当调用方显式传入 `statsLimit` 且事件数超限时，包内出现
 * `truncated` 标记如实告知（缺省即完整，绝不静默截断）。
 */

import type { ServerConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { badRequest } from '../http/errors.js';
import * as memoryRepo from '../repositories/memories.js';
import * as settingsRepo from '../repositories/settings.js';
import * as statsRepo from '../repositories/stats.js';
import { findUserById } from '../repositories/users.js';
import { toMemoryDto, type MemoryDto } from './memoryService.js';
import * as tasksRepo from '../repositories/tasks.js';
import { toSettingsDto, type SettingsDto } from './settingsService.js';

export const BACKUP_FORMAT = 'civitas.backup';
export const BACKUP_VERSION = 1;

export interface BackupBundle {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  /** 账户摘要仅用于提示（恢复时以当前登录账号为准，不用于身份判定） */
  account?: { email: string; displayName: string | null };
  settings: SettingsDto | null;
  memories: MemoryDto[];
  /** 任务（会话）元数据：标题 + 归档状态（正文只存本机） */
  tasks?: BackupTaskDto[];
  stats: { events: BackupStatEvent[] } | null;
  /**
   * 完整性标记（SV-001）：**字段缺省表示导出完整**；
   * 出现时明确告知哪部分被截断（当前仅统计事件在调用方显式设限时可能截断）。
   */
  truncated?: {
    stats?: { limit: number; reason: string };
  };
}

/** 统计事件导出分页大小 */
const STATS_EXPORT_PAGE_SIZE = 1_000;

interface StatEventRow {
  /** bigserial（node-postgres 以字符串返回 int8，同时作为键集分页兼排序） */
  id: string;
  kind: string;
  value: number;
  occurred_at: Date;
  client_event_id: string | null;
  meta: unknown;
}

function toStatEvent(r: StatEventRow): BackupStatEvent {
  return {
    kind: r.kind,
    value: Number(r.value),
    occurredAt: new Date(r.occurred_at).toISOString(),
    clientEventId: r.client_event_id,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
  };
}

/**
 * 导出统计事件（SV-001：不再静默截断）。
 *
 * - 未指定 `limit`：键集分页 **全量**导出（与记忆导出一致，无上限）；
 * - 指定 `limit`：多取 1 条探测溢出，`truncated` 如实回传，由调用方写进备份包。
 */
async function exportStatEvents(
  db: Db,
  userId: string,
  limit?: number,
): Promise<{ events: BackupStatEvent[]; truncated: boolean }> {
  const cols = 'id, kind, value, occurred_at, client_event_id, meta';
  if (limit !== undefined) {
    const rows: StatEventRow[] = await db.query<StatEventRow>(
      `SELECT ${cols} FROM usage_events WHERE user_id = $1 ORDER BY occurred_at ASC, id ASC LIMIT $2`,
      [userId, limit + 1],
    );
    return { events: rows.slice(0, limit).map(toStatEvent), truncated: rows.length > limit };
  }

  const events: BackupStatEvent[] = [];
  let cursor: { occurredAt: Date; id: string } | null = null;
  for (;;) {
    const rows: StatEventRow[] = cursor
      ? await db.query<StatEventRow>(
          `SELECT ${cols} FROM usage_events
           WHERE user_id = $1 AND (occurred_at, id) > ($2, $3)
           ORDER BY occurred_at ASC, id ASC LIMIT $4`,
          [userId, cursor.occurredAt, cursor.id, STATS_EXPORT_PAGE_SIZE],
        )
      : await db.query<StatEventRow>(
          `SELECT ${cols} FROM usage_events WHERE user_id = $1 ORDER BY occurred_at ASC, id ASC LIMIT $2`,
          [userId, STATS_EXPORT_PAGE_SIZE],
        );
    events.push(...rows.map(toStatEvent));
    if (rows.length < STATS_EXPORT_PAGE_SIZE) return { events, truncated: false };
    const last: StatEventRow | undefined = rows[rows.length - 1];
    if (!last) return { events, truncated: false };
    cursor = { occurredAt: last.occurred_at, id: last.id };
  }
}

export interface BackupStatEvent {
  kind: string;
  value: number;
  occurredAt: string;
  clientEventId: string | null;
  meta: Record<string, unknown> | null;
}

/** 备份包中的任务元数据（标题 + 归档状态；正文只存本机） */
export interface BackupTaskDto {
  clientSessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface RestoreReport {
  mode: 'replace' | 'merge';
  settings: { restored: boolean; revision: number };
  memories: { created: number; updated: number; total: number };
  /** 任务元数据恢复计数（备份包含 tasks 时才有意义） */
  tasks?: { created: number; updated: number; total: number };
  stats: { accepted: number };
}

export interface BackupService {
  /**
   * 导出备份包。
   *
   * @param options.statsLimit 统计事件的**显式**上限（传入即截断，超限时包内 `truncated.stats` 标注）；
   *   缺省为全量导出（与记忆一致，走键集分页循环，无 10 000 静默上限；SV-001）
   */
  export(userId: string, options?: { includeStats?: boolean; statsLimit?: number }): Promise<BackupBundle>;
  restore(userId: string, bundle: BackupBundle, mode: 'replace' | 'merge'): Promise<RestoreReport>;
}

/** 校验备份包结构（路由层用 Zod 做严格校验，这里做语义检查） */
export function assertBundleUsable(bundle: BackupBundle): void {
  if (bundle.format !== BACKUP_FORMAT) {
    throw badRequest(`备份格式不支持：期望 ${BACKUP_FORMAT}`);
  }
  if (bundle.version > BACKUP_VERSION) {
    throw badRequest(`备份版本 ${bundle.version} 高于本服务端支持的 ${BACKUP_VERSION}`);
  }
}

export function createBackupService(deps: { db: Db; cfg: ServerConfig }): BackupService {
  const { db } = deps;

  return {
    async export(userId, options = {}) {
      const user = await findUserById(db, userId);
      if (!user) throw badRequest('用户不存在');
      const settingsRow = await settingsRepo.getSettings(db, userId);
      const memories = await memoryRepo.listAllMemories(db, userId);
      // 任务元数据（标题 + 归档状态）：与记忆/统计一致，键集分页全量导出，无静默截断
      const taskRows = await tasksRepo.listAllTasks(db, userId);
      const tasks: BackupTaskDto[] = taskRows.map((r) => ({
        clientSessionId: r.client_session_id,
        title: r.title,
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
        archivedAt: r.archived_at === null || r.archived_at === undefined ? null : Number(r.archived_at),
      }));

      let stats: BackupBundle['stats'] = null;
      let truncated: BackupBundle['truncated'];
      if (options.includeStats) {
        const result = await exportStatEvents(db, userId, options.statsLimit);
        stats = { events: result.events };
        if (result.truncated && options.statsLimit !== undefined) {
          truncated = {
            stats: {
              limit: options.statsLimit,
              reason: '统计事件超过调用方设定的 statsLimit，仅导出前 N 条（省略 statsLimit 可导出全量）',
            },
          };
        }
      }

      return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        account: { email: user.email, displayName: user.display_name },
        settings: settingsRow ? toSettingsDto(settingsRow) : null,
        memories: memories.map(toMemoryDto),
        tasks,
        stats,
        ...(truncated ? { truncated } : {}),
      };
    },

    async restore(userId, bundle, mode) {
      assertBundleUsable(bundle);

      return db.tx(async (tx) => {
        // ── 设置 ──
        let restoredRevision = 0;
        if (bundle.settings) {
          const row = await settingsRepo.putSettings(tx, userId, bundle.settings.data ?? {});
          restoredRevision = row.revision;
        } else if (mode === 'replace') {
          await settingsRepo.deleteSettings(tx, userId);
        }

        // ── 统计 ──
        let acceptedStats = 0;
        if (bundle.stats?.events?.length) {
          if (mode === 'replace') await statsRepo.deleteAllEvents(tx, userId);
          acceptedStats = await statsRepo.insertEvents(
            tx,
            userId,
            bundle.stats.events.map((e) => ({
              kind: e.kind,
              value: e.value,
              occurredAt: new Date(e.occurredAt),
              meta: e.meta,
              clientEventId: e.clientEventId,
            })),
          );
        }

        // ── 记忆 ──
        const inputs: memoryRepo.MemoryInput[] = bundle.memories.map((m) => ({
          clientMemoryId: m.clientMemoryId ?? m.id,
          title: m.title,
          content: m.content,
          category: m.category,
          assertion: m.assertion,
          sourceTraceIds: m.sourceTraceIds,
          sourceArbitrationIds: m.sourceArbitrationIds,
          status: m.status,
          contradictedBy: m.contradictedBy,
          accessCount: m.accessCount,
          createdAt: new Date(m.createdAt),
          lastAccessedAt: new Date(m.lastAccessedAt),
        }));

        if (mode === 'replace') {
          await tx.execute('DELETE FROM memories WHERE user_id = $1', [userId]);
        }

        const memoryResult =
          inputs.length > 0
            ? await memoryRepo.bulkUpsertMemories(tx, userId, inputs)
            : { created: 0, updated: 0, total: 0 };

        // ── 任务元数据（标题 + 归档状态）──
        // replace 模式先清空该用户的任务元数据，再按包内内容重建，保证与备份一致；
        // merge 模式仅 upsert（幂等，不清空本地既有的其他任务）。
        const taskItems = bundle.tasks ?? [];
        if (mode === 'replace' && taskItems.length > 0) {
          await tx.execute('DELETE FROM user_tasks WHERE user_id = $1', [userId]);
        }
        const taskResult =
          taskItems.length > 0
            ? await tasksRepo.bulkUpsertTasks(
                tx,
                userId,
                taskItems.map((t) => ({
                  clientSessionId: t.clientSessionId,
                  title: t.title,
                  createdAt: t.createdAt,
                  updatedAt: t.updatedAt,
                  archivedAt: t.archivedAt ?? null,
                })),
              )
            : { created: 0, updated: 0 };

        return {
          mode,
          settings: { restored: !!bundle.settings, revision: restoredRevision },
          memories: memoryResult,
          tasks: { created: taskResult.created, updated: taskResult.updated, total: taskItems.length },
          stats: { accepted: acceptedStats },
        };
      });
    },
  };
}
