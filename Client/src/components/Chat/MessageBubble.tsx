/**
 * MessageBubble——单条消息气泡。
 * F2.3：助手消息使用 Markdown 渲染 + 模型名 + Token 消耗标注。
 * F2.10：思维链（CoT）区块——流式时展开展示，流结束后默认折叠、可点击切换。
 *
 * Phase 1 改造：使用 AI 组件族（MessageShell + CoTFolder + ToolGroup + StreamBuffer）组合。
 * MessageBubble 变为薄组合层，实际渲染委托给各族组件。
 *
 * 2026-10-01 修复（顺序渲染）：助手气泡按**片段发生顺序**渲染
 * （思考 → 工具 → 正文 → 下一轮思考/工具/正文 …），
 * 而不是把思考与工具聚合到气泡顶部、正文追加在下方。
 * 历史消息（DB 加载）没有 segments，回退为"正文"渲染。
 */
import { MessageShell } from '@/ai-components/core/MessageShell';
import { CoTFolder } from '@/ai-components/core/CoTFolder';
import { StreamBuffer } from '@/ai-components/core/StreamBuffer';
import { ToolGroup } from '@/ai-components/harness/ToolGroup';
import { Wrench, RefreshCw, Type } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ChatMessage, MessageSegment } from '@/stores/chatStore';

/**
 * 子容器类型判定（FE-014，对齐 Canvas 原型 text/loop/tool/harness 的独立类型头）：
 * - 含工具调用 → Tool（⚡，Harness 族执行帧）
 * - 多轮迭代（>1）→ Loop（⟳）
 * - 纯正文/思考 → Text（T）
 * data 类暂无对应数据源，出现真实数据容器时再扩展。
 */
function inferKind(msg: ChatMessage): { label: string; icon: ReactNode } | null {
  if (msg.role !== 'assistant') return null;
  if (msg.toolCalls?.length) {
    return { label: 'Tool', icon: <Wrench size={10} /> };
  }
  if ((msg.totalIterations ?? 0) > 1) {
    return { label: 'Loop', icon: <RefreshCw size={10} /> };
  }
  return { label: 'Text', icon: <Type size={10} /> };
}

interface MessageBubbleProps {
  msg: ChatMessage;
  onCopy?: () => void;
  onRegenerate?: () => void;
  onThumbUp?: () => void;
  onThumbDown?: () => void;
}

export default function MessageBubble({ msg }: MessageBubbleProps) {
  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';
  const isStreaming = msg.status === 'streaming' || msg.status === 'regenerating';
  const hasReasoning = !isUser && !!msg.reasoning;
  const hasToolCalls = !isUser && !!msg.toolCalls?.length;
  const segments = msg.segments ?? [];
  const kind = inferKind(msg);

  /**
   * 按序渲染单个片段；只有最后一段享受"流式中"表现（思考自动展开等）。
   * key 用片段序号：片段只会追加、不会重排，因此序号稳定；
   * （曾用文本长度做 key，导致两段等长片段 key 冲突 → React 丢子节点）
   */
  const renderSegment = (seg: MessageSegment, index: number, isLast: boolean) => {
    const live = isStreaming && isLast;
    const key = `seg-${index}`;
    switch (seg.kind) {
      case 'reasoning':
        return <CoTFolder key={key} reasoning={seg.text} isStreaming={live} />;
      case 'tools':
        return (
          <ToolGroup
            key={key}
            toolCalls={seg.toolCalls}
            iteration={seg.iteration}
          />
        );
      case 'text':
        return <StreamBuffer key={key} content={seg.text} isStreaming={live} />;
    }
  };

  return (
    <MessageShell
      role={msg.role}
      status={msg.status}
      createdAt={msg.created_at}
      model={msg.model}
      tokensUsed={msg.tokens_used}
      totalIterations={msg.totalIterations}
      error={msg.error}
      kindLabel={kind?.label}
      kindIcon={kind?.icon}
    >
      {/* 系统消息：内容由 MessageShell 直接渲染 */}
      {isSystem && msg.content}

      {/* 助手/用户消息：组合 Core 族 + Harness 族组件 */}
      {!isSystem && (
        isUser ? (
          <div className="chat-content">{msg.content}</div>
        ) : segments.length > 0 ? (
          /* 按事件顺序追加渲染 */
          <div className="flex flex-col">
            {segments.map((seg, i) => renderSegment(seg, i, i === segments.length - 1))}
          </div>
        ) : (
          <>
            {/* 回退（历史消息 / 无片段）：思考 → 工具 → 正文 */}
            {hasReasoning && (
              <CoTFolder reasoning={msg.reasoning!} isStreaming={isStreaming} />
            )}

            {hasToolCalls && (
              <ToolGroup
                toolCalls={msg.toolCalls!}
                totalIterations={msg.totalIterations}
              />
            )}

            {/* 正文尚未开始但思维链已流式输出时，不渲染空 Markdown 容器 */}
            {(msg.content || !hasReasoning) && (
              <StreamBuffer content={msg.content} isStreaming={isStreaming} />
            )}
          </>
        )
      )}
    </MessageShell>
  );
}
