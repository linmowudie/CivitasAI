/**
 * Agent 计划清单（TODO）测试 —— 重点：**多 agent 归属隔离**。
 *
 * 覆盖：
 *  - 全量替换语义；相同位置同内容的条目复用 todoId（避免 UI 抖动）；
 *  - 状态与进度统计（pending / in_progress / completed）；
 *  - **平级 agent 互不覆盖**：两个 agent 各自的计划表独立，按 agent 分组返回；
 *  - 会话隔离：不同会话的计划互不串；
 *  - 属主隔离：切换账号后看不到、也写不进别人的计划；
 *  - 空内容/超限条目处理；清空（按 agent / 整会话）；
 *  - 事件：写入后发布 `agent:todo_updated`，payload 带 agentId（前端按来源归因）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { createSession } from '../../Src/Interface/RestApi/chatApi.js';
import {
  replaceTodos,
  listTodosForAgent,
  listTodosBySession,
  listAllTodos,
  clearTodos,
  progressOf,
  MAX_TODOS_PER_AGENT,
} from '../../Src/Services/Planning/todoStore.js';
import { setActiveOwner, LOCAL_OWNER } from '../../Src/Services/AccountScope/activeAccount.js';
import { subscribe } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

const TEST_DB_DIR = resolve(import.meta.dirname, '../../.tmp/test-db-todo');

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

describe('Agent 计划清单（TODO）', () => {
  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    closeDatabase();
    clearMigrations();
    if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  it('全量替换：第二次提交覆盖第一次，且同内容条目复用 todoId', () => {
    const session = createSession('计划测试');
    const first = replaceTodos({
      sessionId: session.session_id,
      agentId: 'agent-a',
      agentRole: 'prime_director',
      todos: [{ content: '读取需求' }, { content: '编写代码' }, { content: '运行测试' }],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.todos).toHaveLength(3);
    expect(first.value.progress).toEqual({ total: 3, pending: 3, inProgress: 0, completed: 0 });
    const idOfRead = first.value.todos[0]!.todoId;

    // 第二次：第一项完成、第二项进行中（内容未变 → 复用 id）
    const second = replaceTodos({
      sessionId: session.session_id,
      agentId: 'agent-a',
      agentRole: 'prime_director',
      todos: [
        { content: '读取需求', status: 'completed' },
        { content: '编写代码', status: 'in_progress' },
        { content: '运行测试' },
      ],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.todos).toHaveLength(3);
    expect(second.value.todos[0]!.todoId).toBe(idOfRead);
    expect(second.value.progress).toEqual({ total: 3, pending: 1, inProgress: 1, completed: 1 });

    // 第三次：缩减为 2 项 → 全量替换生效
    const third = replaceTodos({
      sessionId: session.session_id,
      agentId: 'agent-a',
      todos: [{ content: '编写代码', status: 'completed' }, { content: '运行测试', status: 'completed' }],
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.value.todos.map((t) => t.content)).toEqual(['编写代码', '运行测试']);
    expect(third.value.progress.completed).toBe(2);
  });

  it('★ 多 agent 平级隔离：各 agent 的计划独立，按 agent 分组返回', () => {
    const session = createSession('多 agent 计划');
    const sid = session.session_id;

    replaceTodos({ sessionId: sid, agentId: 'agent-prime', agentRole: 'prime_director',
      todos: [{ content: '统筹全局', status: 'in_progress' }] });
    replaceTodos({ sessionId: sid, agentId: 'agent-worker-1', agentRole: 'worker',
      todos: [{ content: '写模块 A', status: 'completed' }, { content: '写模块 B' }] });
    replaceTodos({ sessionId: sid, agentId: 'agent-worker-2', agentRole: 'worker',
      todos: [{ content: '写模块 C' }] });

    // 各 agent 各看各的
    expect(listTodosForAgent(sid, 'agent-prime')).toHaveLength(1);
    expect(listTodosForAgent(sid, 'agent-worker-1').map((t) => t.content)).toEqual(['写模块 A', '写模块 B']);
    expect(listTodosForAgent(sid, 'agent-worker-2').map((t) => t.content)).toEqual(['写模块 C']);

    // 分组视图：三个 agent 各一组，带角色与进度
    const groups = listTodosBySession(sid);
    expect(groups).toHaveLength(3);
    const w1 = groups.find((g) => g.agentId === 'agent-worker-1');
    expect(w1?.agentRole).toBe('worker');
    expect(w1?.progress).toEqual({ total: 2, pending: 1, inProgress: 0, completed: 1 });
    const prime = groups.find((g) => g.agentId === 'agent-prime');
    expect(prime?.agentRole).toBe('prime_director');
    expect(prime?.progress.inProgress).toBe(1);

    // ★ 关键：worker-1 重写自己的计划，不能影响 worker-2 与 prime
    replaceTodos({ sessionId: sid, agentId: 'agent-worker-1', agentRole: 'worker',
      todos: [{ content: '写模块 A', status: 'completed' }] });
    expect(listTodosForAgent(sid, 'agent-worker-2')).toHaveLength(1);
    expect(listTodosForAgent(sid, 'agent-prime')).toHaveLength(1);
    expect(listTodosForAgent(sid, 'agent-worker-1')).toHaveLength(1);
  });

  it('会话隔离：不同会话的计划互不串', () => {
    const s1 = createSession('会话 1');
    const s2 = createSession('会话 2');
    replaceTodos({ sessionId: s1.session_id, agentId: 'agent-a', todos: [{ content: '属于会话1' }] });
    replaceTodos({ sessionId: s2.session_id, agentId: 'agent-a', todos: [{ content: '属于会话2' }] });
    expect(listTodosForAgent(s1.session_id, 'agent-a').map((t) => t.content)).toEqual(['属于会话1']);
    expect(listTodosForAgent(s2.session_id, 'agent-a').map((t) => t.content)).toEqual(['属于会话2']);
  });

  it('★ 属主隔离：切号后既看不到也写不进他人计划', () => {
    const session = createSession('属主测试');
    replaceTodos({ sessionId: session.session_id, agentId: 'agent-a', todos: [{ content: '我的计划' }] });
    expect(listTodosBySession(session.session_id)).toHaveLength(1);

    setActiveOwner('user-other');
    expect(listTodosBySession(session.session_id)).toHaveLength(0);
    replaceTodos({ sessionId: session.session_id, agentId: 'agent-a', todos: [{ content: '他人的计划' }] });
    expect(listTodosForAgent(session.session_id, 'agent-a').map((t) => t.content)).toEqual(['他人的计划']);

    setActiveOwner(LOCAL_OWNER);
    expect(listTodosForAgent(session.session_id, 'agent-a').map((t) => t.content)).toEqual(['我的计划']);
  });

  it('参数校验：缺 sessionId / agentId 返回失败；空内容被跳过；超限被拒', () => {
    const session = createSession('校验');
    expect(replaceTodos({ sessionId: '', agentId: 'a', todos: [] }).ok).toBe(false);
    expect(replaceTodos({ sessionId: session.session_id, agentId: '', todos: [] }).ok).toBe(false);

    const withEmpty = replaceTodos({
      sessionId: session.session_id, agentId: 'agent-a',
      todos: [{ content: '有效条目' }, { content: '   ' }],
    });
    expect(withEmpty.ok).toBe(true);
    if (withEmpty.ok) expect(withEmpty.value.todos).toHaveLength(1);

    const tooMany = replaceTodos({
      sessionId: session.session_id, agentId: 'agent-a',
      todos: Array.from({ length: MAX_TODOS_PER_AGENT + 1 }, (_, i) => ({ content: `条目 ${i}` })),
    });
    expect(tooMany.ok).toBe(false);
  });

  it('清空：按 agent 清空只影响该 agent；整会话清空移除全部', () => {
    const session = createSession('清空');
    const sid = session.session_id;
    replaceTodos({ sessionId: sid, agentId: 'agent-a', todos: [{ content: 'A-1' }] });
    replaceTodos({ sessionId: sid, agentId: 'agent-b', todos: [{ content: 'B-1' }] });

    const cleared = clearTodos(sid, 'agent-a');
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value).toBe(1);
    expect(listTodosForAgent(sid, 'agent-a')).toHaveLength(0);
    expect(listTodosForAgent(sid, 'agent-b')).toHaveLength(1);

    clearTodos(sid);
    expect(listTodosBySession(sid)).toHaveLength(0);
  });

  it('★ 事件：写入发布 agent:todo_updated，payload 带 agentId 与进度（前端按来源归因）', () => {
    const session = createSession('事件');
    const received: Array<Record<string, unknown>> = [];
    let sub: { unsubscribe?: () => void; off?: () => void } | null = null;
    const handler = (event: { eventType?: string; payload?: Record<string, unknown> }) => {
      if (event.eventType === EventType.AGENT_TODO_UPDATED) received.push(event.payload ?? {});
    };
    sub = subscribe(EventType.AGENT_TODO_UPDATED, handler as never) as unknown as { unsubscribe?: () => void; off?: () => void };

    try {
      replaceTodos({
        sessionId: session.session_id,
        agentId: 'agent-x',
        agentRole: 'worker',
        todos: [{ content: '任务一', status: 'completed' }, { content: '任务二', status: 'in_progress' }],
      });
    } finally {
      sub?.unsubscribe?.();
      sub?.off?.();
    }

    expect(received).toHaveLength(1);
    expect(received[0]!['agentId']).toBe('agent-x');
    expect(received[0]!['sessionId']).toBe(session.session_id);
    expect(received[0]!['agentRole']).toBe('worker');
    expect(received[0]!['progress']).toEqual({ total: 2, pending: 0, inProgress: 1, completed: 1 });
  });

  it('全量导出（备份用）：跨会话跨 agent 均可取到', () => {
    const s1 = createSession('导出 1');
    const s2 = createSession('导出 2');
    replaceTodos({ sessionId: s1.session_id, agentId: 'agent-a', todos: [{ content: 'x' }] });
    replaceTodos({ sessionId: s2.session_id, agentId: 'agent-b', todos: [{ content: 'y' }, { content: 'z' }] });
    const all = listAllTodos();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((t) => t.sessionId)).size).toBe(2);
    expect(new Set(all.map((t) => t.agentId))).toEqual(new Set(['agent-a', 'agent-b']));
  });

  it('进度统计辅助函数', () => {
    expect(progressOf([])).toEqual({ total: 0, pending: 0, inProgress: 0, completed: 0 });
    expect(progressOf([{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }, { status: 'pending' }]))
      .toEqual({ total: 4, pending: 2, inProgress: 1, completed: 1 });
  });
});
