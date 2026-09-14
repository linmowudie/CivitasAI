/**
 * Composer——消息输入框 + Stop/发送按钮。
 * F2.5：Esc 取消编辑、prefers-reduced-motion。
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Square } from 'lucide-react';

interface ComposerProps {
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export default function Composer({ onSend, onStop, isStreaming, disabled }: ComposerProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 自动聚焦
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  const handleSend = useCallback(() => {
    if (!input.trim() || disabled) return;
    onSend(input.trim());
    setInput('');
    // 重置高度
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [input, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) return; // 流式中 Enter 不发送
      handleSend();
    }
    // Esc 清空输入
    if (e.key === 'Escape') {
      setInput('');
    }
  };

  // 自动调整高度
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="px-5 py-3 border-t border-surface-700 bg-surface-900/30">
      <div className="chat-input-container">
        <textarea
          ref={textareaRef}
          className="chat-input"
          placeholder={disabled ? '请先选择会话…' : '输入消息… (Enter 发送, Shift+Enter 换行)'}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled}
        />
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2 text-[10px] text-text-muted">
            {isStreaming && (
              <span className="flex items-center gap-1 text-brand-400">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-dot" />
                正在生成…
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isStreaming ? (
              <button
                onClick={onStop}
                className="btn btn-danger !px-3 !py-1.5"
                title="停止生成"
              >
                <Square size={13} />
                停止
              </button>
            ) : (
              <button
                className={`btn btn-primary !px-3 !py-1.5 ${!input.trim() || disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                onClick={handleSend}
                disabled={!input.trim() || disabled}
              >
                <Send size={13} />
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
