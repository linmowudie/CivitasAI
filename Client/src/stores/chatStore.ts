/**
 * 会话与消息 store——F2 增强。
 * 消息六态：queued / streaming / complete / error / stopped / regenerating
 * 流式缓冲：100ms 合批渲染，禁止逐 token setState。
 */
import { create } from 'zustand';
import { apiGet, apiPost, apiPatch } from '@/services/api';

// ── 类型 ────────────────────────────────────────────────────────────

export type MessageStatus = 'queued' | 'streaming' | 'complete' | 'error' | 'stopped' | 'regenerating';

export type WorkingMode = 'DIRECT' | 'DELEGATION' | 'ASSEMBLY_LINE' | 'CONSORTIUM' | 'LITIGATION' | 'REGULATION' | 'AUDIT';

export interface ChatSession {
  session_id: string;
  /** 绑定 Agent 编号（后端 wsHandler 创建入口 Agent 时写入） */
  agent_id?: string;
  /** 当前工作方式（后端路由决策后写入，前端新建时默认 DIRECT） */
  working_mode?: WorkingMode;
  title: string;
  status: 'active' | 'archived' | 'closed';
  created_at: number;
  updated_at: number;
}

/**
 * 对话——分组容器。
 * 一个对话下可包含多个 L1 级 Agent 卡片（一对多）。
 * 当前后端尚未支持多 Agent 分组时，每个对话默认含 1 个 Agent。
 */
export interface Conversation {
  conversation_id: string;
  title: string;
  status: 'active' | 'archived' | 'closed';
  agents: AgentCard[];
  created_at: number;
  updated_at: number;
}

/** L1 级 Agent 卡片——归属于某个对话 */
export interface AgentCard {
  agent_id: string;
  session_id: string;
  title: string;
  working_mode: WorkingMode;
  status: 'active' | 'archived' | 'closed';
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
  /** 工具调用列表（由 AGENT_ITERATION_COMPLETE 事件填充） */
  toolCalls?: ToolCallEntry[];
  /** 总迭代轮次（由 AGENT_ITERATION_COMPLETE 事件填充） */
  totalIterations?: number;
}

/** 工具调用条目（前端渲染用） */
export interface ToolCallEntry {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: 'success' | 'error' | 'pending';
  content?: string;
  error?: { code: string; message: string };
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
  /** 对话列表（由 sessions 派生，conversation_id → agents 一对多） */
  conversations: Conversation[];
  /** 当前选中的对话 ID（右侧列表选中项） */
  activeConversationId: string | null;
  /** 当前选中的 Agent session ID（点击卡片后进入聊天） */
  activeAgentSessionId: string | null;
  loading: boolean;
  /** 当前正在流式输出的消息 ID */
  streamingMessageId: string | null;
  /** 当前选中的模型（qualified name，如 "huawei-maas/DeepSeek-V4-Flash"） */
  selectedModel: string;
  /** 当前选中的工作方式 */
  selectedWorkingMode: WorkingMode;
  /** 可用模型列表 */
  availableModels: string[];

  // ── CRUD ──
  hydrateSessions: () => Promise<void>;
  hydrateMessages: (sessionId: string) => Promise<void>;
  createSession: (title?: string) => Promise<string | null>;
  sendMessage: (sessionId: string, content: string) => Promise<string | null>;
  setActiveSession: (id: string | null) => void;
  /** 选中右侧对话项 */
  setActiveConversation: (id: string | null) => void;
  /** 点击 Agent 卡片 → 进入聊天 */
  setActiveAgent: (agentSessionId: string | null) => void;

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
  /** 应用迭代完成事件（填充工具调用/结果） */
  applyIterationComplete: (messageId: string, data: {
    iteration: number;
    totalIterations: number;
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolResults: Array<{ tool_call_id: string; status: string; content?: string; error?: { code: string; message: string } }>;
  }) => void;
  /** 更新会话标题 */
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
  /** 获取可用模型列表 */
  fetchModels: () => Promise<void>;
  /** 设置选中模型 */
  setSelectedModel: (model: string) => void;
  /** 设置选中工作方式 */
  setSelectedWorkingMode: (mode: WorkingMode) => void;
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
  conversations: [],
  activeConversationId: null,
  activeAgentSessionId: null,
  loading: false,
  streamingMessageId: null,
  selectedModel: '',
  selectedWorkingMode: 'DIRECT',
  availableModels: [],

