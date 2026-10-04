/**
 * 长时记忆的**属主隔离**（跨账号数据不隔离修复，FE-032）
 *
 * 关注：A/B 两个账号的数据互不可见；切换属主会清空内存并回灌；
 * 复合主键允许两个账号各自拥有 `ltm-1` 而不互相覆盖；导入只作用于当前属主。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, migrateUp, clearMigrations } from '../../Src/Infra/Db/migrations.js';
import {
  writeMemory,
  listAllMemories,
  hydrateLongTermMemory,
  importMemories,
  setActiveOwner,
  getActiveOwner,
  resetLongTermMemory,
  type LongTermMemoryEntry,
} from '../../Src/Services/SharedMemory/longTermMemory.js';
import { countByOwner, LOCAL_OWNER } from '../../Src/Services/SharedMemory/longTermMemoryStore.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TEST_DB_DIR = join(ROOT, 'Data', '_test_ltm_owner');

function setupDb(): void {
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
  if (!result.ok) throw new Error(`初始化测试数据库失败: ${result.error}`);
  initMigrations();
  const up = migrateUp();
  if (!up.ok) throw new Error(`迁移失败: ${up.error}`);
}

const USER_A = 'user-aaaa';
const USER_B = 'user-bbbb';

function writeOne(title: string): string {
  const res = writeMemory({ title, content: `${title} 内容`, category: 'fact', sourceTraceIds: [] });
  if (!res.ok) throw new Error(res.error);
  return res.value.memoryId;
}

describe('长时记忆属主隔离', () => {
  beforeEach(() => {
    closeDatabase();
    setupDb();
    setActiveOwner(null);
    resetLongTermMemory();
    hydrateLongTermMemory();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  it('默认属主为 local（未登录）', () => {
    expect(getActiveOwner()).toBe(LOCAL_OWNER);
  });

  it('A 写的记忆对 B 不可见（内存与库都隔离）', () => {
    setActiveOwner(USER_A);
    hydrateLongTermMemory();
    writeOne('A 的私密记忆');
    expect(listAllMemories()).toHaveLength(1);

    // 切换到 B：内存被清空，看不到 A 的数据
    expect(setActiveOwner(USER_B)).toBe(true);
    hydrateLongTermMemory();
    expect(listAllMemories()).toHaveLength(0);
    expect(getActiveOwner()).toBe(USER_B);

    // B 自己写一条，互不影响
    writeOne('B 的记忆');
    expect(listAllMemories().map((m) => m.title)).toEqual(['B 的记忆']);

    // 切回 A：A 的数据仍在
    setActiveOwner(USER_A);
    hydrateLongTermMemory();
    expect(listAllMemories().map((m) => m.title)).toEqual(['A 的私密记忆']);
  });

  it('两个账号可以各自拥有 ltm-1 而不互相覆盖（复合主键）', () => {
    setActiveOwner(USER_A);
    hydrateLongTermMemory();
    const aId = writeOne('A 的 ltm-1');

    setActiveOwner(USER_B);
    hydrateLongTermMemory();
    const bId = writeOne('B 的 ltm-1');

    expect(aId).toBe(bId); // 同号不同属主
    const counts = Object.fromEntries(countByOwner().map((r) => [r.owner, r.count]));
    expect(counts[USER_A]).toBe(1);
    expect(counts[USER_B]).toBe(1);

    // 内容各自独立
    setActiveOwner(USER_A);
    hydrateLongTermMemory();
    expect(listAllMemories()[0]!.content).toBe('A 的 ltm-1 内容');
  });

  it('导入只写入当前属主', () => {
    const entry: LongTermMemoryEntry = {
      memoryId: 'ltm-900',
      title: '来自云端的记忆',
      content: '云端内容',
      category: 'rule',
      sourceTraceIds: [],
      assertion: 'observed',
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      status: 'active',
    };

    setActiveOwner(USER_B);
    hydrateLongTermMemory();
    const res = importMemories([entry]);
    expect(res.ok).toBe(true);

    const counts = Object.fromEntries(countByOwner().map((r) => [r.owner, r.count]));
    expect(counts[USER_B]).toBe(1);
    expect(counts[USER_A]).toBeUndefined();

    // 匿名命名空间不受影响
    setActiveOwner(null);
    hydrateLongTermMemory();
    expect(listAllMemories()).toHaveLength(0);
  });

  it('切换属主会重置 ID 计数器（各账号从自己的最大序号继续）', () => {
    setActiveOwner(USER_A);
    hydrateLongTermMemory();
    writeOne('A-1');
    writeOne('A-2');

    setActiveOwner(USER_B);
    hydrateLongTermMemory();
    const b1 = writeOne('B-1');
    expect(b1).toBe('ltm-1'); // B 从 1 开始（不与 A 冲突）

    setActiveOwner(USER_A);
    hydrateLongTermMemory();
    const a3 = writeOne('A-3');
    expect(a3).toBe('ltm-3'); // A 从自己的最大序号继续
  });

  it('setActiveOwner 对相同属主返回 false（避免无谓回灌）', () => {
    setActiveOwner(USER_A);
    expect(setActiveOwner(USER_A)).toBe(false);
    expect(setActiveOwner(null)).toBe(true);
    expect(getActiveOwner()).toBe(LOCAL_OWNER);
  });
});
