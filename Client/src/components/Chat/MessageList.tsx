/**
 * MessageList——消息列表 + Turn-based 分组渲染 + 智能滚动。
 *
 * 对齐 Canvas 原型 L356-397：
 * - 每个 turn = 用户气泡 + Agent 回复容器
 * - 用户气泡：紫色半透明背景
 * - Agent 回复容器：header + 子容器列表 + 自动折叠（>50 子容器时）
 *
 * 滚动策略：F2.4 距底 <100px 才自动跟随，用户上滑即锁定。
 */
import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import MessageBubble from './MessageBubble';
import AgentPreparing from './AgentPreparing';
import type { ChatMessage } from '@/stores/chatStore';

interface MessageListProps {
  messages: ChatMessage[];
  streamingMessageId: string | null;
  /** 当前会话 ID：切换会话时重置跟随状态并定位到最新消息 */
  sessionId?: string | null;
}

/** Turn 数据模型 */
interface ConversationTurn {
  userMessage: ChatMessage;
  agentReplies: ChatMessage[];
}

const AUTO_SCROLL_THRESHOLD = 100; // px
const COLLAPSE_THRESHOLD = 50; // 子容器超过此数量时自动折叠
const COLLAPSE_BATCH = 50; // 折叠时每批容器数（对齐 Canvas L364）

/** 将扁平消息按 role 分组为 turn */
function groupMessagesIntoTurns(messages: ChatMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let currentTurn: ConversationTurn | null = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      // 新的用户消息 → 新 turn
      currentTurn = { userMessage: msg, agentReplies: [] };
      turns.push(currentTurn);
    } else if (msg.role === 'assistant' || msg.role === 'system') {
      if (!currentTurn) {
        // 没有用户消息前的助手消息，创建虚拟 turn
        currentTurn = {
          userMessage: {
            message_id: '__virtual__',
            session_id: msg.session_id,
            role: 'user',
            content: '',
            status: 'complete',
            created_at: msg.created_at,
          },
          agentReplies: [],
        };
        turns.push(currentTurn);
      }
      currentTurn.agentReplies.push(msg);
    }
  }

  return turns;
}

/**
 * 判断某条 Agent 回复是否仍处于"准备中"：
 * 已挂载（queued/streaming/regenerating）但正文、思维链、工具调用均未产出。
 * 这类占位消息不应渲染为子容器，也不应计入 header 的"N 个子容器"。
 */
function isPreparingReply(msg: ChatMessage): boolean {
  const busy =
    msg.status === 'queued' || msg.status === 'streaming' || msg.status === 'regenerating';
  return busy && !msg.content && !msg.reasoning && !msg.toolCalls?.length;
}

/**
 * 空内容 + 已停止：用户点停止时模型尚未产出任何内容（FE-015）。
 * 这类消息不渲染为子容器（避免一个空的"已停止"气泡），仅在轮次内显示轻提示。
 */
function isEmptyStoppedReply(msg: ChatMessage): boolean {
  return msg.status === 'stopped' && !msg.content && !msg.reasoning && !msg.toolCalls?.length;
}

