/**
 * 会话与消息 store——F2 增强。
 * 消息六态：queued / streaming / complete / error / stopped / regenerating
 * 流式缓冲：100ms 合批渲染，禁止逐 token setState。
 */
import { create } from 'zustand';
import { apiGet, apiPost, apiPatch } from '@/services/api';
import { useHotReloadStore } from './hotReloadStore';
import { useEventStore } from './eventStore';
import {
  ipcListSessions,
  ipcCreateSession,
  ipcUpdateSession,
  ipcListMessages,
  ipcArchiveSession,
  ipcAddMessage,
  type ChatSession as IpcChatSession,
  type ChatMessage as IpcChatMessage,
} from '@/services/ipcApi';

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
  /** 任务工作目录（工具与 shell 的路径根）：默认 <项目根>/Data/workspaces/<sessionId>/ */
  work_dir?: string | null;
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

/**
 * 消息内容片段——按事件发生顺序追加。
 *
 * 2026-10-01 修复：原先把思考（reasoning）与工具调用聚合到气泡顶部、
 * 正文追加在下方，多轮迭代时无法对应"哪段思考/工具产出哪段正文"，
 * 视觉上像是浮在回复内容之上。改为按发生顺序排列的片段流：
 * 思考 → 工具 → 正文 → （下一轮）思考 → 工具 → 正文 …
 */
export type MessageSegment =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tools'; iteration: number; toolCalls: ToolCallEntry[] };

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
  /** 失败原因（后端 AGENT_STREAM_END.error 原文，供 UI 展示诊断信息） */
  error?: string;
  /** 按序内容片段（流式会话内使用；历史消息无此字段，回退为纯正文渲染） */
  segments?: MessageSegment[];
}

/** 工具调用条目（前端渲染用） */
export interface ToolCallEntry {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * 工具调用状态：
   *  - `generating`：模型**正在生成**该调用（参数还没出完，尚未执行）→ UI 提前显示"生成中"
   *  - `pending`：已开始执行（安全门/审批/执行中）→ UI 显示旋转图标
   *  - `success` / `error`：已出结果
   */
  status: 'success' | 'error' | 'pending' | 'generating';
  content?: string;
  error?: { code: string; message: string };
  /** 关联的审批 ID（危险工具被安全门阻塞时写入；前端据此内嵌审批卡） */
  approvalId?: string;
  /** 审批状态（与审批栏共享同一份决策结果） */
  approvalStatus?: 'pending' | 'approved' | 'rejected' | 'timeout' | 'auto-approved';
  /** 本次工具执行耗时（ms），由统一派发器产出 */
  durationMs?: number;
}

// ── 流式缓冲 ────────────────────────────────────────────────────────

interface StreamBuffer {
  sessionId: string;
  messageId: string;
  rawContent: string;       // 未合批的原始累积
  flushedContent: string;   // 已刷新到 UI 的内容
  rawReasoning: string;     // 思维链原始累积
  flushedReasoning: string; // 已刷新到 UI 的思维链
  /** 按序片段累积（思考/工具/正文） */
  segments: MessageSegment[];
  /** 片段有变更（工具事件可能不伴随文本增量，需要独立触发落库） */
  segmentsDirty: boolean;
  flushTimer: ReturnType<typeof setInterval> | null;
}

/**
 * 修改某条消息的片段列表。
 *
 * 关键：流式期间**必须写缓冲**（`buf.segments`），否则下一次 flush 会用缓冲里的旧列表
 * 覆盖消息上的片段 —— 表现为"工具块一闪就消失"。无缓冲（流结束后）时直接写消息。
 */
function mutateSegments(
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
  messageId: string,
  updater: (segs: MessageSegment[]) => MessageSegment[],
): void {
  const buf = streamBuffers.get(messageId);
  if (buf) {
    buf.segments = updater(buf.segments);
    buf.segmentsDirty = true;
    return;
  }
  set(state => {
    const sid = findSessionForMessage(state, messageId);
    const msgs = sid ? state.messages[sid] : undefined;
    if (!msgs) return {};
    const idx = msgs.findIndex(m => m.message_id === messageId);
    if (idx < 0) return {};
    const updated = [...msgs];
    updated[idx] = { ...updated[idx], segments: updater(updated[idx].segments ?? []) };
    return { messages: { ...state.messages, [sid!]: updated } };
  });
}

/** 向片段流追加文本：与末段同类型则合并，否则新起一段（保证"追加"语义） */
function appendSegmentText(list: MessageSegment[], kind: 'text' | 'reasoning', delta: string): void {
  const last = list[list.length - 1];
  if (last && last.kind === kind) {
    list[list.length - 1] = { kind, text: last.text + delta };
  } else {
    list.push({ kind, text: delta });
  }
}

