/**
 * Composer——底部输入框（对齐 Canvas 原型 L864-972）
 *
 * 双子容器设计：
 * - 上容器: 可展开/收起的文本输入区（收起 36px，展开 120-240px）
 * - 下容器: 操作按钮行
 *   - 左侧: 展开/收起切换 + 辅助按钮（📎🖼）
 *   - 右侧: 紫色圆角发送按钮（background: accent, 32x32, "↑"）
 *
 * F2.5：Esc 取消编辑、prefers-reduced-motion。
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronUp, Paperclip, Image, Bot, Zap } from 'lucide-react';
import type { WorkingMode } from '@/stores/chatStore';

/** 工作方式标签映射 */
const WORKING_MODE_LABELS: Record<WorkingMode, string> = {
  DIRECT: '直接执行',
  DELEGATION: '委托模式',
  ASSEMBLY_LINE: '流水线',
  CONSORTIUM: ' consortium',
  LITIGATION: '诉讼模式',
  REGULATION: '监管模式',
  AUDIT: '审计模式',
};

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
  const [expanded, setExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 自动聚焦
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  const handleSend = useCallback(() => {
    if (!input.trim() || disabled) return;
    onSend(input.trim(), selectedModel || undefined, selectedWorkingMode);
    setInput('');
  }, [input, disabled, onSend, selectedModel, selectedWorkingMode]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) return;
      handleSend();
    }
    if (e.key === 'Escape') {
      setInput('');
    }
  };

  // 自动调整高度
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, expanded ? 240 : 200)}px`;
  };

  const canSend = input.trim() && !disabled && !isStreaming;

  return (
    <div className="flex-shrink-0 px-4 py-3 border-t border-surface-700 bg-surface-900/30">
      <div className="flex flex-col gap-2">
        {/* ── 上容器：可展开文本输入区 ── */}
        <div
          className="rounded-lg border border-surface-700 bg-surface-800 overflow-hidden transition-all duration-200"
          style={{ minHeight: expanded ? 120 : 36 }}
        >
          <textarea
            ref={textareaRef}
            className="w-full h-full bg-transparent text-text-primary text-sm px-3 py-2 resize-none outline-none placeholder:text-text-muted"
            style={{ minHeight: expanded ? 120 : 36, maxHeight: 240 }}
            placeholder={disabled ? '请先选择会话…' : '输入消息… (Enter 发送, Shift+Enter 换行)'}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            rows={expanded ? 5 : 1}
            disabled={disabled}
          />
        </div>

        {/* ─ 下容器：操作按钮行 ── */}
        <div className="flex items-center justify-between">
          {/* 左侧：展开/收起 + 辅助按钮 + 模型/工作方式选择器 */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-700 transition-colors"
              title={expanded ? '收起' : '展开'}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>

            <button
              className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-700 transition-colors"
              title="附件"
            >
              <Paperclip size={14} />
            </button>

            <button
              className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-700 transition-colors"
              title="图片"
            >
              <Image size={14} />
            </button>

            {/* 模型选择器 */}
            {availableModels.length > 0 && onSelectModel && (
              <div className="relative ml-1">
                <select
                  value={selectedModel}
                  onChange={e => onSelectModel(e.target.value)}
                  disabled={isStreaming}
                  className="h-7 pl-2 pr-6 rounded-md bg-surface-700 border border-surface-600 text-text-secondary text-xs outline-none focus:border-brand-500 appearance-none disabled:opacity-50 cursor-pointer max-w-[180px] truncate"
                  title={selectedModel || '选择模型'}
                >
                  <option value="">默认模型</option>
                  {availableModels.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <Bot size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                <ChevronDown size={10} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              </div>
            )}

            {/* 工作方式选择器 */}
            {onSelectWorkingMode && (
              <div className="relative ml-1">
                <select
                  value={selectedWorkingMode}
                  onChange={e => onSelectWorkingMode(e.target.value as WorkingMode)}
                  disabled={isStreaming}
                  className="h-7 pl-2 pr-6 rounded-md bg-surface-700 border border-surface-600 text-text-secondary text-xs outline-none focus:border-brand-500 appearance-none disabled:opacity-50 cursor-pointer"
                  title="工作方式"
                >
                  {Object.entries(WORKING_MODE_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
                <Zap size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                <ChevronDown size={10} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              </div>
            )}

            {isStreaming && (
              <span className="flex items-center gap-1 ml-2 text-xs text-brand-400">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-dot" />
                生成中…
              </span>
            )}
          </div>

          {/* 右侧：发送/停止按钮 */}
          <div className="flex items-center gap-2">
            {isStreaming ? (
              <button
                onClick={onStop}
                className="flex items-center justify-center w-8 h-8 rounded-lg bg-danger text-white text-xs font-bold hover:opacity-90 transition-opacity"
                title="停止生成"
              >
                ■
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!canSend}
                className={`flex items-center justify-center w-8 h-8 rounded-lg text-white text-sm font-bold transition-all ${
                  canSend
                    ? 'bg-brand-500 hover:bg-brand-600 shadow-lg shadow-brand-500/20'
                    : 'bg-surface-600 text-text-muted cursor-not-allowed'
                }`}
                title="发送"
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
