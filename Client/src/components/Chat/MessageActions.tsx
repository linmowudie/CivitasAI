/**
 * MessageActions——消息操作按钮组。
 * F2.6：复制 / 重新生成 / 赞踩。
 */
import { useState } from 'react';
import { Copy, RefreshCw, ThumbsUp, ThumbsDown, Check } from 'lucide-react';
import type { ChatMessage } from '@/stores/chatStore';

interface MessageActionsProps {
  msg: ChatMessage;
  onRegenerate?: () => void;
}

export default function MessageActions({ msg, onRegenerate }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [thumb, setThumb] = useState<'up' | 'down' | null>(null);

  if (msg.role !== 'assistant' || msg.status === 'streaming') return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        onClick={handleCopy}
        className="p-1 rounded hover:bg-surface-700 text-text-muted hover:text-text-secondary transition-colors"
        title="复制"
      >
        {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      </button>
      {(msg.status === 'complete' || msg.status === 'error' || msg.status === 'stopped') && onRegenerate && (
        <button
          onClick={onRegenerate}
          className="p-1 rounded hover:bg-surface-700 text-text-muted hover:text-text-secondary transition-colors"
          title="重新生成"
        >
          <RefreshCw size={12} />
        </button>
      )}
      <button
        onClick={() => setThumb(thumb === 'up' ? null : 'up')}
        className={`p-1 rounded hover:bg-surface-700 transition-colors ${thumb === 'up' ? 'text-success' : 'text-text-muted hover:text-text-secondary'}`}
        title="赞同"
      >
        <ThumbsUp size={12} />
      </button>
      <button
        onClick={() => setThumb(thumb === 'down' ? null : 'down')}
        className={`p-1 rounded hover:bg-surface-700 transition-colors ${thumb === 'down' ? 'text-danger' : 'text-text-muted hover:text-text-secondary'}`}
        title="反对"
      >
        <ThumbsDown size={12} />
      </button>
    </div>
  );
}
