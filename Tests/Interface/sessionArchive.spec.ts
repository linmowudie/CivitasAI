/**
 * 任务归档（本地后端）测试。
 *
 * 覆盖：
 *  - 归档是**软状态**：消息与任务都不被删除，归档后仍能打开、读消息；
 *  - 列表过滤：默认只返回未归档；`archived: true` 只返回已归档；`'all'` 返回全部；
 *  - 取消归档回到未归档列表；
 *  - **属主隔离**：只能归档当前账号名下的任务，切号后看不到、也归档不了；
 *  - 幂等：重复归档时间戳更新但不产生重复任务。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import {
  listSessions,
  createSession,
  archiveSession,
  addMessage,
  listMessages,
  getSession,
} from '../../Src/Interface/RestApi/chatApi.js';
import { setActiveOwner, LOCAL_OWNER } from '../../Src/Services/AccountScope/activeAccount.js';

const TEST_DB_DIR = resolve(import.meta.dirname, '../../.tmp/test-db-session-archive');

function initTestDb(): void {
  closeDatabase();
  clearMigrations();
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
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
  setActiveOwner(LOCAL_OWNER);
}

describe('任务归档（本地后端）', () => {
  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    closeDatabase();
    clearMigrations();
    if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  it('归档后从默认列表消失、出现在已归档列表；消息不丢', () => {
    const a = createSession('任务 A');
    const b = createSession('任务 B');
    addMessage(a.session_id, 'user', '归档前写入的消息', undefined, 0);

    expect(listSessions().map((s) => s.session_id).sort()).toEqual([a.session_id, b.session_id].sort());

    const result = archiveSession(a.session_id, true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.archived_at).toBeGreaterThan(0);
      expect(result.value.title).toBe('任务 A');
    }

    // 默认列表只剩 B
    expect(listSessions().map((s) => s.session_id)).toEqual([b.session_id]);
    // 已归档列表只剩 A
    expect(listSessions({ archived: true }).map((s) => s.session_id)).toEqual([a.session_id]);
    // 全部列表两者都在
    expect(listSessions({ archived: 'all' })).toHaveLength(2);

    // 软状态：消息仍在，任务仍可打开
    expect(getSession(a.session_id)?.session_id).toBe(a.session_id);
    const messages = listMessages(a.session_id);
    expect(messages.some((m) => m.content === '归档前写入的消息')).toBe(true);
  });

  it('取消归档后回到未归档列表', () => {
    const a = createSession('任务 A');
    archiveSession(a.session_id, true);
    expect(listSessions()).toHaveLength(0);

    const back = archiveSession(a.session_id, false);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value.archived_at ?? null).toBeNull();
    expect(listSessions().map((s) => s.session_id)).toEqual([a.session_id]);
    expect(listSessions({ archived: true })).toHaveLength(0);
  });

  it('重复归档幂等：不产生重复任务，仅刷新时间戳', () => {
    const a = createSession('任务 A');
    const first = archiveSession(a.session_id, true);
    const second = archiveSession(a.session_id, true);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.archived_at).toBeGreaterThanOrEqual(first.value.archived_at ?? 0);
    }
    expect(listSessions({ archived: true })).toHaveLength(1);
    expect(listSessions({ archived: 'all' })).toHaveLength(1);
  });

  it('★ 属主隔离：切号后看不到对方任务，也归档不了', () => {
    const mine = createSession('我的任务');
    expect(listSessions()).toHaveLength(1);

    // 切到另一个账号
    setActiveOwner('user-other');
    expect(listSessions({ archived: 'all' })).toHaveLength(0);

    // 尝试归档他人任务 → 视为不存在
    const denied = archiveSession(mine.session_id, true);
    expect(denied.ok).toBe(false);

    // 切回原账号：任务仍是未归档状态（未被他人改动）
    setActiveOwner(LOCAL_OWNER);
    const view = listSessions({ archived: 'all' });
    expect(view).toHaveLength(1);
    expect(view[0]!.archived_at ?? null).toBeNull();
  });

  it('归档不存在的任务返回失败（不抛异常）', () => {
    const result = archiveSession('sess-not-exist', true);
    expect(result.ok).toBe(false);
  });

  it('归档状态落库（archived_at 列可读）', () => {
    const a = createSession('任务 A');
    archiveSession(a.session_id, true);
    const row = getMainDb()
      .prepare('SELECT archived_at FROM chat_sessions WHERE session_id = ?')
      .get(a.session_id) as { archived_at: number | null };
    expect(row.archived_at).toBeGreaterThan(0);
  });
});
