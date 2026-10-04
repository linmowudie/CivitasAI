/**
 * Core.MessageShell——消息外壳组件。
 * 从 MessageBubble 抽离。
 *
 * 职责：消息布局骨架（头像 + 名称 + 时间 + 内容区），
 *       不含业务逻辑（思维链/工具调用由内部组件处理）。
 */

import { Bot, User, Zap, AlertCircle, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MessageStatus } from '@/stores/chatStore';

interface MessageShellProps {
  role: 'user' | 'assistant' | 'system';
  status: MessageStatus;
  createdAt: number | string;
  model?: string;
  tokensUsed?: number;
  totalIterations?: number;
  /** 失败原因（后端返回的错误原文）；缺失时回退为通用提示 */
  error?: string;
  /** 子容器类型标识（FE-014，对齐 Canvas 原型 text/loop/tool/harness 的独立类型头） */
  kindLabel?: string;
  kindIcon?: ReactNode;
  /** 内容区（CoTFolder + ToolGroup + StreamBuffer 等组合） */
  children: ReactNode;
}

const statusIcon: Record<MessageStatus, ReactNode> = {
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

export function MessageShell({
  role, status, createdAt, model, tokensUsed, totalIterations, error, kindLabel, kindIcon, children,
}: MessageShellProps) {
  const isUser = role === 'user';

  if (role === 'system') {
    return (
      <div className="flex justify-center my-3">
        <div className="system-event">
          <Zap size={12} className="text-brand-400" />
          <span>{typeof children === 'string' ? children : ''}</span>
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

      {/*
        消息体宽度：
        - Assistant **占满可用宽度**：其内容包含工具卡、代码块、表格等宽内容，
          原先统一限成 80% 会在右侧留下约 20% 的空白（1800px 窗口下尤其明显）；
          左侧已有头像栏提供留白，因此右侧只需卡片内边距即可。
        - User 保持 80%：短消息右对齐，过宽反而不好看。
      */}
      <div
        className={`flex-1 min-w-0 ${isUser ? 'flex flex-col items-end' : ''}`}
        style={{ maxWidth: isUser ? '80%' : '100%' }}
      >
        {/* 名称 + 时间 + 模型/Token */}
        <div className={`flex items-center gap-2 mb-1 ${isUser ? 'flex-row-reverse' : ''}`}>
          <span className="text-xs font-medium text-text-secondary">
            {isUser ? '你' : 'Assistant'}
          </span>
          {/* 子容器类型头（FE-014）：Tool / Loop / Text */}
          {kindLabel && !isUser && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-700 text-brand-400 flex items-center gap-1">
              {kindIcon}
              {kindLabel}
            </span>
          )}
          <span className="text-[10px] text-text-muted font-mono">
            {new Date(createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </span>
          {model && !isUser && (
            <span className="text-[10px] text-text-muted font-mono px-1 rounded bg-surface-700">{model}</span>
          )}
          {tokensUsed != null && !isUser && (
            <span className="text-[10px] text-text-muted font-mono flex items-center gap-0.5">
              <Zap size={9} /> {tokensUsed} tok
            </span>
          )}
          {totalIterations != null && totalIterations > 0 && !isUser && (
            <span className="text-[10px] text-brand-400 font-mono">
              {totalIterations} 轮迭代
            </span>
          )}
          {/* 状态指示 */}
          {status !== 'complete' && (
            <span className="flex items-center gap-1 text-[10px] text-text-muted">
              {statusIcon[status]}
              {statusLabel[status]}
            </span>
          )}
        </div>

        {/* 气泡 */}
        <div className={`chat-bubble ${isUser ? 'user' : 'agent'}`}>
          {children}
        </div>

        {/* 错误提示：优先展示后端返回的具体原因（如「环境变量 HUAWEI_MAAS_API_KEY 未设置」） */}
        {status === 'error' && (
          <div className="mt-1 text-[11px] text-danger flex items-start gap-1">
            <AlertCircle size={11} className="mt-[2px] flex-shrink-0" />
            {error ? (
              <span className="break-words" title={error}>
                生成出错：{error.length > 300 ? `${error.slice(0, 300)}…` : error}
              </span>
            ) : (
              <span>生成出错，可点击重新生成</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
