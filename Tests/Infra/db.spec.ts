/**
 * S1-⑥ Infra/Db 模块测试
 *
 * 覆盖：database / migrations / transaction / sessionRepository
 * Gate G1 要求：迁移可上可下（up/down 幂等）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase, isDatabaseInitialized, getMainDb, getEventsDb, getMemoryDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, migrateUp, migrateDown, getAppliedMigrations, getCurrentVersion, clearMigrations } from '../../Src/Infra/Db/migrations.js';
import { transaction } from '../../Src/Infra/Db/transaction.js';
import { createSession, getSession, updateLastActive, archiveSession, listActiveSessions } from '../../Src/Infra/Db/Repositories/sessionRepository.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TEST_DB_DIR = join(ROOT, 'Data', '_test_db');

function cleanup(): void {
  closeDatabase();
  if (existsSync(TEST_DB_DIR)) {
    rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

function initTestDb(): void {
  cleanup();
  mkdirSync(TEST_DB_DIR, { recursive: true });
  const result = initDatabase({
    mainPath: join(TEST_DB_DIR, 'test_main.db'),
    eventsPath: join(TEST_DB_DIR, 'test_events.db'),
    memoryPath: join(TEST_DB_DIR, 'test_memory.db'),
    walMode: true,
    busyTimeoutMs: 5000,
  });
  expect(result.ok).toBe(true);
}

describe('S1-⑥ Db 模块', () => {
  afterEach(() => {
    cleanup();
    clearMigrations();
  });

  // ===== database =====
  describe('database', () => {
    it('初始化三库连接成功', () => {
      initTestDb();
      expect(isDatabaseInitialized()).toBe(true);
      expect(getMainDb()).toBeTruthy();
      expect(getEventsDb()).toBeTruthy();
      expect(getMemoryDb()).toBeTruthy();
    });

    it('WAL 模式已启用', () => {
      initTestDb();
      const mode = getMainDb().pragma('journal_mode', { simple: true });
      expect(mode).toBe('wal');
    });

    it('foreign_keys 已启用', () => {
      initTestDb();
      const fk = getMainDb().pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
    });

    it('closeDatabase 关闭连接', () => {
      initTestDb();
      closeDatabase();
      expect(isDatabaseInitialized()).toBe(false);
    });

    it('未初始化时 getDatabases 抛异常', () => {
      expect(() => getMainDb()).toThrow('数据库未初始化');
    });
  });

  // ===== migrations =====
  describe('migrations', () => {
    beforeEach(() => {
      initTestDb();
      const initResult = initMigrations();
      expect(initResult.ok).toBe(true);
    });

    it('migrateUp 应用所有迁移', () => {
      const result = migrateUp();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeGreaterThan(0);
      }
    });

    it('migrateUp 幂等（重复运行不报错）', () => {
      migrateUp();
      const result = migrateUp();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0); // 没有新的迁移
      }
    });

    it('migrateDown 回滚最后一次迁移', () => {
      migrateUp();
      const versionBefore = getCurrentVersion();
      expect(versionBefore).toBeGreaterThan(0);

      const result = migrateDown();
      expect(result.ok).toBe(true);

      const versionAfter = getCurrentVersion();
      expect(versionAfter).toBeLessThan(versionBefore);
    });

    it('getAppliedMigrations 返回已应用列表', () => {
      migrateUp();
      const applied = getAppliedMigrations();
      expect(applied.length).toBeGreaterThan(0);
      expect(applied[0]).toHaveProperty('version');
      expect(applied[0]).toHaveProperty('name');
    });

    it('sessions 表可创建和查询', () => {
      migrateUp();
      // 验证 sessions 表存在
      const tables = getMainDb().prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
      ).all();
      expect(tables.length).toBe(1);
    });

    it('up → down → up 幂等（Gate G1）', () => {
      migrateUp();
      const v1 = getCurrentVersion();
      migrateDown();
      migrateUp();
      const v2 = getCurrentVersion();
      expect(v2).toBe(v1);
    });
  });

  // ===== transaction =====
  describe('transaction', () => {
    beforeEach(() => {
      initTestDb();
      initMigrations();
      migrateUp();
    });

    it('事务成功提交', () => {
      const result = transaction(() => {
        createSession({
          sessionKey: 'test-key-1',
          status: 'active',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        });
        return 'done';
      });
      expect(result.ok).toBe(true);

      const session = getSession('test-key-1');
      expect(session.ok).toBe(true);
      if (session.ok) {
        expect(session.value).not.toBeNull();
        expect(session.value!.sessionKey).toBe('test-key-1');
      }
    });

    it('事务失败自动回滚', () => {
      transaction(() => {
        createSession({
          sessionKey: 'test-key-2',
          status: 'active',
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        });
        throw new Error('模拟失败');
      });

      const session = getSession('test-key-2');
      expect(session.ok).toBe(true);
      if (session.ok) {
        expect(session.value).toBeNull(); // 回滚了
      }
    });
  });

  // ===== sessionRepository =====
  describe('sessionRepository', () => {
    beforeEach(() => {
      initTestDb();
      initMigrations();
      migrateUp();
    });

    it('createSession + getSession', () => {
      const now = Date.now();
      const result = createSession({
        sessionKey: 'abc123',
        traceId: 'trace-001',
        userId: 'user-1',
        description: '测试会话',
        status: 'active',
        createdAt: now,
        lastActiveAt: now,
      });
      expect(result.ok).toBe(true);

      const fetched = getSession('abc123');
      expect(fetched.ok).toBe(true);
      if (fetched.ok && fetched.value) {
        expect(fetched.value.sessionKey).toBe('abc123');
        expect(fetched.value.traceId).toBe('trace-001');
        expect(fetched.value.description).toBe('测试会话');
      }
    });

    it('getSession 不存在的返回 null', () => {
      const result = getSession('nonexistent');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('updateLastActive 更新时间', () => {
      const now = Date.now();
      createSession({ sessionKey: 'key1', status: 'active', createdAt: now, lastActiveAt: now });
      updateLastActive('key1', now + 1000);

      const session = getSession('key1');
      if (session.ok && session.value) {
        expect(session.value.lastActiveAt).toBe(now + 1000);
      }
    });

    it('archiveSession 归档', () => {
      const now = Date.now();
      createSession({ sessionKey: 'key2', status: 'active', createdAt: now, lastActiveAt: now });
      archiveSession('key2', now + 5000);

      const session = getSession('key2');
      if (session.ok && session.value) {
        expect(session.value.status).toBe('archived');
        expect(session.value.archivedAt).toBe(now + 5000);
      }
    });

    it('listActiveSessions 只返回活跃', () => {
      const now = Date.now();
      createSession({ sessionKey: 'a1', status: 'active', createdAt: now, lastActiveAt: now });
      createSession({ sessionKey: 'a2', status: 'active', createdAt: now, lastActiveAt: now + 1 });
      createSession({ sessionKey: 'a3', status: 'archived', createdAt: now, lastActiveAt: now + 2 });

      const result = listActiveSessions();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });
  });
});
