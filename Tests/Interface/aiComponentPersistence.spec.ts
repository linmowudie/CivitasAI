/**
 * AI 组件族内容的持久化（重启后重建组件）
 *
 * 覆盖：
 *  - 消息富结构（reasoning/toolCalls/segments/totalIterations/error/status）往返落库；
 *  - 按 (会话, 角色, 正文) 回填而非重复插入（前端不知道后端生成的 message_id）；
 *  - 富结构更新受属主限制（B 不能改 A 的消息）；
 *  - AI 事件流：只落组件相关事件（逐 token 增量不落库）、按属主+会话隔离、可清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, migrateUp, clearMigrations } from '../../Src/Infra/Db/migrations.js';
import { createSession, addMessage, listMessages, updateMessageRich, upsertRichMessage } from '../../Src/Interface/RestApi/chatApi.js';
import {
  persistAiEvent, listAiEvents, countAiEvents, clearSessionEvents, shouldPersist,
} from '../../Src/Interface/EventStore/aiEventStore.js';
import { setActiveOwner, LOCAL_OWNER } from '../../Src/Services/AccountScope/activeAccount.js';
import { createEvent } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

const TEST_DB_DIR = join(resolve(import.meta.dirname, '..', '..'), 'Data', '_test_ai_persist');

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

describe('AI 组件内容的持久化', () => {
  beforeEach(() => {
    initTestDb();
    setActiveOwner(null);
  });

  afterEach(() => {
    closeDatabase();
    setActiveOwner(null);
    if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  it('消息富结构可往返落库（思考/工具卡/分段/迭代/失败原因）', () => {
    const session = createSession('组件持久化');
    const toolCalls = [{ id: 't1', name: 'dir.list', arguments: { path: '.' }, status: 'success', content: 'a.txt' }];
    const segments = [
      { kind: 'reasoning', text: '先看看目录' },
      { kind: 'tools', iteration: 1, toolCalls },
      { kind: 'text', text: '共 1 个文件' },
    ];
    addMessage(session.session_id, 'assistant', '共 1 个文件', {
      model: 'test-model',
      rich: { reasoning: '先看看目录', toolCalls, segments, totalIterations: 1, status: 'complete' },
    });

    const rows = listMessages(session.session_id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.reasoning).toBe('先看看目录');
    expect(JSON.parse(row.tool_calls_json!)).toEqual(toolCalls);
    expect(JSON.parse(row.segments_json!)).toEqual(segments);
    expect(row.total_iterations).toBe(1);
    expect(row.status).toBe('complete');
  });

  it('按 (会话, 角色, 正文) 回填富结构：不产生重复消息', () => {
    const session = createSession('回填');
    // 后端流式结束时先落库了纯文本
    addMessage(session.session_id, 'assistant', '任务完成');
    expect(listMessages(session.session_id)).toHaveLength(1);

    // 前端随后回填组件数据（同一个正文）
    const res = upsertRichMessage(session.session_id, 'assistant', '任务完成', {
      reasoning: '思考中',
      toolCalls: [{ id: 't9', name: 'file.read', arguments: {}, status: 'success' }],
      segments: [{ kind: 'reasoning', text: '思考中' }],
      totalIterations: 2,
      status: 'complete',
    });

    expect(res.ok).toBe(true);
    const rows = listMessages(session.session_id);
    expect(rows).toHaveLength(1); // 未重复插入
    expect(rows[0]!.reasoning).toBe('思考中');
    expect(rows[0]!.total_iterations).toBe(2);
  });

  it('富结构更新受属主限制：B 无法修改 A 的消息', () => {
    setActiveOwner(USER_A);
    const session = createSession('A 的会话');
    const msg = addMessage(session.session_id, 'assistant', 'A 的回复');
    expect(updateMessageRich(msg.message_id, { reasoning: 'A 的思考' }).ok).toBe(true);

    setActiveOwner(USER_B);
    const denied = updateMessageRich(msg.message_id, { reasoning: 'B 篡改' });
    expect(denied.ok).toBe(false);
    // 且 B 看不到该消息
    expect(listMessages(session.session_id)).toHaveLength(0);
  });

  it('事件过滤：组件相关事件落库，逐 token 增量不落库', () => {
    expect(shouldPersist('agent:iteration_complete')).toBe(true);
    expect(shouldPersist('agent:tool_call_result')).toBe(true);
    expect(shouldPersist('approval:requested')).toBe(true);
    expect(shouldPersist('agent:stream_chunk')).toBe(false); // 高频增量
    expect(shouldPersist('unrelated:event')).toBe(false);
  });

  it('事件按属主+会话隔离，且可清理', () => {
    setActiveOwner(USER_A);
    const session = createSession('事件会话');
    persistAiEvent(createEvent({
      eventType: EventType.AGENT_TOOL_CALL_RESULT,
      source: 'test',
      payload: { sessionId: session.session_id, toolName: 'dir.list' },
    }), USER_A);
    persistAiEvent(createEvent({
      eventType: EventType.AGENT_STREAM_CHUNK, // 应被跳过
      source: 'test',
      payload: { sessionId: session.session_id, delta: 'x' },
    }), USER_A);

    const eventsA = listAiEvents(session.session_id);
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]!.type).toBe('agent:tool_call_result');
    expect(JSON.parse(eventsA[0]!.data_json).toolName).toBe('dir.list');
    expect(countAiEvents(session.session_id)).toBe(1);

    // B 看不到 A 的事件
    setActiveOwner(USER_B);
    expect(listAiEvents(session.session_id)).toHaveLength(0);

    // 清理后 A 也读不到
    setActiveOwner(USER_A);
    clearSessionEvents(session.session_id);
    expect(listAiEvents(session.session_id)).toHaveLength(0);
  });

  it('默认属主为 local（未登录时组件数据也持久化）', () => {
    expect(LOCAL_OWNER).toBe('local');
    const session = createSession('匿名会话');
    addMessage(session.session_id, 'assistant', '匿名回复', {
      rich: { reasoning: '匿名思考', status: 'complete' },
    });
    expect(listMessages(session.session_id)[0]!.reasoning).toBe('匿名思考');
  });
});
