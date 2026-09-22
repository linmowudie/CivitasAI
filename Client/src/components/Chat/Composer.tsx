/**
 * Composer——消息输入框 + 工作方式/模型选择器 + Stop/发送按钮。
 * F2.5：Esc 取消编辑、prefers-reduced-motion。
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Square, ChevronDown } from 'lucide-react';
import { WORKING_MODE_META } from './ConversationCard';
import type { WorkingMode } from '@/stores/chatStore';

interface ComposerProps {
  onSend: (content: string, model?: string, workingMode?: WorkingMode) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  /** 可用模型列表（qualified name） */
  availableModels?: string[];
  /** 当前选中模型 */
  selectedModel?: string;
  /** 当前选中工作方式 */
  selectedWorkingMode?: WorkingMode;
  /** 切换模型 */
  onSelectModel?: (model: string) => void;
  /** 切换工作方式 */
  onSelectWorkingMode?: (mode: WorkingMode) => void;
}

export default function Composer({
  onSend, onStop, isStreaming, disabled,
  availableModels = [], selectedModel = '', selectedWorkingMode = 'DIRECT',
  onSelectModel, onSelectWorkingMode,
}: ComposerProps) {
  const [input, setInput] = useState('');
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);

  // 自动聚焦
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setShowModeMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSend = useCallback(() => {
    if (!input.trim() || disabled) return;
    onSend(input.trim(), selectedModel || undefined, selectedWorkingMode);
    setInput('');
    // 重置高度
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [input, disabled, onSend, selectedModel, selectedWorkingMode]);

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

  // 提取模型短名（去掉 provider/ 前缀）
  const modelShortName = (q: string) => q.includes('/') ? q.split('/').pop()! : q;

  return (
    <div className="flex-shrink-0 px-5 py-3 border-t border-surface-700 bg-surface-900/30">
      <div className="chat-input-container">
        {/* ── 选择器行 ── */}
        <div className="flex items-center gap-2 mb-2">
          {/* 工作方式选择器 */}
          <div className="relative" ref={modeMenuRef}>
            <button
              className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-surface-600 text-text-secondary hover:border-brand-400 transition-colors"
              onClick={() => !isStreaming && setShowModeMenu(v => !v)}
              disabled={isStreaming}
              title="选择工作方式"
            >
              <span style={{ color: WORKING_MODE_META[selectedWorkingMode]?.color }}>
                {WORKING_MODE_META[selectedWorkingMode]?.label ?? '直接执行'}
              </span>
              <ChevronDown size={10} />
            </button>
            {showModeMenu && !isStreaming && (
              <div className="absolute bottom-full left-0 mb-1 bg-surface-800 border border-surface-600 rounded-lg shadow-xl py-1 z-50 min-w-[120px]">
                {(Object.entries(WORKING_MODE_META) as [WorkingMode, { label: string; color: string }][]).map(([mode, meta]) => (
                  <button
                    key={mode}
                    className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-surface-700 transition-colors flex items-center gap-2"
                    style={{ color: mode === selectedWorkingMode ? meta.color : undefined }}
                    onClick={() => {
                      onSelectWorkingMode?.(mode);
                      setShowModeMenu(false);
                    }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: meta.color }} />
                    {meta.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 模型选择器 */}
          {availableModels.length > 0 && (
            <div className="relative" ref={modelMenuRef}>
              <button
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-surface-600 text-text-secondary hover:border-brand-400 transition-colors font-mono"
                onClick={() => !isStreaming && setShowModelMenu(v => !v)}
                disabled={isStreaming}
                title="选择模型"
              >
                <span>{modelShortName(selectedModel || availableModels[0])}</span>
                <ChevronDown size={10} />
              </button>
              {showModelMenu && !isStreaming && (
                <div className="absolute bottom-full left-0 mb-1 bg-surface-800 border border-surface-600 rounded-lg shadow-xl py-1 z-50 min-w-[160px]">
                  {availableModels.map(m => (
                    <button
                      key={m}
                      className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-surface-700 transition-colors font-mono ${m === selectedModel ? 'text-brand-400' : 'text-text-secondary'}`}
                      onClick={() => {
                        onSelectModel?.(m);
                        setShowModelMenu(false);
                      }}
                    >
                      {m.includes('/') ? m.split('/').pop() : m}
                      {m.includes('/') && <span className="text-text-muted ml-1">({m.split('/')[0]})</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── 输入框 ── */}
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