  hydrateSessions: async () => {
    const res = await apiGet<ChatSession[]>('/api/sessions');
    if (!res.ok) return;
    const sessions = [...res.data].sort((a, b) => b.updated_at - a.updated_at);

    // ── 派生对话 → Agent 一对多 ──
    // TODO: 后端支持 conversation_id 后改为按 conversation_id 分组
    const conversations: Conversation[] = sessions.map(s => ({
      conversation_id: s.session_id,
      title: s.title,
      status: s.status,
      agents: [{
        agent_id: s.agent_id ?? s.session_id,
        session_id: s.session_id,
        title: s.title,
        working_mode: s.working_mode ?? 'DIRECT',
        status: s.status,
        updated_at: s.updated_at,
      }],
      created_at: s.created_at,
      updated_at: s.updated_at,
    }));

    const prevConv = get().activeConversationId;
    const prevAgent = get().activeAgentSessionId;
    const nextConv = conversations.some(c => c.conversation_id === prevConv) ? prevConv : conversations[0]?.conversation_id ?? null;
    const nextAgent = conversations.find(c => c.conversation_id === nextConv)?.agents[0]?.session_id ?? null;

    set(state => ({
      sessions,
      conversations,
      activeConversationId: prevAgent ? prevConv : nextConv,
      activeAgentSessionId: prevAgent ?? nextAgent,
      activeSessionId: prevAgent ?? nextAgent,
    }));
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

  setActiveConversation: (id) => {
    const conv = get().conversations.find(c => c.conversation_id === id);
    const firstAgent = conv?.agents[0]?.session_id ?? null;
    set({
      activeConversationId: id,
      activeAgentSessionId: firstAgent,
      activeSessionId: firstAgent,
    });
  },

  setActiveAgent: (agentSessionId) => set({
    activeAgentSessionId: agentSessionId,
    activeSessionId: agentSessionId,
  }),

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

  applyIterationComplete: (messageId, data) => {
    set(state => {
      const sid = findSessionForMessage(state, messageId);
      const msgs = sid ? state.messages[sid] : undefined;
      if (!msgs) return {};
      const idx = msgs.findIndex(m => m.message_id === messageId);
      if (idx < 0) return {};

      // 合并工具调用与结果
      const toolCalls: ToolCallEntry[] = data.toolCalls.map(tc => {
        const result = data.toolResults.find(r => r.tool_call_id === tc.id);
        return {
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          status: result ? (result.status as 'success' | 'error') : 'pending',
          content: result?.content,
          error: result?.error,
        };
      });

      const updated = [...msgs];
      const prev = updated[idx];
      updated[idx] = {
        ...prev,
        toolCalls: [...(prev.toolCalls ?? []), ...toolCalls],
        totalIterations: data.totalIterations,
      };
      return { messages: { ...state.messages, [sid!]: updated } };
    });
  },

  updateSessionTitle: async (sessionId, title) => {
    const res = await apiPatch<ChatSession>(`/api/sessions/${sessionId}`, { title });
    if (res.ok) {
      set(state => ({
        sessions: state.sessions.map(s => s.session_id === sessionId ? { ...s, title } : s),
        conversations: state.conversations.map(c => c.conversation_id === sessionId ? { ...c, title } : c),
      }));
    }
  },

  fetchModels: async () => {
    const res = await apiGet<string[]>('/api/models');
    if (res.ok) {
      set({ availableModels: res.data });
      // 默认选中第一个模型
      if (!get().selectedModel && res.data.length > 0) {
        set({ selectedModel: res.data[0] });
      }
    }
  },

  setSelectedModel: (model) => set({ selectedModel: model }),
  setSelectedWorkingMode: (mode) => set({ selectedWorkingMode: mode }),
}));

function findSessionForMessage(state: ChatState, messageId: string): string | null {
  for (const [sid, msgs] of Object.entries(state.messages)) {
    if (msgs.some(m => m.message_id === messageId)) return sid;
  }
  return null;
}
