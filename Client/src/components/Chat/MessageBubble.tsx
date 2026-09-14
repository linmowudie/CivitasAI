/**
 * MessageBubble——单条消息气泡。
 * F2.3：助手消息使用 Markdown 渲染 + 模型名 + Token 消耗标注。
 * F2.10：思维链（CoT）区块——流式时展开展示，流结束后默认折叠、可点击切换。
 */
import { useState, useEffect } from 'react';
import { Bot, User, Zap, AlertCircle, RefreshCw, Brain, ChevronDown, ChevronRight } from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import type { ChatMessage, MessageStatus } from '@/stores/chatStore';

const statusIcon: Record<MessageStatus, React.ReactNode> = {
  queued: <span className="w-2 h-2 rounded-full bg-text-muted animate-pulse" />,
  streaming: <span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse-dot" />,
  complete: null,
  error: <AlertCircle size={12} className="text-danger" />,
  stopped: <span className="w-2 h-2 rounded-full bg-warning" />,
  regenerating: <RefreshCw size={12} className="text-brand-400 animate-spin" />,
};

const statusLabel: Record<MessageStatus, string> = {
  queued: '排队中', streaming: '生成中', complete: '', error: '生成失败',
  stopped: '已停止', regenerating: '重新生成中',
};

interface MessageBubbleProps {
  msg: ChatMessage;
  onCopy?: () => void;
  onRegenerate?: () => void;
  onThumbUp?: () => void;
  onThumbDown?: () => void;
}

export default function MessageBubble({ msg, onCopy, onRegenerate, onThumbUp, onThumbDown }: MessageBubbleProps) {
  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';
  const isStreaming = msg.status === 'streaming' || msg.status === 'regenerating';
  const hasReasoning = !isUser && !!msg.reasoning;

  // 思维链折叠状态：流式期间强制展开，结束后默认折叠
  const [reasoningOpen, setReasoningOpen] = useState(isStreaming);
  useEffect(() => { setReasoningOpen(isStreaming); }, [isStreaming]);

  if (isSystem) {
    return (
      <div className="flex justify-center my-3">
        <div className="system-event">
          <Zap size={12} className="text-brand-400" />
          <span>{msg.content}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''} mb-4 group`}>
      {/* 头像 */}
      <div className={`chat-avatar ${isUser ? 'user' : 'agent'}`}>
        {isUser ? <User size={16} /> : <Bot size={16} />}
      </div>

      {/* 消息体 */}
      <div className={`flex-1 ${isUser ? 'flex flex-col items-end' : ''}`} style={{ maxWidth: '80%' }}>
        {/* 名称 + 时间 + 模型/Token */}
        <div className={`flex items-center gap-2 mb-1 ${isUser ? 'flex-row-reverse' : ''}`}>
          <span className="text-xs font-medium text-text-secondary">
            {isUser ? '你' : 'Assistant'}
          </span>
          <span className="text-[10px] text-text-muted font-mono">
            {new Date(msg.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </span>
          {msg.model && !isUser && (
            <span className="text-[10px] text-text-muted font-mono px-1 rounded bg-surface-700">{msg.model}</span>
          )}
          {msg.tokens_used != null && !isUser && (
            <span className="text-[10px] text-text-muted font-mono flex items-center gap-0.5">
              <Zap size={9} /> {msg.tokens_used} tok
            </span>
          )}
          {/* 状态指示 */}
          {msg.status !== 'complete' && (
            <span className="flex items-center gap-1 text-[10px] text-text-muted">
              {statusIcon[msg.status]}
              {statusLabel[msg.status]}
            </span>
          )}
        </div>

        {/* 气泡 */}
        <div className={`chat-bubble ${isUser ? 'user' : 'agent'}`}>
          {/* 思维链（CoT）区块：仅助手消息且有 reasoning 内容时展示 */}
          {hasReasoning && (
            <div className="mb-2 rounded-lg bg-surface-800/60 border border-surface-700 overflow-hidden">
              <button
                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-text-muted hover:bg-surface-700/40 transition-colors"
                onClick={() => setReasoningOpen(o => !o)}
              >
                <Brain size={12} className={isStreaming ? 'text-brand-400 animate-pulse' : 'text-text-muted'} />
                <span>{isStreaming ? '思考中…' : '思考过程'}</span>
                {reasoningOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              {reasoningOpen && (
                <div className="px-3 pb-2 text-[11px] leading-relaxed text-text-muted whitespace-pre-wrap border-t border-surface-700/60 pt-1.5">
                  {msg.reasoning}
                </div>
              )}
            </div>
          )}
          {isUser ? (
            <div className="chat-content">{msg.content}</div>
          ) : (
            /* 正文尚未开始但思维链已流式输出时，不渲染空 Markdown 容器 */
            (msg.content || !hasReasoning) && (
              <MarkdownRenderer content={msg.content} isStreaming={isStreaming} />
            )
          )}
        </div>

        {/* 错误提示 */}
        {msg.status === 'error' && (
          <div className="mt-1 text-[11px] text-danger flex items-center gap-1">
            <AlertCircle size={11} />
            <span>生成出错，可点击重新生成</span>
          </div>
        )}
      </div>
    </div>
  );
}
