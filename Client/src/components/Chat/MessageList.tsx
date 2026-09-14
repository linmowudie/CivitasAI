/**
 * MessageList——消息列表 + 智能滚动。
 * F2.4：距底 <100px 才自动跟随，用户上滑即锁定。
 */
import { useRef, useEffect, useCallback, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import MessageBubble from './MessageBubble';
import type { ChatMessage } from '@/stores/chatStore';

interface MessageListProps {
  messages: ChatMessage[];
  streamingMessageId: string | null;
}

const AUTO_SCROLL_THRESHOLD = 100; // px

export default function MessageList({ messages, streamingMessageId }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [announcement, setAnnouncement] = useState('');

  // 智能滚动：距底 <100px 才自动跟随
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsAtBottom(distFromBottom < AUTO_SCROLL_THRESHOLD);
  }, []);

  // 消息变化时，如果在底部则自动滚动
  useEffect(() => {
    if (isAtBottom && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, isAtBottom]);

  // 流式消息更新时也检查
  useEffect(() => {
    if (isAtBottom && streamingMessageId && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, streamingMessageId, isAtBottom]);

  // aria-live 播报
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      setAnnouncement(`${lastMsg.role} 发送了新消息`);
    }
  }, [messages.length]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="relative flex-1">
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-5 py-4 h-full"
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
          <>
            {messages.map(msg => (
              <MessageBubble key={msg.message_id} msg={msg} />
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* 回到底部按钮 */}
      {!isAtBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 w-8 h-8 rounded-full bg-surface-700 border border-surface-600 flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-600 transition-all shadow-lg"
          title="滚动到底部"
        >
          <ChevronDown size={16} />
        </button>
      )}
    </div>
  );
}
