/**
 * @module repositories/memories
 * @description 记忆存储：与端侧 `long_term_memory` 字段对齐，支持按 client_memory_id 幂等 upsert
 * （这是"卸载重装后无损重建"的关键）。
 *
 * 检索说明：`q` 含 CJK 时走 ILIKE（'simple' 分词器无法切中文）；
 * 纯拉丁查询走 tsvector + websearch_to_tsquery，可用 GIN 索引。
 */

import type { Db } from '../db/pool.js';

export interface MemoryRow {
  id: string;
  user_id: string;
  client_memory_id: string | null;
  title: string;
  content: string;
  category: string;
  assertion: 'observed' | 'inferred' | 'verified' | 'disputed';
  source_trace_ids: unknown;
  source_arbitration_ids: unknown;
  status: 'active' | 'archived' | 'deleted';
  contradicted_by: string | null;
  access_count: number;
  created_at: Date;
  last_accessed_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, user_id, client_memory_id, title, content, category, assertion,
                 source_trace_ids, source_arbitration_ids, status, contradicted_by,
                 access_count, created_at, last_accessed_at, updated_at`;

/** 导出分页大小（键集分页；见 `listAllMemories` 的 SV-001 说明） */
const EXPORT_PAGE_SIZE = 1_000;

export interface MemoryInput {
  clientMemoryId?: string | null;
  title: string;
  content: string;
  category?: string;
  assertion?: MemoryRow['assertion'];
  sourceTraceIds?: unknown[];
  sourceArbitrationIds?: unknown[] | null;
  status?: MemoryRow['status'];
  contradictedBy?: string | null;
  accessCount?: number;
  createdAt?: Date;
  lastAccessedAt?: Date;
}

/** 是否包含 CJK 字符（决定走 ILIKE 还是 tsvector） */
export function containsCjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

/** 单条 upsert（有 clientMemoryId 走幂等更新，否则新建） */
export async function upsertMemory(db: Db, userId: string, input: MemoryInput): Promise<MemoryRow> {
  const now = new Date();
  const createdAt = input.createdAt ?? now;
  const lastAccessedAt = input.lastAccessedAt ?? createdAt;

  if (input.clientMemoryId) {
    const row = await db.one<MemoryRow>(
      `INSERT INTO memories (user_id, client_memory_id, title, content, category, assertion,
                             source_trace_ids, source_arbitration_ids, status, contradicted_by,
                             access_count, created_at, last_accessed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
       ON CONFLICT (user_id, client_memory_id) WHERE client_memory_id IS NOT NULL
       DO UPDATE SET title = EXCLUDED.title,
                     content = EXCLUDED.content,
                     category = EXCLUDED.category,
                     assertion = EXCLUDED.assertion,
                     source_trace_ids = EXCLUDED.source_trace_ids,
                     source_arbitration_ids = EXCLUDED.source_arbitration_ids,
                     status = EXCLUDED.status,
                     contradicted_by = EXCLUDED.contradicted_by,
                     access_count = EXCLUDED.access_count,
                     last_accessed_at = EXCLUDED.last_accessed_at,
                     updated_at = now()
       RETURNING ${COLUMNS}`,
      [
        userId,
        input.clientMemoryId,
        input.title,
        input.content,
        input.category ?? 'general',
        input.assertion ?? 'observed',
        JSON.stringify(input.sourceTraceIds ?? []),
        input.sourceArbitrationIds ? JSON.stringify(input.sourceArbitrationIds) : null,
        input.status ?? 'active',
        input.contradictedBy ?? null,
        input.accessCount ?? 0,
        createdAt,
        lastAccessedAt,
      ],
    );
    if (!row) throw new Error('记忆写入失败');
    return row;
  }

  const row = await db.one<MemoryRow>(
    `INSERT INTO memories (user_id, client_memory_id, title, content, category, assertion,
                           source_trace_ids, source_arbitration_ids, status, contradicted_by,
                           access_count, created_at, last_accessed_at, updated_at)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     RETURNING ${COLUMNS}`,
    [
      userId,
      input.title,
      input.content,
      input.category ?? 'general',
      input.assertion ?? 'observed',
      JSON.stringify(input.sourceTraceIds ?? []),
      input.sourceArbitrationIds ? JSON.stringify(input.sourceArbitrationIds) : null,
      input.status ?? 'active',
      input.contradictedBy ?? null,
      input.accessCount ?? 0,
      createdAt,
      lastAccessedAt,
    ],
  );
  if (!row) throw new Error('记忆写入失败');
  return row;
}

export async function getMemory(db: Db, userId: string, id: string): Promise<MemoryRow | null> {
  return db.one<MemoryRow>(`SELECT ${COLUMNS} FROM memories WHERE user_id = $1 AND id = $2`, [userId, id]);
}

export async function getMemoryByClientId(
  db: Db,
  userId: string,
  clientMemoryId: string,
): Promise<MemoryRow | null> {
  return db.one<MemoryRow>(
    `SELECT ${COLUMNS} FROM memories WHERE user_id = $1 AND client_memory_id = $2`,
    [userId, clientMemoryId],
  );
}

export interface ListMemoriesOptions {
  limit: number;
  /** 键集分页游标：base64(createdAtIso|id) */
  cursor?: string | undefined;
  category?: string | undefined;
  status?: MemoryRow['status'] | undefined;
  q?: string | undefined;
}

export interface ListMemoriesResult {
  items: MemoryRow[];
  nextCursor: string | null;
}

export function encodeCursor(row: Pick<MemoryRow, 'created_at' | 'id'>): string {
  return Buffer.from(`${new Date(row.created_at).toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.lastIndexOf('|');
    if (sep <= 0) return null;
    const createdAt = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** 列表（键集分页，按 created_at DESC, id DESC） */
export async function listMemories(
  db: Db,
  userId: string,
  options: ListMemoriesOptions,
): Promise<ListMemoriesResult> {
  const where: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];

  if (options.status) {
    params.push(options.status);
    where.push(`status = $${params.length}`);
  } else {
    where.push(`status <> 'deleted'`);
  }
  if (options.category) {
    params.push(options.category);
    where.push(`category = $${params.length}`);
  }
  if (options.q) {
    if (containsCjk(options.q)) {
      params.push(`%${options.q}%`);
      where.push(`(title ILIKE $${params.length} OR content ILIKE $${params.length})`);
    } else {
      params.push(options.q);
      where.push(`to_tsvector('simple', title || ' ' || content) @@ websearch_to_tsquery('simple', $${params.length})`);
    }
  }
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (decoded) {
      params.push(decoded.createdAt, decoded.id);
      where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
    }
  }

  params.push(options.limit + 1);
  const rows = await db.query<MemoryRow>(
    `SELECT ${COLUMNS} FROM memories
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
}

export interface MemoryPatch {
  title?: string;
  content?: string;
  category?: string;
  assertion?: MemoryRow['assertion'];
  status?: MemoryRow['status'];
  contradictedBy?: string | null;
  accessCount?: number;
  lastAccessedAt?: Date;
}

/** 局部更新（只更新传入字段） */
export async function updateMemory(
  db: Db,
  userId: string,
  id: string,
  patch: MemoryPatch,
): Promise<MemoryRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [userId, id];

  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (patch.title !== undefined) push('title', patch.title);
  if (patch.content !== undefined) push('content', patch.content);
  if (patch.category !== undefined) push('category', patch.category);
  if (patch.assertion !== undefined) push('assertion', patch.assertion);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.contradictedBy !== undefined) push('contradicted_by', patch.contradictedBy);
  if (patch.accessCount !== undefined) push('access_count', patch.accessCount);
  if (patch.lastAccessedAt !== undefined) push('last_accessed_at', patch.lastAccessedAt);

  if (sets.length === 0) return getMemory(db, userId, id);

  sets.push('updated_at = now()');
  return db.one<MemoryRow>(
    `UPDATE memories SET ${sets.join(', ')} WHERE user_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    params,
  );
}

/** 删除：默认软删除（保留墓碑，便于多端同步） */
export async function deleteMemory(db: Db, userId: string, id: string, hard = false): Promise<boolean> {
  if (hard) {
    return (await db.execute('DELETE FROM memories WHERE user_id = $1 AND id = $2', [userId, id])) > 0;
  }
  return (
    (await db.execute(
      `UPDATE memories SET status = 'deleted', updated_at = now()
       WHERE user_id = $1 AND id = $2 AND status <> 'deleted'`,
      [userId, id],
    )) > 0
  );
}

export async function countMemories(db: Db, userId: string, status?: MemoryRow['status']): Promise<number> {
  const row = status
    ? await db.one<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM memories WHERE user_id = $1 AND status = $2',
        [userId, status],
      )
    : await db.one<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM memories WHERE user_id = $1 AND status <> 'deleted'`,
        [userId],
      );
  return row?.count ?? 0;
}

export interface BulkUpsertResult {
  created: number;
  updated: number;
  total: number;
}

/**
 * 批量 upsert（恢复/首次上传用）。在同一事务内完成，保证原子性。
 * 通过先查已存在的 client_memory_id 来区分新增与更新（避免依赖 xmax 这类实现细节）。
 */
export async function bulkUpsertMemories(
  db: Db,
  userId: string,
  items: MemoryInput[],
): Promise<BulkUpsertResult> {
  return db.tx(async (tx) => {
    const clientIds = items.map((i) => i.clientMemoryId).filter((v): v is string => !!v);
    let existing = new Set<string>();
    if (clientIds.length > 0) {
      const rows = await tx.query<{ client_memory_id: string }>(
        `SELECT client_memory_id FROM memories
         WHERE user_id = $1 AND client_memory_id = ANY($2::text[])`,
        [userId, clientIds],
      );
      existing = new Set(rows.map((r) => r.client_memory_id));
    }

    let created = 0;
    let updated = 0;
    for (const item of items) {
      const before = item.clientMemoryId ? existing.has(item.clientMemoryId) : false;
      await upsertMemory(tx, userId, item);
      if (before) updated += 1;
      else created += 1;
    }
    return { created, updated, total: items.length };
  });
}

/**
 * 导出全部记忆（备份用）。
 *
 * 安全审计 SV-001：改为**键集分页循环**取全量，不再 `LIMIT 10000` 静默截断——
 * 备份是"卸载重装无损重建"的前提，隐性丢数据不可接受。键集游标 (created_at, id)
 * 避免深分页 OFFSET 的线性退化；`pageSize` 仅影响每次查询行数，不影响结果完整性。
 */
export async function listAllMemories(db: Db, userId: string, pageSize = EXPORT_PAGE_SIZE): Promise<MemoryRow[]> {
  const all: MemoryRow[] = [];
  let cursor: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const rows: MemoryRow[] = cursor
      ? await db.query<MemoryRow>(
          `SELECT ${COLUMNS} FROM memories
           WHERE user_id = $1 AND (created_at, id) > ($2, $3)
           ORDER BY created_at ASC, id ASC LIMIT $4`,
          [userId, cursor.createdAt, cursor.id, pageSize],
        )
      : await db.query<MemoryRow>(
          `SELECT ${COLUMNS} FROM memories WHERE user_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2`,
          [userId, pageSize],
        );
    all.push(...rows);
    if (rows.length < pageSize) return all;
    const last: MemoryRow | undefined = rows[rows.length - 1];
    if (!last) return all;
    cursor = { createdAt: last.created_at, id: last.id };
  }
}
