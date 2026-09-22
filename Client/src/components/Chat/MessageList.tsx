/**
 * MessageList——消息列表 + 智能滚动。
 * F2.4：距底 <100px 才自动跟随，用户上滑即锁定。
 * 滚动只作用于自身容器（el.scrollTo），不得使用 scrollIntoView——
 * 后者会向上逐级滚动祖先容器，导致会话列表 / 整页随之偏移。
 */
import { useRef, useEffect, useCallback, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import MessageBubble from './MessageBubble';
import type { ChatMessage } from '@/stores/chatStore';

interface MessageListProps {
  messages: ChatMessage[];
  streamingMessageId: string | null;
  /** 当前会话 ID：切换会话时重置跟随状态并定位到最新消息 */
  sessionId?: string | null;
}

const AUTO_SCROLL_THRESHOLD = 100; // px

export default function MessageList({ messages, streamingMessageId, sessionId }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [announcement, setAnnouncement] = useState('');

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

        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-muted">
            <p className="text-sm">暂无消息，开始对话吧</p>
          </div>
        ) : (
          messages.map(msg => (
            <MessageBubble key={msg.message_id} msg={msg} />
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
