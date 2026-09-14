/**
 * ChatView——F2 重构版。
 * 使用 components/Chat/* 子组件 + chatStore 六态 + WS 流式订阅。
 */
import { useState, useEffect, useCallback } from 'react';
import {
  MessageSquare, Plus, Search, Settings2, MoreHorizontal,
} from 'lucide-react';
import { useChatStore, type ChatSession } from '@/stores/chatStore';
import { sendWs } from '@/services/ws';
import MessageList from '@/components/Chat/MessageList';
import Composer from '@/components/Chat/Composer';

export default function ChatView() {
  const {
    sessions, messages, activeSessionId, streamingMessageId,
    hydrateSessions, hydrateMessages, createSession, sendMessage,
    setActiveSession, beginStream, stopStream,
  } = useChatStore();

  const [searchQuery, setSearchQuery] = useState('');

  // ── 初始化 ──
  useEffect(() => { hydrateSessions(); }, []);
  useEffect(() => {
    if (activeSessionId) hydrateMessages(activeSessionId);
  }, [activeSessionId]);

  // ── 发送消息 ──
  const handleSend = useCallback(async (content: string) => {
    if (!activeSessionId) return;

    // 1. 发送用户消息到后端
    await sendMessage(activeSessionId, content);

    // 2. 创建流式占位消息（显示名与 routing.defaultModel 保持一致）
    const streamMsgId = beginStream(activeSessionId, 'DeepSeek-V4-Flash');

    // 3. 通过 WS 请求后端开始生成（payload 包裹契约，见 wsHandler）
    sendWs({
      type: 'generate_reply',
      payload: {
        sessionId: activeSessionId,
        userMessage: content,
        messageId: streamMsgId,
      },
    });

    // 4. 800ms 内如果还没收到第一个 chunk，显示排队态
    setTimeout(() => {
      const state = useChatStore.getState();
      const sid = activeSessionId;
      const msgs = state.messages[sid] ?? [];
      const streamMsg = msgs.find(m => m.message_id === streamMsgId);
      if (streamMsg && streamMsg.status === 'streaming' && streamMsg.content === '') {
        // 仍在等待，保持 streaming 状态即可（UI 会显示脉冲动画）
      }
    }, 800);
  }, [activeSessionId]);

  // ── 停止 ──
  const handleStop = useCallback(() => {
    if (streamingMessageId) {
      stopStream(streamingMessageId);
      // 通知后端停止（payload 包裹契约）
      sendWs({ type: 'stop_generation', payload: { messageId: streamingMessageId } });
    }
  }, [streamingMessageId]);

  // ── 新建会话 ──
  const handleNewSession = async () => {
    const id = await createSession();
    if (id) setActiveSession(id);
  };

  // ── 过滤 ──
  const filteredSessions = sessions.filter(s =>
    !searchQuery || s.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const activeSession = sessions.find(s => s.session_id === activeSessionId);
  const activeMessages = messages[activeSessionId ?? ''] ?? [];
  const isStreaming = streamingMessageId !== null;

  return (
    <div className="flex h-full">
      {/* ── 会话列表 ──────────────────────────────────── */}
      <div className="w-[300px] flex-shrink-0 flex flex-col border-r border-surface-700 bg-surface-900">
        <div className="px-4 py-3.5 border-b border-surface-700">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <MessageSquare size={15} className="text-brand-400" />
              对话
            </h2>
            <button className="btn-new-chat" title="新建对话" onClick={handleNewSession}>
              <Plus size={14} />
            </button>
          </div>
          <div className="search-box">
            <Search size={13} className="text-text-muted" />
            <input
              type="text"
              placeholder="搜索会话…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
          {filteredSessions.length === 0 ? (
            <div className="text-center py-8 text-text-muted text-xs">暂无会话</div>
          ) : (
            filteredSessions.map(s => (
              <SessionItem
                key={s.session_id}
                session={s}
                isActive={s.session_id === activeSessionId}
                onClick={() => setActiveSession(s.session_id)}
              />
            ))
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-surface-700 flex items-center justify-between text-[10px] font-mono text-text-muted">
          <span>{sessions.filter(s => s.status === 'active').length} 个活跃会话</span>
          <span>共 {sessions.length} 个会话</span>
        </div>
      </div>

      {/* ── 聊天主区域 ─────────────────────────────────── */}
      <div className="flex-1 flex flex-col bg-surface-950">
        {/* 聊天头部 */}
        {activeSession && (
          <div className="px-5 py-3 border-b border-surface-700 flex items-center justify-between bg-surface-900/50">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center text-sm">💬</div>
              <div>
                <div className="text-sm font-semibold text-text-primary">{activeSession.title}</div>
                <div className="text-[11px] text-text-muted font-mono">{activeSession.session_id}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button className="btn-ghost !px-2 !py-1.5"><Settings2 size={14} /></button>
              <button className="btn-ghost !px-2 !py-1.5"><MoreHorizontal size={14} /></button>
            </div>
          </div>
        )}

        {/* 消息列表 */}
        <MessageList messages={activeMessages} streamingMessageId={streamingMessageId} />

        {/* 输入框 */}
        <Composer
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreaming}
          disabled={!activeSessionId}
        />
      </div>
    </div>
  );
}

/* ── 会话列表项 ────────────────────────────────────────────── */

function SessionItem({
  session, isActive, onClick,
}: {
  session: ChatSession; isActive: boolean; onClick: () => void;
}) {
  const statusDot = {
    active: 'bg-agent-running animate-pulse-dot',
    archived: 'bg-agent-ready',
    closed: 'bg-agent-destroyed',
  }[session.status] ?? 'bg-agent-ready';

  return (
    <div className={`session-item ${isActive ? 'active' : ''}`} onClick={onClick}>
      <div className="flex items-center gap-2.5">
        <div className="relative">
          <div className="w-9 h-9 rounded-lg bg-surface-700 flex items-center justify-center text-sm">💬</div>
          <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-surface-900 ${statusDot}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text-primary truncate">{session.title}</span>
          </div>
          <div className="text-[10px] text-text-muted font-mono">
            {new Date(session.updated_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
          </div>
        </div>
      </div>
    </div>
  );
}
