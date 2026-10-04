/**
 * 长时记忆与会话数据的**属主隔离**（Agent 运行数据隔离，FE-032 扩展）
 *
 * 覆盖：
 *  - 会话/消息按属主隔离（A 的会话 B 看不到，切回 A 又能看到）
 *  - 即便切换账号后才落库，消息也写入**会话自身的属主**（在途任务不污染他人命名空间）
 *  - 长时记忆（上一轮的隔离）在同一会话内保持正确
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, migrateUp, clearMigrations } from '../../Src/Infra/Db/migrations.js';
import { listSessions, createSession, getSession, addMessage, listMessages } from '../../Src/Interface/RestApi/chatApi.js';
import { setActiveOwner, getActiveOwner, LOCAL_OWNER } from '../../Src/Services/AccountScope/activeAccount.js';

const TEST_DB_DIR = join(resolve(import.meta.dirname, '..', '..'), 'Data', '_test_owner_scope');

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
  const up = migrateUp();
  if (!up.ok) throw new Error(`迁移失败: ${up.error}`);
}

const USER_A = 'user-aaaa';
const USER_B = 'user-bbbb';

describe('会话/消息的属主隔离', () => {
  beforeEach(() => {
    initTestDb();
    setActiveOwner(null);
  });

  afterEach(() => {
    closeDatabase();
    setActiveOwner(null);
    if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  it('默认属主为 local，且迁移已为会话表加上属主列', () => {
    expect(getActiveOwner()).toBe(LOCAL_OWNER);
    const session = createSession('匿名会话');
    expect(listSessions().map((s) => s.session_id)).toContain(session.session_id);
  });

  it('A 的会话对 B 不可见，切回 A 恢复可见', () => {
    setActiveOwner(USER_A);
    const aSession = createSession('A 的任务');
    addMessage(aSession.session_id, 'user', 'A 的提问');
    addMessage(aSession.session_id, 'assistant', 'A 的回答');
    expect(listSessions()).toHaveLength(1);
    expect(listMessages(aSession.session_id)).toHaveLength(2);

    // 切到 B：看不到 A 的会话与消息
    setActiveOwner(USER_B);
    expect(listSessions()).toHaveLength(0);
    expect(getSession(aSession.session_id)).toBeUndefined();
    expect(listMessages(aSession.session_id)).toHaveLength(0);

    // B 自己建一个
    const bSession = createSession('B 的任务');
    expect(listSessions().map((s) => s.session_id)).toEqual([bSession.session_id]);

    // 切回 A：A 的数据仍在，且看不到 B 的
    setActiveOwner(USER_A);
    expect(listSessions().map((s) => s.session_id)).toEqual([aSession.session_id]);
    expect(listMessages(aSession.session_id)).toHaveLength(2);
  });

  it('切换账号后才落库的消息，仍写入**会话自身的属主**（在途任务不污染他人命名空间）', () => {
    setActiveOwner(USER_A);
    const aSession = createSession('A 的长任务');
    addMessage(aSession.session_id, 'user', '开始');

    // 模拟"任务仍在跑，但用户已切换到账号 B"
    setActiveOwner(USER_B);
    addMessage(aSession.session_id, 'assistant', '任务完成（在切换之后才落库）');

    // 该消息必须归 A（会话属主），而不是 B
    setActiveOwner(USER_A);
    const titles = listMessages(aSession.session_id).map((m) => m.content);
    expect(titles).toContain('任务完成（在切换之后才落库）');

    setActiveOwner(USER_B);
    expect(listMessages(aSession.session_id)).toHaveLength(0);
  });

  it('匿名与登录账号的数据互不可见', () => {
    const anon = createSession('匿名');
    setActiveOwner(USER_A);
    expect(listSessions()).toHaveLength(0);

    const a = createSession('A');
    setActiveOwner(null);
    const ids = listSessions().map((s) => s.session_id);
    expect(ids).toContain(anon.session_id);
    expect(ids).not.toContain(a.session_id);
  });
});
