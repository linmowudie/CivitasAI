/**
 * 会话工作目录锁定（2026-10-08 业务规则）。
 *
 * 规则：**任务一旦产生对话，当前任务内不允许再切换工作目录**；需要换目录请新建任务。
 * 背景：中途换根会让已产生的工具结果、文件引用与模型上下文里的 `[ctx:workspace]`（仍是旧目录）
 * 全部失效，表现为"文件突然找不到"，比直接拒绝更难排查。
 *
 * 覆盖：
 *  - 空对话（新任务）→ 可以设置/重置目录；
 *  - 有对话 → 拒绝，且目录保持原值；
 *  - 幂等：重复设置同一目录不报错（便于客户端重试/回显）；
 *  - 内部回填：迁移前创建的老会话（work_dir 为空）即使已有对话也能补齐默认目录；
 *  - 属主隔离：别人的会话改不了。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import {
  createSession,
  addMessage,
  getSession,
  updateSessionWorkDir,
  ensureSessionWorkDir,
  hasConversation,
  isWorkDirLocked,
  WORK_DIR_LOCKED_MESSAGE,
} from '../../Src/Interface/RestApi/chatApi.js';
import { setActiveOwner, LOCAL_OWNER } from '../../Src/Services/AccountScope/activeAccount.js';

const TEST_DB_DIR = resolve(import.meta.dirname, '../../.tmp/test-db-workdir-lock');
const ALT_DIR = resolve(import.meta.dirname, '../../.tmp/test-db-workdir-lock-alt');

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

describe('会话工作目录锁定', () => {
  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    closeDatabase();
    clearMigrations();
    if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  it('新任务（空对话）可以设置工作目录', () => {
    const s = createSession('新任务');
    expect(hasConversation(s.session_id)).toBe(false);

    const r = updateSessionWorkDir(s.session_id, ALT_DIR);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.work_dir).toBe(resolve(ALT_DIR));
    expect(getSession(s.session_id)?.work_dir).toBe(resolve(ALT_DIR));
  });

  it('新任务可以重置为默认目录', () => {
    const s = createSession('新任务');
    updateSessionWorkDir(s.session_id, ALT_DIR);
    const r = updateSessionWorkDir(s.session_id, null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.work_dir).toContain(`workspaces`);
  });

  it('已有对话 → 切换目录被拒绝，且目录保持原值', () => {
    const s = createSession('有对话的任务');
    updateSessionWorkDir(s.session_id, ALT_DIR);
    const before = getSession(s.session_id)?.work_dir;
    addMessage(s.session_id, 'user', '第一条消息', undefined, 0);
    expect(hasConversation(s.session_id)).toBe(true);

    const r = updateSessionWorkDir(s.session_id, resolve(TEST_DB_DIR, 'another-dir'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(WORK_DIR_LOCKED_MESSAGE);
    expect(getSession(s.session_id)?.work_dir).toBe(before);
  });

  it('已有对话 → 重置为默认目录（构成变更）同样被拒绝', () => {
    const s = createSession('有对话的任务');
    updateSessionWorkDir(s.session_id, ALT_DIR); // 空对话时先改到自定义目录
    addMessage(s.session_id, 'user', 'hi', undefined, 0);
    const before = getSession(s.session_id)?.work_dir;

    const r = updateSessionWorkDir(s.session_id, null);
    expect(r.ok).toBe(false);
    expect(getSession(s.session_id)?.work_dir).toBe(before);
  });

  it('幂等：重复设置同一目录在锁定时不报错（客户端重试/回显友好）', () => {
    const s = createSession('幂等');
    updateSessionWorkDir(s.session_id, ALT_DIR);
    addMessage(s.session_id, 'user', 'hi', undefined, 0);

    const r = updateSessionWorkDir(s.session_id, ALT_DIR);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.work_dir).toBe(resolve(ALT_DIR));
  });

  it('isWorkDirLocked：空对话 false；有对话且换目录 true；同目录 false', () => {
    const s = createSession('判据');
    expect(isWorkDirLocked(s.session_id, ALT_DIR)).toBe(false);

    updateSessionWorkDir(s.session_id, ALT_DIR);
    addMessage(s.session_id, 'user', 'hi', undefined, 0);

    expect(isWorkDirLocked(s.session_id, ALT_DIR)).toBe(false);            // 同目录 → 幂等
    expect(isWorkDirLocked(s.session_id, resolve(TEST_DB_DIR, 'x'))).toBe(true);
  });

  it('内部回填：老会话（work_dir 为空）即使已有对话也能补齐默认目录', () => {
    const s = createSession('老会话');
    // 模拟迁移前创建的会话：清空 work_dir 后再写入消息
    getMainDb().prepare('UPDATE chat_sessions SET work_dir = NULL WHERE session_id = ?').run(s.session_id);
    addMessage(s.session_id, 'user', 'hi', undefined, 0);

    const filled = ensureSessionWorkDir(s.session_id);
    expect(filled).toBeTruthy();
    expect(filled).toContain('workspaces');
    expect(getSession(s.session_id)?.work_dir).toBe(filled);
  });

  it('属主隔离：别人的会话改不了目录', () => {
    const s = createSession('本地会话');
    setActiveOwner('other-user');
    const r = updateSessionWorkDir(s.session_id, ALT_DIR);
    expect(r.ok).toBe(false);
    setActiveOwner(LOCAL_OWNER);
  });
});
