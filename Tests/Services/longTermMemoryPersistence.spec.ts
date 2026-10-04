/**
 * 长时记忆持久化（2026-10-02）
 *
 * 修复背景：长时记忆此前只在进程内 Map —— 重启即丢，且 `memory_id` 计数器归零会导致
 * ID 重用（进而污染云端按 clientMemoryId 的幂等对齐）。本测试锁定：
 *  ① 写入落库；② 启动回灌；③ 计数器恢复（不重用 ID）；④ 批量导入幂等；
 *  ⑤ 状态变更落库；⑥ 数据库不可用时 fail-safe（内存仍可用，不抛错）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, migrateUp, clearMigrations } from '../../Src/Infra/Db/migrations.js';
import {
  writeMemory,
  resetLongTermMemory,
  hydrateLongTermMemory,
  listAllMemories,
  importMemories,
  deprecateMemory,
  getMemoryCount,
} from '../../Src/Services/SharedMemory/longTermMemory.js';
import { countRows } from '../../Src/Services/SharedMemory/longTermMemoryStore.js';

const TEST_DB_DIR = join(resolve(import.meta.dirname, '..', '..'), 'Data', '_test_ltm');

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

describe('长时记忆持久化', () => {
  beforeEach(() => {
    resetLongTermMemory();
    initTestDb();
  });
  afterEach(() => {
    resetLongTermMemory();
    cleanupDb();
  });

  it('写入即落库，字段完整（含 JSON 列）', () => {
    const result = writeMemory({
      title: '构建规范',
      content: 'TypeScript strict mode',
      category: 'rule',
      sourceTraceIds: ['trace-1', 'trace-2'],
      sourceArbitrationIds: ['arb-1'],
    });
    expect(result.ok).toBe(true);
    const memoryId = result.ok ? result.value.memoryId : '';

    const row = getMainDb().prepare('SELECT * FROM long_term_memory WHERE memory_id = ?').get(memoryId) as
      | Record<string, unknown>
      | undefined;
    expect(row).toBeDefined();
    expect(row?.['title']).toBe('构建规范');
    expect(row?.['category']).toBe('rule');
    expect(row?.['assertion']).toBe('observed');
    expect(JSON.parse(String(row?.['source_trace_ids_json']))).toEqual(['trace-1', 'trace-2']);
    expect(JSON.parse(String(row?.['source_arbitration_ids_json']))).toEqual(['arb-1']);
    expect(countRows()).toBe(1);
  });

  it('回灌：进程重启（内存清空）后记忆从库恢复', () => {
    writeMemory({ title: 'A', content: '内容A', category: 'fact', sourceTraceIds: ['t1'] });
    writeMemory({ title: 'B', content: '内容B', category: 'decision', sourceTraceIds: ['t2'] });
    expect(getMemoryCount()).toBe(2);

    // 模拟重启：仅清内存
    resetLongTermMemory();
    expect(getMemoryCount()).toBe(0);

    const hydrated = hydrateLongTermMemory();
    expect(hydrated.ok).toBe(true);
    expect(hydrated.ok ? hydrated.value : -1).toBe(2);
    expect(getMemoryCount()).toBe(2);
    expect(listAllMemories().map((m) => m.title).sort()).toEqual(['A', 'B']);
  });

  it('★ 计数器恢复：回灌后新记忆不复用旧 ID（防云端幂等键串号）', () => {
    const first = writeMemory({ title: 'A', content: 'a', category: 'fact', sourceTraceIds: [] });
    const second = writeMemory({ title: 'B', content: 'b', category: 'fact', sourceTraceIds: [] });
    expect(first.ok && first.value.memoryId).toBe('ltm-1');
    expect(second.ok && second.value.memoryId).toBe('ltm-2');

    resetLongTermMemory();
    hydrateLongTermMemory();

    const third = writeMemory({ title: 'C', content: 'c', category: 'fact', sourceTraceIds: [] });
    expect(third.ok).toBe(true);
    // 关键：必须是 ltm-3，而不是重新从 ltm-1 开始
    expect(third.ok ? third.value.memoryId : '').toBe('ltm-3');
    const ids = listAllMemories().map((m) => m.memoryId).sort();
    expect(new Set(ids).size).toBe(3);
  });

  it('批量导入（云端恢复）：新增/更新计数正确且落库', () => {
    const imported = importMemories([
      {
        memoryId: 'ltm-cloud-1', title: '云端记忆1', content: 'c1', category: 'fact',
        sourceTraceIds: ['t1'], assertion: 'observed', createdAt: 1000, lastAccessedAt: 1000,
        accessCount: 0, status: 'active',
      },
      {
        memoryId: 'ltm-cloud-2', title: '云端记忆2', content: 'c2', category: 'rule',
        sourceTraceIds: [], assertion: 'observed', createdAt: 2000, lastAccessedAt: 2000,
        accessCount: 3, status: 'active',
      },
    ]);
    expect(imported.ok && imported.value).toEqual({ imported: 2, updated: 0 });
    expect(countRows()).toBe(2);

    // 再次导入同 ID → 计为更新，不产生重复
    const again = importMemories([
      {
        memoryId: 'ltm-cloud-1', title: '云端记忆1（改）', content: 'c1-new', category: 'fact',
        sourceTraceIds: [], assertion: 'observed', createdAt: 1000, lastAccessedAt: 3000,
        accessCount: 5, status: 'active',
      },
    ]);
    expect(again.ok && again.value).toEqual({ imported: 0, updated: 1 });
    expect(countRows()).toBe(2);
    const row = getMainDb()
      .prepare('SELECT title, access_count FROM long_term_memory WHERE memory_id = ?')
      .get('ltm-cloud-1') as { title: string; access_count: number };
    expect(row.title).toBe('云端记忆1（改）');
    expect(row.access_count).toBe(5);
  });

  it('状态变更落库（deprecated）', () => {
    const created = writeMemory({ title: '临时', content: 'x', category: 'fact', sourceTraceIds: [] });
    const memoryId = created.ok ? created.value.memoryId : '';
    expect(deprecateMemory(memoryId, '测试').ok).toBe(true);

    const row = getMainDb()
      .prepare('SELECT status FROM long_term_memory WHERE memory_id = ?')
      .get(memoryId) as { status: string };
    expect(row.status).toBe('deprecated');
  });

  it('fail-safe：数据库不可用时写入仍成功（仅内存），回灌返回错误而不抛异常', () => {
    cleanupDb(); // 关闭数据库
    resetLongTermMemory();

    const result = writeMemory({ title: '无库', content: 'x', category: 'fact', sourceTraceIds: [] });
    expect(result.ok).toBe(true); // 不因持久化失败中断调用方
    expect(getMemoryCount()).toBe(1);

    const hydrated = hydrateLongTermMemory();
    expect(hydrated.ok).toBe(false);
  });
});
