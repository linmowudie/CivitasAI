/**
 * @module repositories/tasks
 * @description 任务（会话）**元数据**仓储：标题 + 归档状态。
 *
 * 正文（消息/工具轨迹）只存本机，服务端仅保存"有哪些任务、叫什么、是否已归档"，
 * 用于跨设备/重装后恢复任务列表与归档状态。
 */

import type { Db } from '../db/pool.js';

export interface UserTaskRow {
  user_id: string;
  client_session_id: string;
  title: string;
  created_at: string | number;
  updated_at: string | number;
  archived_at: string | number | null;
  synced_at: Date;
}

export interface TaskInput {
  clientSessionId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
}

/** 新增或更新一条任务元数据（客户端会话 ID 幂等） */
export async function upsertTask(db: Db, userId: string, input: TaskInput): Promise<UserTaskRow> {
  const row = await db.one<UserTaskRow>(
    `INSERT INTO user_tasks (user_id, client_session_id, title, created_at, updated_at, archived_at, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id, client_session_id) DO UPDATE SET
       title = EXCLUDED.title,
       created_at = LEAST(user_tasks.created_at, EXCLUDED.created_at),
       updated_at = EXCLUDED.updated_at,
       archived_at = EXCLUDED.archived_at,
       synced_at = now()
     RETURNING *`,
    [
      userId,
      input.clientSessionId,
      input.title ?? '',
      input.createdAt,
      input.updatedAt,
      input.archivedAt ?? null,
    ],
  );
  if (!row) throw new Error(`任务元数据写入失败：${input.clientSessionId}`);
  return row;
}

/** 批量 upsert（幂等；单批上限由路由层校验） */
export async function bulkUpsertTasks(
  db: Db,
  userId: string,
  items: TaskInput[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  await db.tx(async (tx) => {
    for (const item of items) {
      const existing = await tx.one<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM user_tasks WHERE user_id = $1 AND client_session_id = $2`,
        [userId, item.clientSessionId],
      );
      await upsertTask(tx, userId, item);
      if ((existing?.n ?? 0) > 0) updated++;
      else created++;
    }
  });
  return { created, updated };
}

/** 列出任务元数据：`archived` 为 true/false 时按归档状态过滤，undefined = 全部 */
export async function listTasks(
  db: Db,
  userId: string,
  options: { archived?: boolean; limit?: number } = {},
): Promise<UserTaskRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000);
  if (options.archived === undefined) {
    return db.query<UserTaskRow>(
      `SELECT * FROM user_tasks WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [userId, limit],
    );
  }
  return db.query<UserTaskRow>(
    `SELECT * FROM user_tasks
     WHERE user_id = $1 AND (archived_at IS NOT NULL) = $2
     ORDER BY updated_at DESC LIMIT $3`,
    [userId, options.archived, limit],
  );
}

/** 导出用：键集分页取全量（不受单页上限静默截断，与记忆/统计一致） */
export async function listAllTasks(db: Db, userId: string, pageSize = 1_000): Promise<UserTaskRow[]> {
  const out: UserTaskRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const rows: UserTaskRow[] = cursor
      ? await db.query<UserTaskRow>(
          `SELECT * FROM user_tasks
           WHERE user_id = $1 AND client_session_id > $2
           ORDER BY client_session_id ASC LIMIT $3`,
          [userId, cursor, pageSize],
        )
      : await db.query<UserTaskRow>(
          `SELECT * FROM user_tasks WHERE user_id = $1 ORDER BY client_session_id ASC LIMIT $2`,
          [userId, pageSize],
        );
    out.push(...rows);
    if (rows.length < pageSize) return out;
    cursor = rows[rows.length - 1]?.client_session_id ?? null;
    if (!cursor) return out;
  }
}

/** 统计（概览用） */
export async function countTasks(
  db: Db,
  userId: string,
): Promise<{ total: number; archived: number }> {
  const row = await db.one<{ total: number; archived: number }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE archived_at IS NOT NULL)::int AS archived
     FROM user_tasks WHERE user_id = $1`,
    [userId],
  );
  return { total: row?.total ?? 0, archived: row?.archived ?? 0 };
}
