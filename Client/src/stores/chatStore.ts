/**
 * 会话与消息 store——F2 增强。
 * 消息六态：queued / streaming / complete / error / stopped / regenerating
 * 流式缓冲：100ms 合批渲染，禁止逐 token setState。
 */
import { create } from 'zustand';
import { apiGet, apiPost } from '@/services/api';

// ── 类型 ────────────────────────────────────────────────────────────

export type MessageStatus = 'queued' | 'streaming' | 'complete' | 'error' | 'stopped' | 'regenerating';

export interface ChatSession {
  session_id: string;
  title: string;
  status: 'active' | 'archived' | 'closed';
  created_at: number;
  updated_at: number;
}

export interface ChatMessage {
  message_id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  tokens_used?: number;
  trace_id?: string;
  created_at: number;
  /** F2 消息状态 */
  status: MessageStatus;
  /** 模型思维链（CoT），流式积累；完成后 UI 默认折叠 */
  reasoning?: string;
}

// ── 流式缓冲 ────────────────────────────────────────────────────────

interface StreamBuffer {
  sessionId: string;
  messageId: string;
  rawContent: string;       // 未合批的原始累积
  flushedContent: string;   // 已刷新到 UI 的内容
  rawReasoning: string;     // 思维链原始累积
  flushedReasoning: string; // 已刷新到 UI 的思维链
  flushTimer: ReturnType<typeof setInterval> | null;
}

// ── Store 状态 ──────────────────────────────────────────────────────

interface ChatState {
  sessions: ChatSession[];
  messages: Record<string, ChatMessage[]>;
  activeSessionId: string | null;
  loading: boolean;
  /** 当前正在流式输出的消息 ID */
  streamingMessageId: string | null;

  // ── CRUD ──
  hydrateSessions: () => Promise<void>;
  hydrateMessages: (sessionId: string) => Promise<void>;
  createSession: (title?: string) => Promise<string | null>;
  sendMessage: (sessionId: string, content: string) => Promise<string | null>;
  setActiveSession: (id: string | null) => void;

  // ── 流式 ──
  /** 开始一条新的流式消息，返回 messageId */
  beginStream: (sessionId: string, model?: string) => string;
  /** 追加流片段（100ms 合批；reasoning 为思维链增量，可省略） */
  appendStreamChunk: (messageId: string, chunk: string, reasoning?: string) => void;
  /** 结束流 */
  finalizeStream: (messageId: string, tokensUsed?: number) => void;
  /** 停止流 */
  stopStream: (messageId: string) => void;
  /** 标记错误 */
  setStreamError: (messageId: string, error: string) => void;
  /** 设置消息状态 */
  setMessageStatus: (messageId: string, status: MessageStatus) => void;
}

// ── 内部辅助 ────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 100; // streamFlushIntervalMs
const streamBuffers = new Map<string, StreamBuffer>();

function flushBuffer(buf: StreamBuffer, set: (fn: (s: ChatState) => Partial<ChatState>) => void) {
  if (buf.rawContent === buf.flushedContent && buf.rawReasoning === buf.flushedReasoning) return;
  buf.flushedContent = buf.rawContent;
  buf.flushedReasoning = buf.rawReasoning;
  set(state => {
    const msgs = state.messages[buf.sessionId];
    if (!msgs) return {};
    const idx = msgs.findIndex(m => m.message_id === buf.messageId);
    if (idx < 0) return {};
    const updated = [...msgs];
    updated[idx] = { ...updated[idx], content: buf.flushedContent, reasoning: buf.flushedReasoning || undefined };
    return { messages: { ...state.messages, [buf.sessionId]: updated } };
  });
}

