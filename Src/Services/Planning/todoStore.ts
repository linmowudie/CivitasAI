/**
 * @module Services/Planning/todoStore
 * @description Agent 计划清单（TODO）存储 —— **按来源 agent 归属**。
 *
 * 设计要点（多 agent / 部分平级）：
 *  - 每个 agent 在会话内各有一张独立计划表：键为 `(owner, sessionId, agentId)`，
 *    平级 agent 之间**互不覆盖**；面板可按 agent 分组展示与切换。
 *  - 写入语义为**全量替换**（工具一次提交完整清单，与主流 agent 计划工具一致），
 *    位置相同且内容未变的条目会复用原 `todoId`/`createdAt`，避免 UI 抖动。
 *  - 每次写入都会发 `agent:todo_updated` 事件（含 agentId/agentRole），
 *    前端据此实时刷新并按 agent 归因；事件同时进入 `ai_events`，重启后可回放。
 */

import { v4 as uuidv4 } from 'uuid';
import { getMainDb } from '../../Infra/Db/index.js';
import { getActiveOwner } from '../AccountScope/activeAccount.js';
import { publish, createEvent } from '../EventBus/eventBus.js';
import { EventType } from '../EventBus/eventTypes.js';
import { ok, err, type Result } from '../../Infra/types.js';
import { logger } from '../../Infra/Logging/logger.js';

