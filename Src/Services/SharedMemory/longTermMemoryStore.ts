/**
 * @module SharedMemory/longTermMemoryStore
 * @description
 * 长时记忆的 **SQLite 持久化层**（表 `long_term_memory`）。
 *
 * 历史：
 *  - 迁移 v17 建表但**没有任何读写方**，记忆只存在进程内 `Map` → 重启即丢（FE-026，已修）；
 *  - 迁移 v21 增加**属主维度** `owner_user_id`（复合主键），修复跨账号数据不隔离（FE-032）：
 *    此前本地记忆是"机器级"的，同机换账号后新账号能看到并上传上一个账号的记忆。
 *
 * 设计要点：
 *  - **按属主读写**：未登录用 `local`，登录后用服务端 `userId`；所有查询都带属主条件，
 *    从根上避免"A 的数据被 B 读到/上传"。
 *  - **fail-safe**：数据库未初始化或写入失败时返回错误但不抛出——记忆写入属非关键路径，
 *    不应因持久化失败而中断 Agent 循环（调用方记录告警并保留内存副本）。
 *  - 字段与云端 `memories` 表（`Server/migrations/001_init.sql`）对齐，便于无损同步。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { getDatabases, isDatabaseInitialized } from '../../Infra/Db/database.js';
import { logger } from '../../Infra/Logging/logger.js';
import type { AssertionLevel } from '../EventBus/eventTypes.js';
import type { MemoryCategory, MemoryStatus, LongTermMemoryEntry } from './longTermMemory.js';

/** 未登录时的属主键（本机匿名数据） */
export const LOCAL_OWNER = 'local';

/** 数据库行（snake_case，JSON 列存字符串） */
export interface LongTermMemoryRow {
  owner_user_id: string;
  memory_id: string;
  title: string;
  content: string;
  category: string;
  source_trace_ids_json: string;
  source_arbitration_ids_json: string | null;
  assertion: string;
  created_at: number;
  last_accessed_at: number;
  access_count: number;
  status: string;
  contradicted_by: string | null;
}

const COLUMNS = `owner_user_id, memory_id, title, content, category, source_trace_ids_json,
                 source_arbitration_ids_json, assertion, created_at, last_accessed_at,
                 access_count, status, contradicted_by`;

/** 取主库；未初始化时返回 null（不抛错） */
function mainDb(): import('better-sqlite3').Database | null {
  if (!isDatabaseInitialized()) return null;
  try {
    return getDatabases().main ?? null;
  } catch {
    return null;
  }
}

export function isPersistenceAvailable(): boolean {
  return mainDb() !== null;
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/** 行 → 领域对象 */
export function rowToEntry(row: LongTermMemoryRow): LongTermMemoryEntry {
  const entry: LongTermMemoryEntry = {
    memoryId: row.memory_id,
    title: row.title,
    content: row.content,
    category: row.category as MemoryCategory,
    sourceTraceIds: safeJsonArray(row.source_trace_ids_json),
    assertion: row.assertion as AssertionLevel,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    status: row.status as MemoryStatus,
  };
  const arbitrationIds = safeJsonArray(row.source_arbitration_ids_json);
  if (arbitrationIds.length > 0) entry.sourceArbitrationIds = arbitrationIds;
  if (row.contradicted_by) entry.contradictedBy = row.contradicted_by;
  return entry;
}

/** 领域对象 → 行参数（含属主） */
function entryParams(owner: string, entry: LongTermMemoryEntry): unknown[] {
  return [
    owner,
    entry.memoryId,
    entry.title,
    entry.content,
    entry.category,
    JSON.stringify(entry.sourceTraceIds ?? []),
    entry.sourceArbitrationIds ? JSON.stringify(entry.sourceArbitrationIds) : null,
    entry.assertion,
    entry.createdAt,
    entry.lastAccessedAt,
    entry.accessCount,
    entry.status,
    entry.contradictedBy ?? null,
  ];
}

/** 新增或覆盖写入一条记忆（按 属主+memory_id 幂等） */
export function persistMemory(entry: LongTermMemoryEntry, owner: string = LOCAL_OWNER): Result<void> {
  const db = mainDb();
  if (!db) return err('数据库未初始化，长时记忆未持久化');
  try {
    db.prepare(
      `INSERT INTO long_term_memory (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_user_id, memory_id) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         category = excluded.category,
         source_trace_ids_json = excluded.source_trace_ids_json,
         source_arbitration_ids_json = excluded.source_arbitration_ids_json,
         assertion = excluded.assertion,
         created_at = excluded.created_at,
         last_accessed_at = excluded.last_accessed_at,
         access_count = excluded.access_count,
         status = excluded.status,
         contradicted_by = excluded.contradicted_by`,
    ).run(...entryParams(owner, entry));
    return ok(undefined);
  } catch (e) {
    logger.warn('长时记忆持久化失败', {
      source: 'longTermMemoryStore',
      memoryId: entry.memoryId,
      owner,
      error: e instanceof Error ? e.message : String(e),
    });
    return err(`长时记忆持久化失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 更新访问统计（读路径高频调用，失败静默） */
export function persistAccess(
  memoryId: string,
  accessCount: number,
  lastAccessedAt: number,
  owner: string = LOCAL_OWNER,
): void {
  const db = mainDb();
  if (!db) return;
  try {
    db.prepare(
      'UPDATE long_term_memory SET access_count = ?, last_accessed_at = ? WHERE owner_user_id = ? AND memory_id = ?',
    ).run(accessCount, lastAccessedAt, owner, memoryId);
  } catch {
    /* 访问统计非关键，静默 */
  }
}

/** 更新状态（deprecated / contradicted） */
export function persistStatus(
  memoryId: string,
  status: MemoryStatus,
  contradictedBy?: string,
  owner: string = LOCAL_OWNER,
): Result<void> {
  const db = mainDb();
  if (!db) return err('数据库未初始化，状态未持久化');
  try {
    db.prepare(
      'UPDATE long_term_memory SET status = ?, contradicted_by = ? WHERE owner_user_id = ? AND memory_id = ?',
    ).run(status, contradictedBy ?? null, owner, memoryId);
    return ok(undefined);
  } catch (e) {
    return err(`状态更新失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 读取某属主的全部记忆（按创建时间升序）；数据库不可用时返回空数组 */
export function loadAllRows(owner: string = LOCAL_OWNER): LongTermMemoryRow[] {
  const db = mainDb();
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT ${COLUMNS} FROM long_term_memory WHERE owner_user_id = ?
       ORDER BY created_at ASC, memory_id ASC`,
    ).all(owner) as LongTermMemoryRow[];
  } catch (e) {
    logger.warn('长时记忆读取失败', {
      source: 'longTermMemoryStore',
      owner,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/** 统计某属主的记忆条数（数据库不可用返回 0） */
export function countRows(owner: string = LOCAL_OWNER): number {
  const db = mainDb();
  if (!db) return 0;
  try {
    const row = db.prepare(
      'SELECT COUNT(*) AS n FROM long_term_memory WHERE owner_user_id = ?',
    ).get(owner) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** 统计各属主的记忆条数（诊断/排查用，不泄露内容） */
export function countByOwner(): Array<{ owner: string; count: number }> {
  const db = mainDb();
  if (!db) return [];
  try {
    return db.prepare(
      'SELECT owner_user_id AS owner, COUNT(*) AS count FROM long_term_memory GROUP BY owner_user_id ORDER BY owner',
    ).all() as Array<{ owner: string; count: number }>;
  } catch {
    return [];
  }
}
