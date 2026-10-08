/**
 * @module Interface/RestApi/chatApi
 * @description
 * 会话与消息 API——Docs/Client/02 F0.7。
 * GET/POST /api/sessions、GET/POST /api/sessions/:id/messages。
 * 消息落 DB（main 库 chat_sessions / chat_messages 表，migration v18/v19）。
 */

import { v4 as uuidv4 } from 'uuid';

import { getMainDb } from '../../Infra/Db/index.js';
import { publish, createEvent } from '../../Services/EventBus/eventBus.js';
import { EventType } from '../../Services/EventBus/eventTypes.js';
import { getRegisteredModels } from '../../Infra/Llm/Router/modelRouter.js';
import { defaultWorkspaceDir, ensureWorkspaceDir } from '../../Infra/Security/workspaceGuard.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import { json, apiError, registerRoute } from './router.js';
import { getActiveOwner } from '../../Services/AccountScope/activeAccount.js';
import { listAiEvents, type PersistedAiEvent } from '../EventStore/aiEventStore.js';
import { listTodosBySession, listAllTodos, clearTodos } from '../../Services/Planning/todoStore.js';

/** 事件 payload 反序列化（损坏数据回退为空对象，避免整个回放失败） */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

// ── 类型 ────────────────────────────────────────────────────────────

export interface ChatSessionRow {
  session_id: string;
  title: string;
  status: 'active' | 'archived' | 'closed';
  created_at: number;
  updated_at: number;
  /** 任务工作目录（工具与 shell 的路径根） */
  work_dir?: string | null;
  /** 归档时间（epoch ms）；null/undefined = 未归档（2026-10-03 新增） */
  archived_at?: number | null;
}

export interface ChatMessageRow {
  message_id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  tokens_used?: number;
  trace_id?: string;
  created_at: number;
  /** ── AI 组件族重建所需的富结构（迁移 v23）── */
  /** 思维链原文（CoTFolder 渲染） */
  reasoning?: string | null;
  /** 工具调用列表 JSON（ToolGroup 渲染） */
  tool_calls_json?: string | null;
  /** 分段内容 JSON（MessageShell 按序渲染 reasoning/text/tools） */
  segments_json?: string | null;
  /** 总迭代轮次 */
  total_iterations?: number | null;
  /** 失败原因（UI 诊断展示） */
  error?: string | null;
  /** 消息状态：complete/stopped/error */
  status?: string | null;
}

/** 富结构写入参数（AI 组件族重建用） */
export interface MessageRichPayload {
  reasoning?: string | null;
  toolCalls?: unknown;
  segments?: unknown;
  totalIterations?: number | null;
  error?: string | null;
  status?: string | null;
  model?: string;
  tokensUsed?: number;
  traceId?: string;
}

// ── 会话操作 ────────────────────────────────────────────────────────

/**
 * 列出会话（任务）。
 *
 * @param options.archived `false`（默认）= 仅未归档；`true` = 仅已归档；`'all'` = 全部
 *
 * 归档（2026-10-03 新增）：`archived_at` 非空表示已归档。
 * 归档是**软状态**：不删除任何消息，任务仍可打开、可取消归档，也会继续参与同步/备份。
 */
export function listSessions(options: { archived?: boolean | 'all' } = {}): ChatSessionRow[] {
  const db = getMainDb();
  const archived = options.archived ?? false;
  if (archived === 'all') {
    return db.prepare('SELECT * FROM chat_sessions WHERE owner_user_id = ? ORDER BY updated_at DESC')
      .all(getActiveOwner()) as ChatSessionRow[];
  }
  return db.prepare(
    `SELECT * FROM chat_sessions
     WHERE owner_user_id = ? AND (archived_at IS NOT NULL) = ?
     ORDER BY updated_at DESC`,
    // 注意：better-sqlite3 不接受布尔值绑定，必须显式转 0/1
  ).all(getActiveOwner(), archived ? 1 : 0) as ChatSessionRow[];
}

/**
 * 归档 / 取消归档一个任务（软状态，不删除数据）。
 *
 * 属主限定：只能操作当前账号名下的任务（他人任务视为不存在）。
 */
export function archiveSession(sessionId: string, archived: boolean): Result<ChatSessionRow> {
  const db = getMainDb();
  const owner = getActiveOwner();
  const session = getSession(sessionId);
  if (!session) return err(`会话不存在: ${sessionId}`, 'ERROR');

  const now = Date.now();
  db.prepare(
    `UPDATE chat_sessions SET archived_at = ?, updated_at = ? WHERE session_id = ? AND owner_user_id = ?`,
  ).run(archived ? now : null, now, sessionId, owner);

  const updated = db.prepare('SELECT * FROM chat_sessions WHERE session_id = ? AND owner_user_id = ?')
    .get(sessionId, owner) as ChatSessionRow | undefined;
  return updated ? ok(updated) : err(`归档后读取失败: ${sessionId}`, 'ERROR');
}

