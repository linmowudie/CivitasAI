/**
 * G-13③ 验收（2026-10-04）：GlobalWorkspace 属主隔离 + 持久化
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { write, read, resetGlobalWorkspace, hydrateGlobalWorkspace, loadPersistedEntries, getMemoryEntryCount } from '../../Src/Services/SharedMemory/globalWorkspace.js';
import { setActiveOwner } from '../../Src/Services/AccountScope/activeAccount.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_gw_owner');
function initDb() {
  closeDatabase(); clearMigrations();
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  initDatabase({ mainPath: join(DIR, 'm.db'), eventsPath: join(DIR, 'e.db'), memoryPath: join(DIR, 'mm.db'), walMode: true, busyTimeoutMs: 5000 });
  initMigrations(); migrateUp();
}

describe('G-13③ 共享记忆属主隔离 + 持久化', () => {
  beforeEach(() => { initDb(); resetGlobalWorkspace(); setActiveOwner('alice'); });
  afterEach(() => { closeDatabase(); clearMigrations(); if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });

  it('★ 写入即落库（含属主列）', () => {
    const r = write({ key: 'task_context.s1', content: '共享事实', contentType: 'fact', assertion: 'observed', traceId: 't1', agentId: 'agent-1' });
    expect(r.ok).toBe(true);
    const rows = loadPersistedEntries('alice');
    expect(rows.length).toBe(1);
    expect(rows[0]!.content).toBe('共享事实');
  });

  it('★ 跨账号隔离：bob 看不到 alice 的共享记忆', () => {
    write({ key: 'task_context.s1', content: 'alice 的秘密', contentType: 'fact', assertion: 'observed', traceId: 't1', agentId: 'agent-1' });
    setActiveOwner('bob');
    resetGlobalWorkspace();
    expect(read({}).length).toBe(0);
    expect(loadPersistedEntries('bob').length).toBe(0);
    setActiveOwner('alice');
    expect(read({}).length).toBe(1);
  });

  it('★ 重启回灌：清空内存后仍能读回（此前重启即丢）', () => {
    write({ key: 'regulation.broadcast.rule_update.b1', content: '行为准则更新 :: R-001 生效', contentType: 'decision', assertion: 'observed', traceId: 'gov:auditor', agentId: 'governance:auditor', actorRole: 'auditor' });
    resetGlobalWorkspace();  // 模拟进程重启（内存清空，库保留）
    expect(getMemoryEntryCount()).toBe(0);          // 内存视图已空
    expect(read({}).length).toBe(1);                // 但**读路径已合并持久化条目** → 重启不丢
    const hydrated = hydrateGlobalWorkspace();      // 显式回灌（启动期 main.ts ⑦.4 走这条）
    expect(hydrated.ok).toBe(true);
    if (hydrated.ok) expect(hydrated.value).toBe(1);
    expect(getMemoryEntryCount()).toBe(1);          // 内存缓存已恢复
    const after = read({});
    expect(after.length).toBe(1);
    expect(after[0]!.key).toContain('regulation.broadcast');
  });
});
