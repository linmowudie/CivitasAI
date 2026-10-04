/**
 * @module SharedMemory/memoryEntryStore
 * @description
 * 共享记忆 KV 视图的 **SQLite 持久化层**（memory 库 / `memory_entries` 表）。
 *
 * 历史（FE-034）：`memory_entries` 在代码中**从未创建** —— `GET /api/memory/entries`
 * 与 `ipc-get-memory-entries`（前端「记忆」视图的数据源）都查这张表，因表缺失恒为空。
 * 现由迁移 `memory v1` 建表，并由长时记忆（`long_term_memory`）在写入/导入/状态变更时
 * **镜像投影**（key=`ltm-<n>`、namespace=`long-term`），启动回灌时补齐存量条目。
 *
 * 设计要点：
 *  - **镜像投影**：不引入第二套记忆状态源 —— `memory_entries` 只是长时记忆面向
 *    「KV 视图」接口的投影，value 为条目 JSON（字段与云端 memories 对齐）。
 *  - **属主隔离**（FE-032）：复合主键 (owner_user_id, key)，读写一律带属主条件。
 *  - **fail-safe**：投影属非关键路径，数据库不可用/写入失败仅告警，不中断调用方
 *    （与 longTermMemoryStore 的 fail-safe 约定一致，Agent 循环不因视图失败而受影响）。
 */

import { getDatabases, isDatabaseInitialized } from '../../Infra/Db/database.js';
import { logger } from '../../Infra/Logging/logger.js';
import { LOCAL_OWNER } from '../AccountScope/activeAccount.js';
import type { LongTermMemoryEntry } from './longTermMemory.js';

/** 长时记忆在 KV 视图中使用的命名空间 */
export const LTM_NAMESPACE = 'long-term';

/** 取 memory 库；未初始化时返回 null（不抛错） */
function memoryDb(): import('better-sqlite3').Database | null {
  if (!isDatabaseInitialized()) return null;
  try {
    return getDatabases().memory ?? null;
  } catch {
    return null;
  }
}

/** 投影 SQL：插入或更新（更新时 version 自增、created_at 保留首写值） */
const PROJECT_SQL = `INSERT INTO memory_entries
    (owner_user_id, key, namespace, value, version, created_at, updated_at)
  VALUES (?, ?, ?, ?, 1, ?, ?)
  ON CONFLICT(owner_user_id, key) DO UPDATE SET
    value      = excluded.value,
    namespace  = excluded.namespace,
    version    = memory_entries.version + 1,
    updated_at = excluded.updated_at`;

/**
 * 投影（新增/更新）一条长时记忆到 KV 视图。
 *
 * key 即 memoryId（`ltm-<n>`）；value 为条目 JSON。失败仅告警（fail-safe）。
 */
export function projectMemoryEntry(entry: LongTermMemoryEntry, owner: string = LOCAL_OWNER): void {
  const db = memoryDb();
  if (!db) return;
  try {
    db.prepare(PROJECT_SQL).run(
      owner, entry.memoryId, LTM_NAMESPACE, JSON.stringify(entry), entry.createdAt, Date.now(),
    );
  } catch (e) {
    logger.warn('记忆 KV 投影失败（不影响记忆主流程）', {
      source: 'memoryEntryStore',
      memoryId: entry.memoryId,
      owner,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * 回灌补齐：把存量长时记忆投影进 KV 视图（启动/切换属主回灌后调用）。
 *
 * 用 INSERT OR IGNORE 语义补「从未投影过」的条目 —— 不覆盖已有投影
 * （version 不回退、不误 bump），保证重复回灌幂等。
 */
export function backfillMemoryEntries(entries: LongTermMemoryEntry[], owner: string = LOCAL_OWNER): void {
  const db = memoryDb();
  if (!db) return;
  try {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO memory_entries
         (owner_user_id, key, namespace, value, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    );
    const runAll = db.transaction((list: LongTermMemoryEntry[]) => {
      const now = Date.now();
      for (const entry of list) {
        stmt.run(owner, entry.memoryId, LTM_NAMESPACE, JSON.stringify(entry), entry.createdAt, now);
      }
    });
    runAll(entries);
  } catch (e) {
    logger.warn('记忆 KV 回灌失败', {
      source: 'memoryEntryStore',
      owner,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 统计某属主在 KV 视图中的条目数（诊断/测试用，不泄露内容） */
export function countProjected(owner: string = LOCAL_OWNER): number {
  const db = memoryDb();
  if (!db) return 0;
  try {
    const row = db.prepare(
      'SELECT COUNT(*) AS n FROM memory_entries WHERE owner_user_id = ?',
    ).get(owner) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