/**
 * 创建会话。
 *
 * 工作目录规则（2026-10-01 决策；2026-10-06 目录契约校准）：
 * - 未指定 `workDir` → 使用 `<工作空间根>/workspaces/<sessionId>/`，并**立即创建空目录**；
 *   工作空间根由 `pathResolver.getWorkspaceRoot()` 决定：开发态 = `<仓库>/Data`，
 *   便携/安装态 = 程序目录（安装目录只读时自动回落数据根）。
 * - 指定 `workDir` → 目录不存在则创建；
 * - 无工作目录的任务因此始终有一个空文件夹作为工作根，工具不会越出。
 */
export function createSession(title?: string, workDir?: string): ChatSessionRow {
  const db = getMainDb();
  const sessionId = `sess-${uuidv4().slice(0, 8)}`;
  const now = Date.now();

  const workspace = ensureWorkspaceDir(workDir && workDir.trim() !== '' ? workDir : defaultWorkspaceDir(sessionId));
  const workDirValue = workspace.ok ? workspace.value : defaultWorkspaceDir(sessionId);

  db.prepare(
    `INSERT INTO chat_sessions (session_id, title, status, created_at, updated_at, work_dir, owner_user_id)
     VALUES (?, ?, 'active', ?, ?, ?, ?)`,
  ).run(sessionId, title ?? 'New Chat', now, now, workDirValue, getActiveOwner());

  return {
    session_id: sessionId,
    title: title ?? 'New Chat',
    status: 'active',
    created_at: now,
    updated_at: now,
    work_dir: workDirValue,
  };
}

/** 更新会话工作目录（不存在则创建；空值表示重置为默认目录） */
export function updateSessionWorkDir(sessionId: string, workDir: string | null): Result<ChatSessionRow> {
  const session = getSession(sessionId);
  if (!session) return err(`会话不存在: ${sessionId}`, 'ERROR');

  const target = workDir && workDir.trim() !== '' ? workDir : defaultWorkspaceDir(sessionId);
  const workspace = ensureWorkspaceDir(target);
  if (!workspace.ok) return err(workspace.error, 'ERROR');

  getMainDb()
    .prepare('UPDATE chat_sessions SET work_dir = ?, updated_at = ? WHERE session_id = ? AND owner_user_id = ?')
    .run(workspace.value, Date.now(), sessionId, getActiveOwner());

  return ok({ ...session, work_dir: workspace.value, updated_at: Date.now() });
}

/** 读取会话工作目录（缺省时补齐默认目录并落库，兼容迁移前创建的会话） */
export function ensureSessionWorkDir(sessionId: string): string | null {
  const session = getSession(sessionId);
  if (!session) return null;
  if (session.work_dir && session.work_dir.trim() !== '') return session.work_dir;
  const updated = updateSessionWorkDir(sessionId, null);
  return updated.ok ? (updated.value.work_dir ?? null) : null;
}

export function getSession(sessionId: string): ChatSessionRow | undefined {
  const db = getMainDb();
  return db.prepare('SELECT * FROM chat_sessions WHERE session_id = ? AND owner_user_id = ?')
    .get(sessionId, getActiveOwner()) as ChatSessionRow | undefined;
}

/** 更新会话标题（用于自动命名） */
export function updateSessionTitle(sessionId: string, title: string): void {
  const db = getMainDb();
  db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE session_id = ? AND owner_user_id = ?')
    .run(title, Date.now(), sessionId, getActiveOwner());
}

// ── 消息操作 ────────────────────────────────────────────────────────

export function listMessages(sessionId: string, limit = 50): ChatMessageRow[] {
  const db = getMainDb();
  // 取"最近 limit 条"再按时间升序返回。
  // 原实现为 ORDER BY created_at ASC LIMIT ?，会话超过 limit 条时会截断掉**最新**消息，
  // 导致上下文装配拿不到当前提问（模型只能看到很久以前的对话）。
  // rowid 作为同毫秒内的次序 tiebreaker。
  const rows = db.prepare(
    'SELECT * FROM chat_messages WHERE session_id = ? AND owner_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
  ).all(sessionId, getActiveOwner(), limit) as ChatMessageRow[];
  return rows.reverse();
}