/** 单次提交的条目上限（防止模型刷爆存储/UI） */
export const MAX_TODOS_PER_AGENT = 50;

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  todoId: string;
  content: string;
  status: TodoStatus;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface TodoProgress {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

/** 一个 agent 在某个会话中的完整计划 */
export interface TodoAgentGroup {
  sessionId: string;
  agentId: string;
  /** agent 角色（用于面板展示，如 prime_director / worker） */
  agentRole?: string;
  todos: TodoItem[];
  progress: TodoProgress;
  updatedAt: number;
}

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

interface TodoRow {
  todo_id: string;
  session_id: string;
  agent_id: string;
  agent_role: string | null;
  content: string;
  status: string;
  position: number;
  created_at: number;
  updated_at: number;
}

function rowToItem(r: TodoRow): TodoItem {
  const status = (STATUSES as readonly string[]).includes(r.status) ? (r.status as TodoStatus) : 'pending';
  return {
    todoId: r.todo_id,
    content: r.content,
    status,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 统计进度（面板顶部进度条用） */
export function progressOf(items: Array<Pick<TodoItem, 'status'>>): TodoProgress {
  const p: TodoProgress = { total: items.length, pending: 0, inProgress: 0, completed: 0 };
  for (const it of items) {
    if (it.status === 'completed') p.completed++;
    else if (it.status === 'in_progress') p.inProgress++;
    else p.pending++;
  }
  return p;
}

/** 读取某会话下某个 agent 的计划 */
export function listTodosForAgent(sessionId: string, agentId: string): TodoItem[] {
  const rows = getMainDb().prepare(
    `SELECT * FROM session_todos
     WHERE owner_user_id = ? AND session_id = ? AND agent_id = ?
     ORDER BY position ASC`,
  ).all(getActiveOwner(), sessionId, agentId) as TodoRow[];
  return rows.map(rowToItem);
}

/**
 * 读取某会话下**全部 agent** 的计划（按 agent 分组）。
 * 面板据此展示"哪个 agent 在做什么"，平级 agent 各自一组。
 */
export function listTodosBySession(sessionId: string): TodoAgentGroup[] {
  const rows = getMainDb().prepare(
    `SELECT * FROM session_todos
     WHERE owner_user_id = ? AND session_id = ?
     ORDER BY agent_id ASC, position ASC`,
  ).all(getActiveOwner(), sessionId) as TodoRow[];

  const groups = new Map<string, TodoAgentGroup>();
  for (const r of rows) {
    let g = groups.get(r.agent_id);
    if (!g) {
      g = {
        sessionId,
        agentId: r.agent_id,
        ...(r.agent_role ? { agentRole: r.agent_role } : {}),
        todos: [],
        progress: { total: 0, pending: 0, inProgress: 0, completed: 0 },
        updatedAt: 0,
      };
      groups.set(r.agent_id, g);
    }
    g.todos.push(rowToItem(r));
    if (r.updated_at > g.updatedAt) g.updatedAt = r.updated_at;
    // 角色后到也补齐（同一 agent 的行应一致，容错取最新非空）
    if (!g.agentRole && r.agent_role) g.agentRole = r.agent_role;
  }
  for (const g of groups.values()) g.progress = progressOf(g.todos);
  return [...groups.values()];
}

/** 导出/备份用：全部计划（跨会话、跨 agent），键集分页避免静默截断 */
export function listAllTodos(): Array<TodoItem & { sessionId: string; agentId: string; agentRole?: string }> {
  const rows = getMainDb().prepare(
    `SELECT * FROM session_todos WHERE owner_user_id = ? ORDER BY session_id ASC, agent_id ASC, position ASC`,
  ).all(getActiveOwner()) as TodoRow[];
  return rows.map((r) => ({
    ...rowToItem(r),
    sessionId: r.session_id,
    agentId: r.agent_id,
    ...(r.agent_role ? { agentRole: r.agent_role } : {}),
  }));
}

/**
 * 全量替换某 agent 的计划（工具调用入口）。
 *
 * - 位置相同且内容未变的条目复用原 id/createdAt（避免前端列表抖动）；
 * - 条目数上限 `MAX_TODOS_PER_AGENT`；
 * - 写入成功后发布 `agent:todo_updated`（前端实时刷新 + 事件回放）。
 */
export function replaceTodos(input: {
  sessionId: string;
  agentId: string;
  agentRole?: string;
  todos: Array<{ content: string; status?: TodoStatus }>;
}): Result<TodoAgentGroup> {
  const sessionId = input.sessionId?.trim();
  const agentId = input.agentId?.trim();
  if (!sessionId) return err('缺少 sessionId，无法写入计划');
  if (!agentId) return err('缺少 agentId，无法写入计划');
  if (input.todos.length > MAX_TODOS_PER_AGENT) {
    return err(`计划条目过多（${input.todos.length} > ${MAX_TODOS_PER_AGENT}）`);
  }

  const owner = getActiveOwner();
  const now = Date.now();
  const db = getMainDb();

  try {
    const previous = listTodosForAgent(sessionId, agentId);
    const byContent = new Map<string, TodoItem[]>();
    for (const it of previous) {
      const list = byContent.get(it.content) ?? [];
      list.push(it);
      byContent.set(it.content, list);
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM session_todos WHERE owner_user_id = ? AND session_id = ? AND agent_id = ?')
        .run(owner, sessionId, agentId);

      const insert = db.prepare(
        `INSERT INTO session_todos
           (todo_id, session_id, agent_id, agent_role, owner_user_id, content, status, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      input.todos.forEach((t, index) => {
        const content = String(t.content ?? '').trim();
        if (content === '') return; // 空条目跳过（模型偶发）
        const status: TodoStatus = t.status && (STATUSES as readonly string[]).includes(t.status) ? t.status : 'pending';
        const reused = byContent.get(content)?.shift();
        insert.run(
          reused?.todoId ?? `todo-${uuidv4().slice(0, 8)}`,
          sessionId,
          agentId,
          input.agentRole ?? null,
          owner,
          content,
          status,
          index,
          reused?.createdAt ?? now,
          now,
        );
      });
    });
    tx();

    const todos = listTodosForAgent(sessionId, agentId);
    const group: TodoAgentGroup = {
      sessionId,
      agentId,
      ...(input.agentRole ? { agentRole: input.agentRole } : {}),
      todos,
      progress: progressOf(todos),
      updatedAt: now,
    };

    // 事件：前端据此实时更新（含 agentId/agentRole，便于按来源 agent 归因）
    publish(createEvent({
      eventType: EventType.AGENT_TODO_UPDATED,
      source: 'todoStore/replaceTodos',
      payload: {
        sessionId,
        agentId,
        agentRole: input.agentRole ?? null,
        todos,
        progress: group.progress,
      },
    }));

    return ok(group);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('写入计划清单失败', { sessionId, agentId, error: message });
    return err(`写入计划清单失败: ${message}`);
  }
}

/** 清空计划（可按 agent 限定；不传 agentId 则清空该会话全部 agent 的计划） */
export function clearTodos(sessionId: string, agentId?: string): Result<number> {
  try {
    const db = getMainDb();
    const owner = getActiveOwner();
    const info = agentId
      ? db.prepare('DELETE FROM session_todos WHERE owner_user_id = ? AND session_id = ? AND agent_id = ?')
          .run(owner, sessionId, agentId)
      : db.prepare('DELETE FROM session_todos WHERE owner_user_id = ? AND session_id = ?')
          .run(owner, sessionId);

    publish(createEvent({
      eventType: EventType.AGENT_TODO_UPDATED,
      source: 'todoStore/clearTodos',
      payload: {
        sessionId,
        agentId: agentId ?? null,
        agentRole: null,
        todos: [],
        progress: { total: 0, pending: 0, inProgress: 0, completed: 0 },
        cleared: true,
      },
    }));
    return ok(Number(info.changes ?? 0));
  } catch (e) {
    return err(`清空计划失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}
