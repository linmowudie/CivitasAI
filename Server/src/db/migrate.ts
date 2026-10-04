/**
 * @module db/migrate
 * @description 极简 SQL 迁移执行器。
 *
 * 行为：
 *  - 迁移文件：`migrations/NNN_name.sql`，按文件名升序执行
 *  - 每个文件在**独立事务**中执行；失败即回滚且不记录
 *  - 记录 checksum（sha256）：已应用迁移的内容若被改动，直接报错拒绝启动
 *    （避免"本地改了历史迁移但线上已应用"这类漂移）
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from './pool.js';

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  applied_at: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  alreadyUpToDate: boolean;
}

/** 读取迁移目录（按文件名排序） */
export function loadMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) throw new Error(`迁移目录不存在: ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = readFileSync(resolve(dir, file), 'utf8');
      const version = file.split('_')[0] ?? file;
      return {
        version,
        name: file,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    )
  `);
}

/** 列出已应用迁移 */
export async function listApplied(db: Db): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(db);
  return db.query<AppliedMigration>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC',
  );
}

/**
 * 执行迁移。
 *
 * @param dryRun 仅报告将要执行的内容，不落库
 */
export async function runMigrations(db: Db, dir: string, options: { dryRun?: boolean } = {}): Promise<MigrateResult> {
  const files = loadMigrations(dir);
  await ensureMigrationsTable(db);
  const applied = await listApplied(db);
  const appliedMap = new Map(applied.map((a) => [a.version, a]));

  const result: MigrateResult = { applied: [], skipped: [], alreadyUpToDate: false };

  // 1) 漂移检查：已应用迁移的内容不得变化
  for (const file of files) {
    const prev = appliedMap.get(file.version);
    if (prev && prev.checksum !== file.checksum) {
      throw new Error(
        `迁移 ${file.name} 内容已变更（checksum 不一致）：已应用的迁移不可修改，请新增迁移文件`,
      );
    }
  }

  // 2) 待执行
  const pending = files.filter((f) => !appliedMap.has(f.version));
  if (pending.length === 0) {
    result.alreadyUpToDate = true;
    result.skipped = files.map((f) => f.name);
    return result;
  }
  if (options.dryRun) {
    result.applied = pending.map((f) => f.name);
    return result;
  }

  for (const file of pending) {
    const startedAt = Date.now();
    await db.tx(async (tx) => {
      await tx.execute(file.sql);
      await tx.execute(
        'INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
        [file.version, file.name, file.checksum, Date.now() - startedAt],
      );
    });
    result.applied.push(file.name);
  }
  return result;
}
