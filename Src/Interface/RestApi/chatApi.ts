/**
 * @module Interface/RestApi/chatApi
 * @description
 * 会话与消息 API——Docs/16 F0.7。
 * GET/POST /api/sessions、GET/POST /api/sessions/:id/messages。
 * 消息落 DB（main 库 chat_sessions / chat_messages 表，migration v18/v19）。
 */

import { json, apiError, registerRoute } from './router.js';
import { getMainDb } from '../../Infra/Db/index.js';
import { publish, createEvent } from '../../Services/EventBus/eventBus.js';
import { EventType } from '../../Services/EventBus/eventTypes.js';
import { v4 as uuidv4 } from 'uuid';
import { getRegisteredModels } from '../../Infra/Llm/Router/modelRouter.js';

// ── 类型 ────────────────────────────────────────────────────────────

export interface ChatSessionRow {
  session_id: string;
  title: string;
  status: 'active' | 'archived' | 'closed';
  created_at: number;
  updated_at: number;
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
}

// ── 会话操作 ────────────────────────────────────────────────────────

export function listSessions(): ChatSessionRow[] {
  const db = getMainDb();
  return db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC').all() as ChatSessionRow[];
}

export function createSession(title?: string): ChatSessionRow {
  const db = getMainDb();
  const sessionId = `sess-${uuidv4().slice(0, 8)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO chat_sessions (session_id, title, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`,
  ).run(sessionId, title ?? 'New Chat', now, now);
  return { session_id: sessionId, title: title ?? 'New Chat', status: 'active', created_at: now, updated_at: now };
}

export function getSession(sessionId: string): ChatSessionRow | undefined {
  const db = getMainDb();
  return db.prepare('SELECT * FROM chat_sessions WHERE session_id = ?').get(sessionId) as ChatSessionRow | undefined;
}

/** 更新会话标题（用于自动命名） */
export function updateSessionTitle(sessionId: string, title: string): void {
  const db = getMainDb();
  db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE session_id = ?')
    .run(title, Date.now(), sessionId);
}

// ── 消息操作 ────────────────────────────────────────────────────────

export function listMessages(sessionId: string, limit = 50): ChatMessageRow[] {
  const db = getMainDb();
  return db.prepare(
    'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?',
  ).all(sessionId, limit) as ChatMessageRow[];
}

export function addMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string, extra?: { model?: string; tokens_used?: number; trace_id?: string }): ChatMessageRow {
  const db = getMainDb();
  const messageId = `msg-${uuidv4().slice(0, 8)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO chat_messages (message_id, session_id, role, content, model, tokens_used, trace_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(messageId, sessionId, role, content, extra?.model ?? null, extra?.tokens_used ?? null, extra?.trace_id ?? null, now);

  // 更新会话时间戳
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE session_id = ?').run(now, sessionId);

  // 发布事件（前端可订阅 agent:chat_message 增量推送）
  publish(createEvent({
    eventType: EventType.AGENT_CHAT_MESSAGE,
    source: 'chatApi/addMessage',
    payload: { messageId, sessionId, role, content },
  }));

  return { message_id: messageId, session_id: sessionId, role, content, model: extra?.model, tokens_used: extra?.tokens_used, trace_id: extra?.trace_id, created_at: now };
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerChatRoutes(): void {
  // GET /api/sessions — 会话列表
  registerRoute('GET', '/api/sessions', async () => {
    return json(listSessions());
  });

  // POST /api/sessions — 创建会话
  registerRoute('POST', '/api/sessions', async (req) => {
    const title = req.body?.title as string | undefined;
    const session = createSession(title);
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

  // PATCH /api/sessions/:sessionId — 更新会话（标题等）
  registerRoute('PATCH', '/api/sessions/:sessionId', async (req) => {
    const sessionId = req.params.sessionId;
    if (!sessionId) return apiError('sessionId is required', 400);
    const session = getSession(sessionId);
    if (!session) return apiError('Session not found', 404);

    const title = req.body?.title as string | undefined;
    if (title !== undefined) {
      updateSessionTitle(sessionId, title);
    }
    return json(getSession(sessionId));
  });

  // GET /api/models — 获取可用模型列表
  registerRoute('GET', '/api/models', async () => {
    const models = getRegisteredModels();
    return json(models);
  });
}
