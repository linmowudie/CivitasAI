/**
 * Core.StreamBuffer——流式输出缓冲组件。
 * 从 MessageBubble/StreamingIndicator 抽离。
 *
 * 职责：展示流式输出的增量内容，支持 Markdown 渲染。
 */

import MarkdownRenderer from '@/components/Chat/MarkdownRenderer';
import styles from './StreamBuffer.module.css';

interface StreamBufferProps {
  /** 流式内容 */
  content: string;
  /** 是否正在流式输出 */
  isStreaming: boolean;
}

export function StreamBuffer({ content, isStreaming }: StreamBufferProps) {
  if (!content && !isStreaming) return null;

  return (
    <div className={styles.streamBuffer}>
      <MarkdownRenderer content={content} isStreaming={isStreaming} />
    </div>
  );
}
