/**
 * memory_entries KV 视图投影（FE-034）
 *
 * 修复背景：`memory_entries` 在代码中**从未创建** —— `GET /api/memory/entries`
 * 与 `ipc-get-memory-entries`（前端「记忆」视图数据源）都查这张表，因表缺失恒为空。
 * 本测试锁定：
 *  ① 迁移 memory v1 建表（含索引）；② 写记忆即投影；③ 更新 version 自增、
 *  created_at 保留；④ 状态变更同步；⑤ 属主隔离（同 key 互不覆盖）；
 *  ⑥ 回灌补齐存量且幂等；⑦ fail-safe（数据库不可用时静默）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

import { initDatabase, closeDatabase, getMemoryDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, migrateUp, clearMigrations } from '../../Src/Infra/Db/migrations.js';
import {
  writeMemory,
  resetLongTermMemory,
  hydrateLongTermMemory,
  importMemories,
  deprecateMemory,
  type LongTermMemoryEntry,
} from '../../Src/Services/SharedMemory/longTermMemory.js';
import { setActiveOwner, LOCAL_OWNER } from '../../Src/Services/AccountScope/activeAccount.js';
import {
  projectMemoryEntry,
  countProjected,
  LTM_NAMESPACE,
} from '../../Src/Services/SharedMemory/memoryEntryStore.js';

const TEST_DB_DIR = join(resolve(import.meta.dirname, '..', '..'), 'Data', '_test_memkv');

function initTestDb(): void {
  closeDatabase();
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  clearMigrations();
  mkdirSync(TEST_DB_DIR, { recursive: true });
  const result = initDatabase({
    mainPath: join(TEST_DB_DIR, 'test_main.db'),
    eventsPath: join(TEST_DB_DIR, 'test_events.db'),
    memoryPath: join(TEST_DB_DIR, 'test_memory.db'),
    walMode: true,
    busyTimeoutMs: 5000,
  });
  expect(result.ok).toBe(true);
  initMigrations();
  migrateUp();
}

function cleanupDb(): void {
  closeDatabase();
  clearMigrations();
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

function readRow(key: string, owner: string = LOCAL_OWNER): Record<string, unknown> | undefined {
  return getMemoryDb()
    .prepare('SELECT * FROM memory_entries WHERE owner_user_id = ? AND key = ?')
    .get(owner, key) as Record<string, unknown> | undefined;
}

describe('memory_entries KV 视图投影（FE-034）', () => {
  beforeEach(() => {
    setActiveOwner(null);
    resetLongTermMemory();
    initTestDb();
  });
  afterEach(() => {
    setActiveOwner(null);
    resetLongTermMemory();
    cleanupDb();
  });

  it('迁移建立 memory_entries 表与索引', () => {
    const table = getMemoryDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries'",
    ).get() as { name: string } | undefined;
    expect(table?.name).toBe('memory_entries');

    const index = getMemoryDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_entries_ns'",
    ).get() as { name: string } | undefined;
    expect(index?.name).toBe('idx_memory_entries_ns');
  });

  it('写入即投影：key=memoryId、namespace=long-term、value 为条目 JSON', () => {
    const created = writeMemory({ title: '规范', content: 'strict', category: 'rule', sourceTraceIds: ['t1'] });
    expect(created.ok).toBe(true);
    const entry = created.ok ? created.value : null;
    expect(countProjected()).toBe(1);

    const row = readRow(entry!.memoryId);
    expect(row).toBeDefined();
    expect(row?.['namespace']).toBe(LTM_NAMESPACE);
    expect(row?.['version']).toBe(1);
    expect(row?.['created_at']).toBe(entry!.createdAt);
    const value = JSON.parse(String(row?.['value'])) as { title: string; status: string; memoryId: string };
    expect(value.memoryId).toBe(entry!.memoryId);
    expect(value.title).toBe('规范');
    expect(value.status).toBe('active');
  });

  it('更新投影：version 自增、created_at 保留首写值', () => {
    const created = writeMemory({ title: 'A', content: 'a', category: 'fact', sourceTraceIds: [] });
    const entry = created.ok ? created.value : null;
    const first = readRow(entry!.memoryId);
    const createdAt = first?.['created_at'];

    // 状态变更走更新路径（ON CONFLICT UPDATE）
    expect(deprecateMemory(entry!.memoryId, '测试').ok).toBe(true);

    const row = readRow(entry!.memoryId);
    expect(row?.['version']).toBe(2);
    expect(row?.['created_at']).toBe(createdAt);
    const value = JSON.parse(String(row?.['value'])) as { status: string };
    expect(value.status).toBe('deprecated');
  });

  it('属主隔离：同 key 不同属主互不覆盖（复合主键）', () => {
    const entry: LongTermMemoryEntry = {
      memoryId: 'ltm-1', title: 'A 的记忆', content: 'a', category: 'fact',
      sourceTraceIds: [], assertion: 'observed', createdAt: 1000, lastAccessedAt: 1000,
      accessCount: 0, status: 'active',
    };
    projectMemoryEntry(entry, 'user-a');
    projectMemoryEntry({ ...entry, title: 'B 的记忆' }, 'user-b');

    expect(countProjected('user-a')).toBe(1);
    expect(countProjected('user-b')).toBe(1);
    const a = readRow('ltm-1', 'user-a');
    const b = readRow('ltm-1', 'user-b');
    expect(JSON.parse(String(a?.['value'])).title).toBe('A 的记忆');
    expect(JSON.parse(String(b?.['value'])).title).toBe('B 的记忆');
  });

  it('批量导入（云端恢复）同样投影', () => {
    const imported = importMemories([
      {
        memoryId: 'ltm-cloud-1', title: '云端记忆', content: 'c1', category: 'fact',
        sourceTraceIds: [], assertion: 'observed', createdAt: 1000, lastAccessedAt: 1000,
        accessCount: 0, status: 'active',
      },
    ]);
    expect(imported.ok).toBe(true);
    expect(countProjected()).toBe(1);
    const row = readRow('ltm-cloud-1');
    expect(row?.['namespace']).toBe(LTM_NAMESPACE);
  });

  it('回灌补齐存量投影：INSERT OR IGNORE 幂等，不覆盖已有 version', () => {
    writeMemory({ title: 'A', content: 'a', category: 'fact', sourceTraceIds: [] });
    writeMemory({ title: 'B', content: 'b', category: 'fact', sourceTraceIds: [] });
    expect(countProjected()).toBe(2);

    // 模拟"历史记忆从未投影"：清空 KV 视图后回灌补齐
    getMemoryDb().prepare('DELETE FROM memory_entries').run();
    expect(countProjected()).toBe(0);

    resetLongTermMemory();
    const hydrated = hydrateLongTermMemory();
    expect(hydrated.ok).toBe(true);
    expect(countProjected()).toBe(2);
    expect(readRow('ltm-1')?.['version']).toBe(1);

    // 幂等：重复回灌不 bump version
    hydrateLongTermMemory();
    expect(readRow('ltm-1')?.['version']).toBe(1);
    expect(countProjected()).toBe(2);
  });

  it('fail-safe：数据库不可用时投影静默，记忆写入仍成功', () => {
    cleanupDb(); // 关闭数据库
    resetLongTermMemory();

    const result = writeMemory({ title: '无库', content: 'x', category: 'fact', sourceTraceIds: [] });
    expect(result.ok).toBe(true); // 不因投影/持久化失败中断调用方
    expect(countProjected()).toBe(0);
  });
});