// ── Store 创建 ──────────────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  messages: {},
  activeSessionId: null,
  loading: false,
  streamingMessageId: null,

  hydrateSessions: async () => {
    const res = await apiGet<ChatSession[]>('/api/sessions');
    if (res.ok) set({ sessions: res.data });
  },

  hydrateMessages: async (sessionId) => {
    set({ loading: true });
    const res = await apiGet<ChatMessage[]>(`/api/sessions/${sessionId}/messages`);
    if (res.ok) {
      // 历史消息全部标记为 complete
      const completed = res.data.map(m => ({ ...m, status: 'complete' as MessageStatus }));
      // 保留该会话进行中的流式占位消息（切页返回后 hydrate 不得覆盖丢失）
      const state = get();
      const streamingId = state.streamingMessageId;
      const prevMsgs = state.messages[sessionId] ?? [];
      const streamMsg = streamingId
        ? prevMsgs.find(m => m.message_id === streamingId && m.session_id === sessionId)
        : undefined;
      const merged = streamMsg ? [...completed, streamMsg] : completed;
      set({ messages: { ...state.messages, [sessionId]: merged }, loading: false });
    } else {
      set({ loading: false });
    }
  },

  createSession: async (title) => {
    const res = await apiPost<ChatSession>('/api/sessions', { title });
    if (res.ok) {
      set({ sessions: [res.data, ...get().sessions] });
      return res.data.session_id;
    }
    return null;
  },

  sendMessage: async (sessionId, content) => {
    const res = await apiPost<ChatMessage>(`/api/sessions/${sessionId}/messages`, { role: 'user', content });
    if (res.ok) {
      const msg = { ...res.data, status: 'complete' as MessageStatus };
      const prev = get().messages[sessionId] ?? [];
      set({ messages: { ...get().messages, [sessionId]: [...prev, msg] } });
      return msg.message_id;
    }
    return null;
  },

  setActiveSession: (id) => set({ activeSessionId: id }),

  // ── 流式操作 ──

  beginStream: (sessionId, model) => {
    const messageId = `msg-stream-${Date.now()}`;
    const streamMsg: ChatMessage = {
      message_id: messageId,
      session_id: sessionId,
      role: 'assistant',
      content: '',
      model,
      created_at: Date.now(),
      status: 'streaming',
    };
    const prev = get().messages[sessionId] ?? [];
    set({
      messages: { ...get().messages, [sessionId]: [...prev, streamMsg] },
      streamingMessageId: messageId,
    });

    // 创建缓冲
    const buf: StreamBuffer = {
      sessionId, messageId,
      rawContent: '', flushedContent: '',
      rawReasoning: '', flushedReasoning: '',
      flushTimer: null,
    };
    buf.flushTimer = setInterval(() => flushBuffer(buf, set), FLUSH_INTERVAL_MS);
    streamBuffers.set(messageId, buf);

    return messageId;
  },

  appendStreamChunk: (messageId, chunk, reasoning) => {
    const buf = streamBuffers.get(messageId);
    if (!buf) return;
    if (chunk) buf.rawContent += chunk;
    if (reasoning) buf.rawReasoning += reasoning;
  },

  finalizeStream: (messageId, tokensUsed) => {
    const buf = streamBuffers.get(messageId);
    if (buf) {
      // 立即 flush 剩余内容
      flushBuffer(buf, set);
      if (buf.flushTimer) clearInterval(buf.flushTimer);
      streamBuffers.delete(messageId);
    }
    set(state => {
      const sid = state.streamingMessageId ? findSessionForMessage(state, messageId) : null;
      const msgs = sid ? state.messages[sid] : undefined;
      if (!msgs) return { streamingMessageId: null };
      const idx = msgs.findIndex(m => m.message_id === messageId);
      if (idx < 0) return { streamingMessageId: null };
      const updated = [...msgs];
      updated[idx] = { ...updated[idx], status: 'complete', tokens_used: tokensUsed };
      return { messages: { ...state.messages, [sid!]: updated }, streamingMessageId: null };
    });
  },

  stopStream: (messageId) => {
    const buf = streamBuffers.get(messageId);
    if (buf) {
      flushBuffer(buf, set);
      if (buf.flushTimer) clearInterval(buf.flushTimer);
      streamBuffers.delete(messageId);
    }
    set(state => {
      const sid = findSessionForMessage(state, messageId);
      const msgs = sid ? state.messages[sid] : undefined;
      if (!msgs) return { streamingMessageId: null };
      const idx = msgs.findIndex(m => m.message_id === messageId);
      if (idx < 0) return { streamingMessageId: null };
      const updated = [...msgs];
      updated[idx] = { ...updated[idx], status: 'stopped' };
      return { messages: { ...state.messages, [sid!]: updated }, streamingMessageId: null };
    });
  },

  setStreamError: (messageId, _error) => {
    const buf = streamBuffers.get(messageId);
    if (buf) {
      flushBuffer(buf, set);
      if (buf.flushTimer) clearInterval(buf.flushTimer);
      streamBuffers.delete(messageId);
    }
    set(state => {
      const sid = findSessionForMessage(state, messageId);
      const msgs = sid ? state.messages[sid] : undefined;
      if (!msgs) return { streamingMessageId: null };
      const idx = msgs.findIndex(m => m.message_id === messageId);
      if (idx < 0) return { streamingMessageId: null };
      const updated = [...msgs];
      updated[idx] = { ...updated[idx], status: 'error' };
      return { messages: { ...state.messages, [sid!]: updated }, streamingMessageId: null };
    });
  },

  setMessageStatus: (messageId, status) => {
    set(state => {
      const sid = findSessionForMessage(state, messageId);
      const msgs = sid ? state.messages[sid] : undefined;
      if (!msgs) return {};
      const idx = msgs.findIndex(m => m.message_id === messageId);
      if (idx < 0) return {};
      const updated = [...msgs];
      updated[idx] = { ...updated[idx], status };
      return { messages: { ...state.messages, [sid!]: updated } };
    });
  },
}));

function findSessionForMessage(state: ChatState, messageId: string): string | null {
  for (const [sid, msgs] of Object.entries(state.messages)) {
    if (msgs.some(m => m.message_id === messageId)) return sid;
  }
  return null;
}
