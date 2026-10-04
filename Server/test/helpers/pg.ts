/**
 * @module test/helpers/pg
 * @description 集成测试用数据库：连接、迁移、清表。
 *
 * 连接串优先级：TEST_DATABASE_URL > 默认本地测试库。
 * 若数据库不可用，集成测试会 **跳过**（并打印提示），保证 `npm test` 在无库环境也能跑单元测试。
 */

import { resolve } from 'node:path';
import { createDb, type Db } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { SERVER_ROOT } from '../../src/config.js';

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:55432/civitas_server_test';

const MIGRATIONS_DIR = resolve(SERVER_ROOT, 'migrations');

const TEST_DB_CONFIG = {
  poolMax: 5,
  idleTimeoutMs: 5_000,
  connectionTimeoutMs: 3_000,
  statementTimeoutMs: 15_000,
};

let cachedDb: Db | null = null;
let available: boolean | null = null;

/** 探测测试库是否可用（结果缓存） */
export async function isDbAvailable(): Promise<boolean> {
  if (available !== null) return available;
  const probe = createDb(TEST_DATABASE_URL, { ...TEST_DB_CONFIG, connectionTimeoutMs: 1_500 });
  try {
    available = await probe.ping();
    if (available) await runMigrations(probe, MIGRATIONS_DIR);
  } catch {
    available = false;
  } finally {
    if (!available) await probe.close().catch(() => undefined);
  }
  if (!available) {
    console.warn(
      `\n[test] 跳过集成测试：测试数据库不可用（${TEST_DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')}）\n` +
        '       启动方式：npm run db:up（Docker）或参考 README 的本地 PostgreSQL 方式\n',
    );
  } else if (cachedDb === null) {
    cachedDb = probe;
  }
  return available;
}

/** 取测试库连接（首次调用会执行迁移） */
export async function getTestDb(): Promise<Db> {
  if (cachedDb) return cachedDb;
  const ok = await isDbAvailable();
  if (!ok || !cachedDb) throw new Error('测试数据库不可用');
  return cachedDb;
}

/** 清空全部业务表（每个用例前调用；保留 schema_migrations） */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(`
    TRUNCATE TABLE
      audit_log, verification_codes, user_devices, usage_events, memories,
      user_settings, refresh_tokens, users
    RESTART IDENTITY CASCADE
  `);
}

export async function closeTestDb(): Promise<void> {
  if (cachedDb) {
    await cachedDb.close().catch(() => undefined);
    cachedDb = null;
    available = null;
  }
}