/** 单个 Turn 渲染 */
function TurnView({ turn, isLastTurn }: { turn: ConversationTurn; isLastTurn: boolean }) {
  // 已产出内容的子容器 / 仍在准备中的占位（空停止消息剔除，见 FE-015）
  const settled = useMemo(
    () => turn.agentReplies.filter((m) => !isPreparingReply(m) && !isEmptyStoppedReply(m)),
    [turn.agentReplies],
  );
  const preparing = useMemo(
    () => turn.agentReplies.filter(isPreparingReply),
    [turn.agentReplies],
  );
  const stoppedEmpty = useMemo(
    () => turn.agentReplies.filter(isEmptyStoppedReply),
    [turn.agentReplies],
  );

  const replyCount = settled.length;
  const preparingModel = preparing[0]?.model;
  const shouldAutoCollapse = replyCount > COLLAPSE_THRESHOLD;
  // 超过阈值即自动折叠（Canvas L361-365）。
  // 依赖为布尔量：流式追加使子容器从 ≤50 越过 50 时会自动折叠，
  // 而用户手动展开后不会因后续追加被反复折叠。
  const [collapsed, setCollapsed] = useState(shouldAutoCollapse);

  useEffect(() => {
    if (shouldAutoCollapse) setCollapsed(true);
  }, [shouldAutoCollapse]);

  // 折叠时按 COLLAPSE_BATCH 分批：仅最后一批直接渲染，其余渲染为虚线占位块
  // 只对已产出内容的子容器分批，准备中的占位不参与折叠
  const batches = useMemo(() => {
    if (!shouldAutoCollapse) return [settled];
    const out: ChatMessage[][] = [];
    for (let i = 0; i < replyCount; i += COLLAPSE_BATCH) {
      out.push(settled.slice(i, i + COLLAPSE_BATCH));
    }
    return out;
  }, [settled, shouldAutoCollapse, replyCount]);

  /** 折叠批次占位框（点击展开全部），对齐 Canvas L385-390 */
  const collapsedBatch = (from: number, to: number) => (
    <button
      key={`batch-${from}`}
      onClick={() => setCollapsed(false)}
      title="展开全部子容器"
      className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text-secondary text-left
                 rounded-md border border-dashed border-surface-600 bg-surface-800
                 hover:border-brand-500/40 hover:text-text-primary transition-colors"
    >
      <ChevronRight size={12} className="flex-shrink-0" />
      <span className="flex-1 truncate">
        {to - from + 1} 个容器（#{from}–#{to}）
      </span>
    </button>
  );

  /** 是否直接渲染全部子容器 */
  const showAll = !collapsed;

  // 用户消息气泡
  const userBubble = turn.userMessage.message_id !== '__virtual__' && (
    <div className="mb-3">
      <div
        className="rounded-lg px-4 py-3 text-text-primary text-sm leading-relaxed"
        style={{
          background: 'rgba(139, 92, 246, 0.13)',
          border: '1px solid var(--color-surface-700)',
        }}
      >
        {turn.userMessage.content}
      </div>
    </div>
  );

  // Agent 回复容器
  const agentContainer = replyCount > 0 && (
    <div className="rounded-lg border border-surface-700 overflow-hidden">
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-3 py-2 bg-surface-800 border-b border-surface-700"
      >
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span className="font-medium text-brand-400">Agent</span>
          <span className="text-text-muted">· {replyCount} 个子容器</span>
        </div>
        {(shouldAutoCollapse || replyCount > 3) && (
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
          >
            {collapsed ? (
              <>
                <ChevronRight size={12} />
                展开
              </>
            ) : (
              <>
                <ChevronUp size={12} />
                收起
              </>
            )}
          </button>
        )}
      </div>

      {/* 子容器列表：展开态渲染全部（仅已产出内容的子容器） */}
      {showAll && (
        <div className="divide-y divide-surface-700">
          {settled.map((reply) => (
            <div key={reply.message_id} className="p-3">
              <MessageBubble msg={reply} />
            </div>
          ))}
        </div>
      )}

      {/* 折叠态：前置批次渲染为可点击虚线框，最后一批直接可见（Canvas L381-393） */}
      {!showAll && shouldAutoCollapse && (
        <>
          <div className="flex flex-col gap-1.5 p-2">
            {batches.slice(0, -1).map((batch, bi) =>
              collapsedBatch(bi * COLLAPSE_BATCH + 1, bi * COLLAPSE_BATCH + batch.length),
            )}
          </div>
          {batches.length > 0 && (
            <div className="divide-y divide-surface-700 border-t border-surface-700">
              {batches[batches.length - 1].map((reply) => (
                <div key={reply.message_id} className="p-3">
                  <MessageBubble msg={reply} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* 折叠态（≤50 子容器，用户手动收起）：整体折叠为单个虚线框 */}
      {!showAll && !shouldAutoCollapse && (
        <div className="p-2">{collapsedBatch(1, replyCount)}</div>
      )}

      {/* 仍有子容器在准备中：容器内追加准备态行 */}
      {preparing.length > 0 && <AgentPreparing variant="inline" model={preparingModel} />}
    </div>
  );

  return (
    <div className={`mb-4 ${isLastTurn ? 'last-turn' : ''}`}>
      {userBubble}
      {agentContainer}
      {/* 尚无任何已产出子容器：以准备态取代空的 Agent 对话容器 */}
      {replyCount === 0 && preparing.length > 0 && (
        <AgentPreparing variant="block" model={preparingModel} />
      )}
      {/* 停止且未产出任何内容：不渲染空容器，仅轻提示（FE-015） */}
      {replyCount === 0 && preparing.length === 0 && stoppedEmpty.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-text-muted rounded-md border border-dashed border-surface-600 bg-surface-800">
          <span className="w-2 h-2 rounded-full bg-warning flex-shrink-0" />
          已停止（未产生内容）
        </div>
      )}
    </div>
  );
}

export default function MessageList({ messages, streamingMessageId, sessionId }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [announcement, setAnnouncement] = useState('');

  // 将消息分组为 turns
  const turns = useMemo(() => groupMessagesIntoTurns(messages), [messages]);

  // 智能滚动：距底 <100px 才自动跟随
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsAtBottom(distFromBottom < AUTO_SCROLL_THRESHOLD);
  }, []);

  /** 只滚动消息容器自身 */
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // 消息数量变化时，如果在底部则自动跟随
  useEffect(() => {
    if (isAtBottom) scrollToBottom('smooth');
  }, [messages.length, isAtBottom, scrollToBottom]);

  // 流式内容增长时同步跟随（behavior=auto 避免动画拖尾）
  useEffect(() => {
    if (isAtBottom && streamingMessageId) scrollToBottom('auto');
  }, [messages, streamingMessageId, isAtBottom, scrollToBottom]);

  // 切换会话：恢复自动跟随，并直接定位到最新消息（不做平滑动画）
  useEffect(() => {
    setIsAtBottom(true);
    scrollToBottom('auto');
  }, [sessionId, scrollToBottom]);

  // aria-live 播报
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      setAnnouncement(`${lastMsg.role} 发送了新消息`);
    }
  }, [messages.length]);

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={containerRef}
        className="h-full overflow-y-auto px-5 py-4"
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-atomic="false"
      >
        {/* 屏幕阅读器播报 */}
        <span className="sr-only" role="status">{announcement}</span>

        {turns.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-muted">
            <p className="text-sm">暂无消息，开始对话吧</p>
          </div>
        ) : (
          turns.map((turn, idx) => (
            <TurnView
              key={turn.userMessage.message_id}
              turn={turn}
              isLastTurn={idx === turns.length - 1}
            />
          ))
        )}
      </div>

      {/* 回到底部按钮 */}
      {!isAtBottom && (
        <button
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-4 right-4 w-8 h-8 rounded-full bg-surface-700 border border-surface-600 flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-600 transition-all shadow-lg"
          title="滚动到底部"
        >
          <ChevronDown size={16} />
        </button>
      )}
    </div>
  );
}