export function addMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  extra?: {
    model?: string; tokens_used?: number; trace_id?: string;
    rich?: MessageRichPayload;
  },
): ChatMessageRow {
  const db = getMainDb();
  const messageId = `msg-${uuidv4().slice(0, 8)}`;
  const now = Date.now();
  // 属主取**会话自身的属主**（而非当前全局属主）：
  // 运行中的任务若在切换账号之后才落库，也不会把消息写进另一个账号的命名空间。
  const sessionRow = db.prepare('SELECT owner_user_id FROM chat_sessions WHERE session_id = ?')
    .get(sessionId) as { owner_user_id?: string } | undefined;
  const owner = sessionRow?.owner_user_id ?? getActiveOwner();
  const rich = extra?.rich;
  db.prepare(
    `INSERT INTO chat_messages
       (message_id, session_id, role, content, model, tokens_used, trace_id, created_at, owner_user_id,
        reasoning, tool_calls_json, segments_json, total_iterations, error, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId, sessionId, role, content, extra?.model ?? null, extra?.tokens_used ?? null, extra?.trace_id ?? null, now, owner,
    rich?.reasoning ?? null,
    rich?.toolCalls !== undefined ? JSON.stringify(rich.toolCalls) : null,
    rich?.segments !== undefined ? JSON.stringify(rich.segments) : null,
    rich?.totalIterations ?? null,
    rich?.error ?? null,
    rich?.status ?? 'complete',
  );

  // 更新会话时间戳（同样限定属主）
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE session_id = ? AND owner_user_id = ?')
    .run(now, sessionId, owner);

  // 发布事件（前端可订阅 agent:chat_message 增量推送）
  publish(createEvent({
    eventType: EventType.AGENT_CHAT_MESSAGE,
    source: 'chatApi/addMessage',
    payload: { messageId, sessionId, role, content },
  }));

  return {
    message_id: messageId, session_id: sessionId, role, content,
    model: extra?.model, tokens_used: extra?.tokens_used, trace_id: extra?.trace_id, created_at: now,
    reasoning: rich?.reasoning ?? null,
    tool_calls_json: rich?.toolCalls !== undefined ? JSON.stringify(rich.toolCalls) : null,
    segments_json: rich?.segments !== undefined ? JSON.stringify(rich.segments) : null,
    total_iterations: rich?.totalIterations ?? null,
    error: rich?.error ?? null,
    status: rich?.status ?? 'complete',
  };
}

/**
 * 更新一条消息的富结构（AI 组件族重建所需）。
 *
 * 为什么需要单独更新：文本在流式结束时由后端落库（FE-025 的 finally 兜底），
 * 而**思考/工具卡片/分段**只存在于前端运行态（由事件累积），
 * 所以由前端在运行结束后回填——否则重启后只剩纯文本。
 */
export function updateMessageRich(messageId: string, rich: MessageRichPayload): Result<ChatMessageRow> {
  const db = getMainDb();
  const owner = getActiveOwner();
  const existing = db.prepare('SELECT * FROM chat_messages WHERE message_id = ? AND owner_user_id = ?')
    .get(messageId, owner) as ChatMessageRow | undefined;
  if (!existing) return err(`消息不存在: ${messageId}`, 'ERROR');

  db.prepare(
    `UPDATE chat_messages SET
       reasoning = COALESCE(?, reasoning),
       tool_calls_json = COALESCE(?, tool_calls_json),
       segments_json = COALESCE(?, segments_json),
       total_iterations = COALESCE(?, total_iterations),
       error = COALESCE(?, error),
       status = COALESCE(?, status),
       model = COALESCE(?, model),
       tokens_used = COALESCE(?, tokens_used),
       trace_id = COALESCE(?, trace_id)
     WHERE message_id = ? AND owner_user_id = ?`,
  ).run(
    rich.reasoning ?? null,
    rich.toolCalls !== undefined ? JSON.stringify(rich.toolCalls) : null,
    rich.segments !== undefined ? JSON.stringify(rich.segments) : null,
    rich.totalIterations ?? null,
    rich.error ?? null,
    rich.status ?? null,
    rich.model ?? null,
    rich.tokensUsed ?? null,
    rich.traceId ?? null,
    messageId, owner,
  );
  const updated = db.prepare('SELECT * FROM chat_messages WHERE message_id = ? AND owner_user_id = ?')
    .get(messageId, owner) as ChatMessageRow | undefined;
  return updated ? ok(updated) : err(`更新后读取失败: ${messageId}`, 'ERROR');
}

/**
 * 按 (会话, 角色, 正文) 定位并回填富结构；不存在则新建。
 *
 * 这是前端最稳的回填方式：前端只知道文本与富结构，不知道后端生成的 `message_id`
 *（后端在流式结束时自己落库，见 ipcBridge 的 finally 兜底）。
 */
export function upsertRichMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  rich: MessageRichPayload,
): Result<ChatMessageRow> {
  const db = getMainDb();
  const owner = getActiveOwner();
  const row = db.prepare(
    `SELECT * FROM chat_messages
     WHERE session_id = ? AND owner_user_id = ? AND role = ? AND content = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(sessionId, owner, role, content) as ChatMessageRow | undefined;

  if (row) return updateMessageRich(row.message_id, rich);
  return ok(addMessage(sessionId, role, content, { rich }));
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerChatRoutes(): void {
  // GET /api/sessions — 会话列表（?archived=false|true|all；默认仅未归档）
  registerRoute('GET', '/api/sessions', async (req) => {
    const raw = req.query['archived'];
    const archived: boolean | 'all' = raw === 'all' ? 'all' : raw === 'true' || raw === '1' ? true : false;
    return json(listSessions({ archived }));
  });

  // POST /api/sessions/:sessionId/archive — 归档 / 取消归档（软状态）
  registerRoute('POST', '/api/sessions/:sessionId/archive', async (req) => {
    const sessionId = req.params.sessionId;
    if (!sessionId) return apiError('sessionId is required', 400);
    const archived = req.body?.archived;
    if (typeof archived !== 'boolean') return apiError('archived 必须是布尔值', 400);
    const result = archiveSession(sessionId, archived);
    if (!result.ok) return apiError(result.error, 404);
    return json(result.value);
  });

  // POST /api/sessions — 创建会话（可选 workDir；缺省生成 Data/workspaces/<sessionId>/ 空目录）
  registerRoute('POST', '/api/sessions', async (req) => {
    const title = req.body?.title as string | undefined;
    const workDir = req.body?.workDir as string | undefined;
    const session = createSession(title, workDir);
    return json(session, 201);
  });

  // GET /api/sessions/:sessionId/messages — 消息列表
  registerRoute('GET', '/api/sessions/:sessionId/messages', async (req) => {
    const sessionId = req.params.sessionId;
    if (!sessionId) return apiError('sessionId is required', 400);
    const session = getSession(sessionId);
    if (!session) return apiError('Session not found', 404);
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    return json(listMessages(sessionId, limit));
  });

  // POST /api/sessions/:sessionId/messages — 发送消息
  registerRoute('POST', '/api/sessions/:sessionId/messages', async (req) => {
    const sessionId = req.params.sessionId;
    if (!sessionId) return apiError('sessionId is required', 400);
    const session = getSession(sessionId);
    if (!session) return apiError('Session not found', 404);

    const role = (req.body?.role as string) ?? 'user';
    const content = req.body?.content as string;
    if (!content) return apiError('content is required');
    if (!['user', 'assistant', 'system'].includes(role)) return apiError('role must be user|assistant|system');

    const msg = addMessage(sessionId, role as 'user' | 'assistant' | 'system', content, {
      model: req.body?.model as string | undefined,
      tokens_used: req.body?.tokens_used as number | undefined,
      trace_id: req.body?.trace_id as string | undefined,
    });
    return json(msg, 201);
  });

  // PATCH /api/sessions/:sessionId — 更新会话（标题 / 工作目录）
  registerRoute('PATCH', '/api/sessions/:sessionId', async (req) => {
    const sessionId = req.params.sessionId;
    if (!sessionId) return apiError('sessionId is required', 400);
    const session = getSession(sessionId);
    if (!session) return apiError('Session not found', 404);

    const title = req.body?.title as string | undefined;
    if (title !== undefined) {
      updateSessionTitle(sessionId, title);
    }

    // workDir 支持显式修改；传 null/'' 表示重置为默认工作目录
    if (req.body !== undefined && 'workDir' in (req.body as Record<string, unknown>)) {
      const raw = (req.body as Record<string, unknown>)['workDir'];
      const result = updateSessionWorkDir(sessionId, typeof raw === 'string' ? raw : null);
      if (!result.ok) return apiError(result.error, 400);
      return json(result.value);
    }

    return json(getSession(sessionId));
  });

  // GET /api/models — 获取可用模型列表
  // PATCH /api/messages/:messageId — 回填消息富结构（AI 组件族重建）
  registerRoute('PATCH', '/api/messages/:messageId', async (req) => {
    const messageId = req.params.messageId;
    if (!messageId) return apiError('messageId is required', 400);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = updateMessageRich(messageId, {
      reasoning: typeof body.reasoning === 'string' ? body.reasoning : undefined,
      toolCalls: body.toolCalls,
      segments: body.segments,
      totalIterations: typeof body.totalIterations === 'number' ? body.totalIterations : undefined,
      error: typeof body.error === 'string' ? body.error : undefined,
      status: typeof body.status === 'string' ? body.status : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      tokensUsed: typeof body.tokensUsed === 'number' ? body.tokensUsed : undefined,
      traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
    });
    if (!result.ok) return apiError(result.error, 404);
    return json(result.value);
  });

  /**
   * POST /api/sessions/:sessionId/messages/rich — 按 (角色, 正文) 回填/创建富消息
   *
   * 前端不知道后端生成的 message_id（后端在流式结束时自行落库），
   * 因此以"会话 + 角色 + 正文"定位并回填组件数据（思考/工具卡/分段）。
   */
  registerRoute('POST', '/api/sessions/:sessionId/messages/rich', async (req) => {
    const sessionId = req.params.sessionId;
    if (!sessionId) return apiError('sessionId is required', 400);
    if (!getSession(sessionId)) return apiError('Session not found', 404);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const role = (body.role as string) ?? 'assistant';
    if (!['user', 'assistant', 'system'].includes(role)) return apiError('role must be user|assistant|system');
    const content = typeof body.content === 'string' ? body.content : '';
    if (content.length === 0 && body.segments === undefined) {
      return apiError('content 或 segments 至少需要一个', 400);
    }

    const result = upsertRichMessage(sessionId, role as 'user' | 'assistant' | 'system', content, {
      reasoning: typeof body.reasoning === 'string' ? body.reasoning : undefined,
      toolCalls: body.toolCalls,
      segments: body.segments,
      totalIterations: typeof body.totalIterations === 'number' ? body.totalIterations : undefined,
      error: typeof body.error === 'string' ? body.error : undefined,
      status: typeof body.status === 'string' ? body.status : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      tokensUsed: typeof body.tokensUsed === 'number' ? body.tokensUsed : undefined,
      traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
    });
    if (!result.ok) return apiError(result.error, 500);
    return json(result.value, 201);
  });

  /**
   * GET /api/sessions/:sessionId/ai-events — 会话内 AI 组件事件流（重启后回放重建）
   */
  registerRoute('GET', '/api/sessions/:sessionId/ai-events', async (req) => {
    const sessionId = req.params.sessionId;
    if (!sessionId) return apiError('sessionId is required', 400);
    const sinceTs = req.query.since ? parseInt(req.query.since, 10) : 0;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 2000;
    const events = listAiEvents(sessionId, { sinceTs, limit });
    return json({
      events: events.map((e: PersistedAiEvent) => ({
        id: e.event_id,
        type: e.type,
        data: safeParse(e.data_json),
        timestamp: e.ts,
      })),
      total: events.length,
    });
  });

  // GET /api/sessions/:sessionId/todos — Agent 计划清单（**按来源 agent 分组**）
  //   多 agent 且部分平级：每个 agent 各有一张计划表，前端面板按 agent 展示与切换。
  registerRoute('GET', '/api/sessions/:sessionId/todos', async (req) => {
    const sessionId = req.params.sessionId;
    if (!sessionId) return apiError('sessionId is required', 400);
    const groups = listTodosBySession(sessionId);
    return json({ sessionId, groups, total: groups.reduce((n, g) => n + g.todos.length, 0) });
  });

  // DELETE /api/sessions/:sessionId/todos[?agentId=xxx] — 清空计划
  //   不带 agentId 清空该会话全部 agent；带 agentId 只清空指定 agent。
  registerRoute('DELETE', '/api/sessions/:sessionId/todos', async (req) => {
    const sessionId = req.params.sessionId;
    if (!sessionId) return apiError('sessionId is required', 400);
    const agentId = req.query.agentId || undefined;
    const result = clearTodos(sessionId, agentId);
    if (!result.ok) return apiError(result.error, 500);
    return json({ sessionId, agentId: agentId ?? null, removed: result.value });
  });

  // GET /api/todos — 全部计划（跨会话/跨 agent；备份包携带用）
  registerRoute('GET', '/api/todos', async () => {
    const items = listAllTodos();
    return json({ items, total: items.length });
  });

  registerRoute('GET', '/api/models', async () => {
    const models = getRegisteredModels();
    return json(models);
  });
}