// ── Store 状态 ──────────────────────────────────────────────────────

interface ChatState {
  sessions: ChatSession[];
  /**
   * 已归档任务（2026-10-03）。
   *
   * 与 `sessions` 分开存放：归档是软状态（不删除消息），默认列表只显示未归档任务，
   * 「已归档」分区按需展示并支持取消归档。
   */
  archivedSessions: ChatSession[];
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
  /** 归档 / 取消归档任务（软状态）；成功后刷新两个列表 */
  archiveSession: (sessionId: string, archived: boolean) => Promise<boolean>;
  /** 更新会话工作目录（空值=重置为默认目录），返回生效后的路径 */
  setWorkDir: (sessionId: string, workDir: string | null) => Promise<string | null>;
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
  /** 单次迭代完成（工具调用/结果 + 轮次） */
  applyIterationComplete: (messageId: string, data: {
    iteration: number;
    totalIterations: number;
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolResults: Array<{ tool_call_id: string; status: string; content?: string; error?: { code: string; message: string } }>;
  }) => void;
  /** 工具开始执行（预创建工具片段，保证顺序） */
  applyToolCallStarted: (messageId: string, data: {
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    iteration: number;
  }) => void;
  applyToolCallPending: (messageId: string, data: {
    toolCallId: string;
    index: number;
    toolName?: string;
    iteration: number;
  }) => void;
  /** 工具执行结束（更新工具片段状态与结果） */
  applyToolCallResult: (messageId: string, data: {
    toolCallId: string;
    status: 'success' | 'error';
    content?: string;
    error?: { code: string; message: string };
    durationMs?: number;
  }) => void;
  /** 危险工具被审批门阻塞（按 toolCallId 关联到工具行，内嵌审批卡） */
  applyApprovalRequired: (data: { toolCallId: string; approvalId: string }) => void;
  /** 审批决策落定（与审批栏共享同一结果；支持自动通过；`pending` 为中间态，忽略） */
  applyApprovalDecided: (data: {
    toolCallId: string;
    status: 'approved' | 'rejected' | 'timeout' | 'pending';
    auto?: boolean;
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

/** 安全 JSON 解析（库中字段可能为空/损坏） */
function parseJsonArray<T>(raw: unknown): T[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 数据库行 → 组件可渲染的消息。
 *
 * AI 组件族重建的关键一步：`chat_messages` 里的富结构列（迁移 v23）
 * 必须映射回 `reasoning` / `toolCalls` / `segments` / `totalIterations` / `error`，
 * 否则 MessageBubble 只能回退为纯正文渲染（重启后"工具、思考等组件消失"）。
 */
export function hydrateRichMessage(row: ChatMessage & {
  tool_calls_json?: string | null;
  segments_json?: string | null;
  total_iterations?: number | null;
}): ChatMessage {
  return {
    ...row,
    status: 'complete' as MessageStatus,
    reasoning: row.reasoning ?? undefined,
    toolCalls: row.toolCalls ?? parseJsonArray<ToolCallEntry>(row.tool_calls_json),
    segments: row.segments ?? parseJsonArray<MessageSegment>(row.segments_json),
    totalIterations: row.totalIterations ?? row.total_iterations ?? undefined,
    error: row.error ?? undefined,
  };
}

/**
 * 回放某会话的 AI 组件事件（重启后重建组件族）。
 *
 * 组件族是**事件驱动**的（`ai-components` 按 eventTypes 注册、payload 取自事件），
 * 所以除消息富结构外，事件流本身也是"被创建即需持久化"的内容。
 * 服务端把事件写入 `ai_events`（迁移 v23），此处按序推回前端事件缓冲：
 * `eventStore.pushEvent → AIEventBus → Subscribe`（与实时链路完全一致）。
 *
 * @returns 回放的事件条数
 */
async function replayAiEvents(sessionId: string): Promise<number> {
  try {
    const res = await apiGet<{ events: Array<{ id: string; type: string; data: unknown; timestamp: number }> }>(
      `/api/sessions/${sessionId}/ai-events`,
    );
    if (!res.ok || !res.data?.events?.length) return 0;
    const store = useEventStore.getState();
    store.clearEvents();
    for (const e of res.data.events) {
      store.pushEvent({ type: e.type, data: e.data, timestamp: e.timestamp });
    }
    return res.data.events.length;
  } catch {
    return 0;
  }
}

/**
 * 运行结束后把富结构（思考/工具卡/分段/失败原因）回填到本地库。
 *
 * 必要性：文本由后端在流式结束时落库，而富结构只存在于前端运行态（由事件累积），
 * 不回填则重启后**只剩纯文本**。失败不阻塞 UI（仅告警）。
 */
function persistMessageRich(
  get: () => ChatState,
  sessionId: string | null,
  messageId: string,
): void {
  if (!sessionId) return;
  const msg = get().messages[sessionId]?.find((m) => m.message_id === messageId);
  if (!msg || msg.role !== 'assistant') return;
  // 没有任何组件数据时不写（纯文本已由后端落库）
  if (!msg.reasoning && !msg.toolCalls?.length && !msg.segments?.length) return;

  // 落库前**收敛未终态**：`generating`（模型还在生成参数）与 `pending`（未出结果）
  // 若原样落库，重启后工具行会永远转圈。这里标记为"未执行完成"，语义诚实且是终态。
  const settle = (tc: ToolCallEntry): ToolCallEntry =>
    tc.status === 'generating' || tc.status === 'pending'
      ? {
          ...tc,
          status: 'error',
          error: tc.error ?? { code: 'NOT_EXECUTED', message: '工具调用未执行完成（运行被停止或审批未决）' },
        }
      : tc;
  const toolCalls = msg.toolCalls?.map(settle);
  const segments = msg.segments?.map((s) =>
    s.kind === 'tools' ? { ...s, toolCalls: s.toolCalls.map(settle) } : s,
  );

  void apiPost(`/api/sessions/${sessionId}/messages/rich`, {
    role: msg.role,
    content: msg.content ?? '',
    reasoning: msg.reasoning,
    toolCalls,
    segments,
    totalIterations: msg.totalIterations,
    error: msg.error,
    status: msg.status,
    model: msg.model,
    tokensUsed: msg.tokens_used,
    traceId: msg.trace_id,
  }).then((res) => {
    // 关键：`apiPost` 在 HTTP 失败时**返回 {ok:false} 而非抛错**，
    // 不检查结果就会完全静默（组件数据丢失且无人察觉——实测踩到过：本地限流 429）。
    if (!res.ok) {
      console.warn('[chatStore] 富结构回填失败（重启后组件会缺失）', res.error);
    }
  }).catch((e: unknown) => {
    console.warn('[chatStore] 富结构回填异常（重启后组件会缺失）', e);
  });
}

/**
 * toolCallId → messageId 索引。
 *
 * 必要性：工具片段在流式期间先写入缓冲（100ms 后落库），而审批事件几毫秒后就到达；
 * 若此时再去 `state.messages` 里查找工具条目会查不到，审批与工具行的关联就会**永久丢失**
 * （表现为对话里没有审批卡）。因此工具开始时就登记索引，审批事件直接按 messageId 写缓冲。
 */
const toolMessageIndex = new Map<string, string>();

function flushBuffer(buf: StreamBuffer, set: (fn: (s: ChatState) => Partial<ChatState>) => void) {
  const noTextChange = buf.rawContent === buf.flushedContent && buf.rawReasoning === buf.flushedReasoning;
  if (noTextChange && !buf.segmentsDirty) return;
  buf.flushedContent = buf.rawContent;
  buf.flushedReasoning = buf.rawReasoning;
  buf.segmentsDirty = false;
  // 片段数组做浅拷贝，保证 React 能感知变化
  const segments = buf.segments.slice();
  set(state => {
    const msgs = state.messages[buf.sessionId];
    if (!msgs) return {};
    const idx = msgs.findIndex(m => m.message_id === buf.messageId);
    if (idx < 0) return {};
    const updated = [...msgs];
    updated[idx] = {
      ...updated[idx],
      content: buf.flushedContent,
      reasoning: buf.flushedReasoning || undefined,
      segments,
    };
    return { messages: { ...state.messages, [buf.sessionId]: updated } };
  });
}

// ── Store 创建 ──────────────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  archivedSessions: [],
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
    // 分两次取：未归档（默认列表）与已归档（分区展示）
    const load = async (archived: boolean | 'all'): Promise<ChatSession[] | null> => {
      try {
        const ipcRes = await ipcListSessions({ archived });
        if (ipcRes.ok && ipcRes.data) return ipcRes.data as ChatSession[];
      } catch {
        /* 降级 HTTP */
      }
      const res = await apiGet<ChatSession[]>(`/api/sessions${archived === 'all' ? '?archived=all' : ''}`);
      return res.ok ? res.data : null;
    };

    const active = await load(false);
    // 后端不可用 / IPC 不可用 / 返回非数组：保持现状直接退出，不抛错
    // （此前只判 `=== null`，非数组响应会在 `[...active]` 处抛 TypeError）
    if (!Array.isArray(active)) return;
    const archivedRaw = await load(true);
    const archivedList: ChatSession[] = Array.isArray(archivedRaw) ? archivedRaw : [];

    const sessions: ChatSession[] = [...active].sort((a, b) => b.updated_at - a.updated_at);
    const archivedSessions: ChatSession[] = [...archivedList].sort((a, b) => b.updated_at - a.updated_at);

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
      archivedSessions,
      conversations,
      activeConversationId: prevAgent ? prevConv : nextConv,
      activeAgentSessionId: prevAgent ?? nextAgent,
      activeSessionId: prevAgent ?? nextAgent,
    }));
  },

  archiveSession: async (sessionId, archived) => {
    // 优先 IPC，降级本地 REST
    let ok = false;
    try {
      const ipcRes = await ipcArchiveSession({ sessionId, archived });
      ok = ipcRes.ok;
      if (!ok) console.warn('[chatStore] 归档失败', ipcRes.error);
    } catch {
      const res = await apiPost(`/api/sessions/${sessionId}/archive`, { archived });
      ok = res.ok;
      if (!res.ok) console.warn('[chatStore] 归档失败', res.error.message);
    }
    if (!ok) return false;

    // 归档的是当前打开的任务 → 从列表里选下一个（避免停在已归档任务上）
    const state = get();
    if (archived && state.activeAgentSessionId === sessionId) {
      const remaining = state.sessions.filter(s => s.session_id !== sessionId);
      const next = remaining[0]?.session_id ?? null;
      set({
        activeAgentSessionId: next,
        activeConversationId: next,
        activeSessionId: next,
      });
    }
    await get().hydrateSessions();
    return true;
  },

  hydrateMessages: async (sessionId) => {
    set({ loading: true });
    // 优先 IPC 直连，降级 HTTP
    let messages: ChatMessage[] = [];
    try {
      const ipcRes = await ipcListMessages(sessionId);
      if (ipcRes.ok && ipcRes.data) {
        messages = ipcRes.data as ChatMessage[];
      } else {
        const res = await apiGet<ChatMessage[]>(`/api/sessions/${sessionId}/messages`);
        if (!res.ok) {
          set({ loading: false });
          return;
        }
        messages = res.data;
      }
    } catch {
      const res = await apiGet<ChatMessage[]>(`/api/sessions/${sessionId}/messages`);
      if (!res.ok) {
        set({ loading: false });
        return;
      }
      messages = res.data;
    }
    // 历史消息全部标记为 complete，并**把富结构映射回组件所需的字段**
    // （AI 组件族重建：思考 CoTFolder / 工具 ToolGroup / 分段 MessageShell / 失败诊断）
    // 之前只映射 content，导致重启或切回会话时"除正文以外全部消失"。
    const completed = messages.map(m => hydrateRichMessage(m));

    // 保留本地"尚未入库"的消息（进行中的流式消息、被手动暂停的部分回复、以及
    // 后端落库尚未完成的竞态窗口）。否则切走再切回时，暂停前已显示的内容会被清空。
    const state = get();
    const prevMsgs = state.messages[sessionId] ?? [];
    const dbKeys = new Set(completed.map(m => `${m.role}\u0000${m.content}`));
    const lastDbTs = completed.length > 0 ? completed[completed.length - 1]!.created_at : 0;
    const localOnly = prevMsgs.filter(m =>
      m.status !== 'complete'
      && m.created_at >= lastDbTs
      // 内容已在库中（后端已落库同一段文本）→ 用库里的记录，避免重复
      && !dbKeys.has(`${m.role}\u0000${m.content}`),
    );

    const merged = localOnly.length > 0 ? [...completed, ...localOnly] : completed;
    set({ messages: { ...state.messages, [sessionId]: merged }, loading: false });
    // 回放该会话的 AI 组件事件（重启/切回会话后重建事件驱动的组件）
    void replayAiEvents(sessionId);
  },

  createSession: async (title) => {
    // 优先 IPC 直连，降级 HTTP
    let session: ChatSession | null = null;
    try {
      const ipcRes = await ipcCreateSession({ title });
      if (ipcRes.ok && ipcRes.data) {
        session = ipcRes.data as ChatSession;
      } else {
        const res = await apiPost<ChatSession>('/api/sessions', { title });
        if (!res.ok) return null;
        session = res.data;
      }
    } catch {
      const res = await apiPost<ChatSession>('/api/sessions', { title });
      if (!res.ok) return null;
      session = res.data;
    }
    if (!session) return null;
    // 真实"新任务"：新会话立即成为当前会话（清空对话区，后续消息进新会话）；
    // 后端已为其创建默认工作目录 Data/workspaces/<sessionId>/
    set(state => ({
      sessions: [session, ...state.sessions],
      activeSessionId: session.session_id,
      activeConversationId: session.session_id,
      activeAgentSessionId: session.session_id,
      messages: { ...state.messages, [session.session_id]: [] },
    }));
    return session.session_id;
  },

  setWorkDir: async (sessionId, workDir) => {
    // 优先 IPC 直连，降级 HTTP
    let updatedSession: ChatSession | null = null;
    try {
      const ipcRes = await ipcUpdateSession({ sessionId, workDir });
      if (ipcRes.ok && ipcRes.data) {
        updatedSession = ipcRes.data as ChatSession;
      } else {
        const res = await apiPatch<ChatSession>(`/api/sessions/${sessionId}`, { workDir });
        if (!res.ok) return null;
        updatedSession = res.data;
      }
    } catch {
      const res = await apiPatch<ChatSession>(`/api/sessions/${sessionId}`, { workDir });
      if (!res.ok) return null;
      updatedSession = res.data;
    }
    if (!updatedSession) return null;
    set(state => ({
      sessions: state.sessions.map(s => (s.session_id === sessionId ? updatedSession! : s)),
    }));
    return updatedSession.work_dir ?? null;
  },

  sendMessage: async (sessionId, content) => {
    // FE-013 乐观更新：先本地插入 queued 气泡（临时 id），网络往返期间用户立即可见；
    // 落库成功后替换为服务端消息，失败则回滚移除（返回 null）。
    const tempId = `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const tempMsg: ChatMessage = {
      message_id: tempId,
      session_id: sessionId,
      role: 'user',
      content,
      created_at: Date.now(),
      status: 'queued',
    };
    set(state => {
      const prev = state.messages[sessionId] ?? [];
      return { messages: { ...state.messages, [sessionId]: [...prev, tempMsg] } };
    });

    // 优先 IPC 直连，降级 HTTP
    let msg: ChatMessage | null = null;
    try {
      const ipcRes = await ipcAddMessage({ sessionId, role: 'user', content });
      if (ipcRes.ok && ipcRes.data) {
        msg = { ...ipcRes.data, status: 'complete' } as ChatMessage;
      } else {
        const res = await apiPost<ChatMessage>(`/api/sessions/${sessionId}/messages`, { role: 'user', content });
        if (res.ok) msg = { ...res.data, status: 'complete' };
      }
    } catch {
      const res = await apiPost<ChatMessage>(`/api/sessions/${sessionId}/messages`, { role: 'user', content });
      if (res.ok) msg = { ...res.data, status: 'complete' };
    }

    if (!msg) {
      // 落库失败 → 回滚乐观气泡（FE-013）
      set(state => {
        const prev = state.messages[sessionId] ?? [];
        return {
          messages: { ...state.messages, [sessionId]: prev.filter(m => m.message_id !== tempId) },
        };
      });
      return null;
    }

    // 替换临时气泡为服务端消息（保留位置，避免文字闪动）
    const saved = msg;
    set(state => {
      const prev = state.messages[sessionId] ?? [];
      return {
        messages: {
          ...state.messages,
          [sessionId]: prev.map(m => (m.message_id === tempId ? saved : m)),
        },
      };
    });
    return saved.message_id;
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
    // 切换对话 → 触发 onNavigate 级热重载
    useHotReloadStore.getState().flushOnNavigate();
  },

  setActiveAgent: (agentSessionId) => {
    set({
      activeAgentSessionId: agentSessionId,
      activeSessionId: agentSessionId,
    });
    // 切换 Agent → 触发 onNavigate 级热重载
    useHotReloadStore.getState().flushOnNavigate();
  },

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
      segments: [],
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
      segments: [],
      segmentsDirty: false,
      flushTimer: null,
    };
    buf.flushTimer = setInterval(() => flushBuffer(buf, set), FLUSH_INTERVAL_MS);
    streamBuffers.set(messageId, buf);

    return messageId;
  },

  appendStreamChunk: (messageId, chunk, reasoning) => {
    const buf = streamBuffers.get(messageId);
    if (!buf) return;
    if (reasoning) {
      buf.rawReasoning += reasoning;
      appendSegmentText(buf.segments, 'reasoning', reasoning);
    }
    if (chunk) {
      buf.rawContent += chunk;
      appendSegmentText(buf.segments, 'text', chunk);
    }
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
    // 回填富结构，供重启/切回会话时重建组件（思考、工具卡、分段）
    persistMessageRich(get, findSessionForMessage(get(), messageId), messageId);
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
    // 手动暂停也要保住已生成的组件（否则暂停后重启，思考/工具卡全丢）
    persistMessageRich(get, findSessionForMessage(get(), messageId), messageId);
  },

  setStreamError: (messageId, error) => {
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
      // 保留后端返回的失败原因，UI 可据此显示「环境变量未设置」等具体诊断信息
      updated[idx] = { ...updated[idx], status: 'error', error };
      return { messages: { ...state.messages, [sid!]: updated }, streamingMessageId: null };
    });
    // 失败时同样保住已产生的组件数据（便于重启后复盘）
    persistMessageRich(get, findSessionForMessage(get(), messageId), messageId);
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

      // 与"工具开始"事件对齐：已由 AGENT_TOOL_CALL_STARTED 预创建的条目**就地更新**，
      // 只有从未见过的工具调用才补建片段（避免重复，也避免块位置被挪到最后）。
      const known = new Set<string>();
      let unresolved: ToolCallEntry[] = [];
      mutateSegments(set, messageId, segs => {
        const next: MessageSegment[] = segs.map(seg => {
          if (seg.kind !== 'tools') return seg;
          let changed = false;
          const nextCalls = seg.toolCalls.map(existing => {
            known.add(existing.id);
            const fresh = toolCalls.find(t => t.id === existing.id);
            if (!fresh) return existing;
            changed = true;
            return { ...existing, ...fresh };
          });
          return changed ? { ...seg, toolCalls: nextCalls } : seg;
        });
        unresolved = toolCalls.filter(t => !known.has(t.id));
        if (unresolved.length > 0) {
          next.push({ kind: 'tools', iteration: data.iteration, toolCalls: unresolved });
        }
        return next;
      });

      updated[idx] = {
        ...prev,
        toolCalls: [...(prev.toolCalls ?? []), ...unresolved],
        totalIterations: data.totalIterations,
      };
      return { messages: { ...state.messages, [sid!]: updated } };
    });
  },

  /**
   * 工具开始执行（模型已决定调用、工具尚未返回）→ **就地预创建**工具片段，
   * 使其位置落在随后流出的正文之前。
   */
  /**
   * 模型**正在生成**工具调用（修复 2026-10-03）：
   * 工具要等整段响应结束才执行，而生成一次写文件调用可能耗时数十秒。
   * 这里在**首个增量**到达时就把工具块建出来（状态 generating），让界面立刻有反馈。
   */
  applyToolCallPending: (messageId, data) => {
    // 尚无真实 id（增量未带 id）时用临时键，待 onToolCallStarted 到来时就地接管
    const provisionalId = data.toolCallId && data.toolCallId !== ''
      ? data.toolCallId
      : `gen-${data.iteration}-${data.index}`;
    toolMessageIndex.set(provisionalId, messageId);

    mutateSegments(set, messageId, segs => {
      const next = [...segs];
      for (let i = next.length - 1; i >= 0; i--) {
        const seg = next[i]!;
        if (seg.kind !== 'tools') continue;
        // 同一轮次内：真实 id 到达时要**就地接管**临时键条目，避免多出一行
        const existsIdx = seg.toolCalls.findIndex(tc =>
          tc.id === provisionalId
          || (tc.status === 'generating' && tc.id.startsWith('gen-') && seg.iteration === data.iteration && data.toolCallId !== ''),
        );
        if (existsIdx >= 0) {
          next[i] = {
            ...seg,
            toolCalls: seg.toolCalls.map((tc, k) => k === existsIdx
              ? {
                  ...tc,
                  id: data.toolCallId && data.toolCallId !== '' ? data.toolCallId : tc.id,
                  name: tc.name || (data.toolName ?? ''),
                  status: 'generating' as const,
                }
              : tc),
          };
          return next;
        }
        break; // 只检查最后一段工具片段（当前轮次）
      }

      const entry: ToolCallEntry = {
        id: provisionalId,
        name: data.toolName ?? '',
        arguments: {},
        status: 'generating',
      };
      const last = next[next.length - 1];
      if (last && last.kind === 'tools' && last.iteration === data.iteration) {
        next[next.length - 1] = { ...last, toolCalls: [...last.toolCalls, entry] };
      } else {
        next.push({ kind: 'tools', iteration: data.iteration, toolCalls: [entry] });
      }
      return next;
    });

    // 聚合列表同步（与 applyToolCallStarted 一致）
    set(state => {
      const sid = findSessionForMessage(state, messageId);
      const msgs = sid ? state.messages[sid] : undefined;
      if (!msgs) return {};
      const idx = msgs.findIndex(m => m.message_id === messageId);
      if (idx < 0) return {};
      const updated = [...msgs];
      const list = updated[idx]!.toolCalls ?? [];
      if (list.some(tc => tc.id === provisionalId)) return {};
      updated[idx] = {
        ...updated[idx]!,
        toolCalls: [...list, { id: provisionalId, name: data.toolName ?? '', arguments: {}, status: 'generating' }],
      };
      return { messages: { ...state.messages, [sid!]: updated } };
    });
  },

  applyToolCallStarted: (messageId, data) => {
    // 若此前已由 applyToolCallPending 预创建（生成中），**就地接管**而不是新增一条：
    // 优先按真实 id 匹配；其次按同轮次的临时键匹配（增量未带 id 的情况）。
    let adopted = false;
    mutateSegments(set, messageId, segs => {
      const next = segs.map(seg => {
        if (seg.kind !== 'tools') return seg;
        const idx = seg.toolCalls.findIndex(tc =>
          tc.id === data.toolCallId
          || (tc.status === 'generating' && tc.id.startsWith('gen-') && seg.iteration === data.iteration),
        );
        if (idx < 0) return seg;
        adopted = true;
        const updated = [...seg.toolCalls];
        updated[idx] = {
          ...updated[idx]!,
          id: data.toolCallId,
          name: data.toolName,
          arguments: data.arguments,
          status: 'pending',
        };
        return { ...seg, toolCalls: updated };
      });
      return next;
    });
    if (adopted) {
      toolMessageIndex.set(data.toolCallId, messageId);
      // 聚合列表里同步改 id/名称/参数
      set(state => {
        const sid = findSessionForMessage(state, messageId);
        const msgs = sid ? state.messages[sid] : undefined;
        if (!msgs) return {};
        const idx = msgs.findIndex(m => m.message_id === messageId);
        if (idx < 0) return {};
        const updated = [...msgs];
        const list = (updated[idx]!.toolCalls ?? []).map(tc =>
          tc.status === 'generating' && (tc.id === data.toolCallId || tc.id.startsWith('gen-'))
            ? { ...tc, id: data.toolCallId, name: data.toolName, arguments: data.arguments, status: 'pending' as const }
            : tc,
        );
        updated[idx] = { ...updated[idx]!, toolCalls: list };
        return { messages: { ...state.messages, [sid!]: updated } };
      });
      return;
    }

    const entry: ToolCallEntry = {
      id: data.toolCallId,
      name: data.toolName,
      arguments: data.arguments,
      status: 'pending',
    };
    // 登记索引：审批事件随后到达时据此写入（含流式缓冲），避免关联丢失
    toolMessageIndex.set(data.toolCallId, messageId);

    mutateSegments(set, messageId, segs => {
      const next = [...segs];
      // 若末尾已是同一轮的工具片段则并入，否则新起一段
      const last = next[next.length - 1];
      if (last && last.kind === 'tools' && last.iteration === data.iteration) {
        next[next.length - 1] = { ...last, toolCalls: [...last.toolCalls, entry] };
      } else {
        next.push({ kind: 'tools', iteration: data.iteration, toolCalls: [entry] });
      }
      return next;
    });

    // 聚合列表（供折叠/计数等）同步追加
    set(state => {
      const sid = findSessionForMessage(state, messageId);
      const msgs = sid ? state.messages[sid] : undefined;
      if (!msgs) return {};
      const idx = msgs.findIndex(m => m.message_id === messageId);
      if (idx < 0) return {};
      const updated = [...msgs];
      updated[idx] = { ...updated[idx], toolCalls: [...(updated[idx].toolCalls ?? []), entry] };
      return { messages: { ...state.messages, [sid!]: updated } };
    });
  },

  /** 工具执行结束 → 更新对应工具条目的状态与结果 */
  applyToolCallResult: (messageId, data) => {
    const patch = (tc: ToolCallEntry): ToolCallEntry =>
      tc.id === data.toolCallId
        ? {
            ...tc,
            status: data.status,
            content: data.content,
            error: data.error,
            ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
          }
        : tc;

    mutateSegments(set, messageId, segs =>
      segs.map(seg => (seg.kind === 'tools' ? { ...seg, toolCalls: seg.toolCalls.map(patch) } : seg)),
    );

    set(state => {
      const sid = findSessionForMessage(state, messageId);
      const msgs = sid ? state.messages[sid] : undefined;
      if (!msgs) return {};
      const idx = msgs.findIndex(m => m.message_id === messageId);
      if (idx < 0) return {};
      const updated = [...msgs];
      updated[idx] = { ...updated[idx], toolCalls: (updated[idx].toolCalls ?? []).map(patch) };
      return { messages: { ...state.messages, [sid!]: updated } };
    });
  },

  /**
   * 危险工具被审批门阻塞 → 把它与审批 ID 关联起来。
   * 前端据此在**对话中的工具行**内嵌审批卡；审批栏读同一份 approvalStore，
   * 因此两处展示同一审批、任一处点击都同步生效。
   */
  applyApprovalRequired: ({ toolCallId, approvalId }) => {
    const patch = (tc: ToolCallEntry): ToolCallEntry =>
      tc.id === toolCallId ? { ...tc, approvalId, approvalStatus: 'pending' } : tc;

    // ① 优先按索引定位（可写入仍在缓冲中的片段 —— 审批事件通常先于首次 flush 到达）
    const indexed = toolMessageIndex.get(toolCallId);
    if (indexed) {
      mutateSegments(set, indexed, segs =>
        segs.map(seg => (seg.kind === 'tools' ? { ...seg, toolCalls: seg.toolCalls.map(patch) } : seg)),
      );
    }

    // ② 同步已落库的消息（聚合列表 + 兜底：索引丢失时全量扫描）
    set(state => {
      const messages: Record<string, ChatMessage[]> = {};
      for (const [sid, msgs] of Object.entries(state.messages)) {
        messages[sid] = msgs.map(m => ({
          ...m,
          toolCalls: (m.toolCalls ?? []).map(patch),
          segments: indexed && indexed !== m.message_id
            ? (m.segments ?? [])
            : (m.segments ?? []).map(seg =>
                seg.kind === 'tools' ? { ...seg, toolCalls: seg.toolCalls.map(patch) } : seg,
              ),
        }));
      }
      return { messages };
    });
  },

  /** 审批决策落定 → 更新工具行的审批状态（自动通过标记 auto-approved） */
  applyApprovalDecided: ({ toolCallId, status, auto }) => {
    // 多角色 unanimous 审批会产生**中间态**决策事件（仍为 PENDING）：
    // 若把它当作拒绝，就会出现"点击确认后卡片显示已拒绝、而后端仍在阻塞"的错误观感。
    if (status === 'pending') return;

    const approvalStatus: ToolCallEntry['approvalStatus'] =
      status === 'approved' ? (auto ? 'auto-approved' : 'approved')
      : status === 'timeout' ? 'timeout'
      : 'rejected';

    const patch = (tc: ToolCallEntry): ToolCallEntry =>
      tc.id === toolCallId ? { ...tc, approvalStatus } : tc;

    const indexed = toolMessageIndex.get(toolCallId);
    if (indexed) {
      mutateSegments(set, indexed, segs =>
        segs.map(seg => (seg.kind === 'tools' ? { ...seg, toolCalls: seg.toolCalls.map(patch) } : seg)),
      );
    }

    set(state => {
      const messages: Record<string, ChatMessage[]> = {};
      for (const [sid, msgs] of Object.entries(state.messages)) {
        messages[sid] = msgs.map(m => ({
          ...m,
          toolCalls: (m.toolCalls ?? []).map(patch),
          segments: (m.segments ?? []).map(seg =>
            seg.kind === 'tools' ? { ...seg, toolCalls: seg.toolCalls.map(patch) } : seg,
          ),
        }));
      }
      return { messages };
    });
  },

  updateSessionTitle: async (sessionId, title) => {
    // 优先 IPC 直连，降级 HTTP
    try {
      const ipcRes = await ipcUpdateSession({ sessionId, title });
      if (ipcRes.ok) {
        set(state => ({
          sessions: state.sessions.map(s => s.session_id === sessionId ? { ...s, title } : s),
          conversations: state.conversations.map(c => c.conversation_id === sessionId ? { ...c, title } : c),
        }));
        return;
      }
    } catch { /* 降级到 HTTP */ }
    const res = await apiPatch<ChatSession>(`/api/sessions/${sessionId}`, { title });
    if (res.ok) {
      set(state => ({
        sessions: state.sessions.map(s => s.session_id === sessionId ? { ...s, title } : s),
        conversations: state.conversations.map(c => c.conversation_id === sessionId ? { ...c, title } : c),
      }));
    }
  },

  fetchModels: async () => {
    // 优先 IPC 直连，降级 HTTP
    const api = (globalThis as any).electronAPI;
    if (api?.modelProviders?.getModels) {
      try {
        const models = await api.modelProviders.getModels();
        set({ availableModels: models });
        if (!get().selectedModel && models.length > 0) {
          set({ selectedModel: models[0] });
        }
        return;
      } catch { /* 降级到 HTTP */ }
    }
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
