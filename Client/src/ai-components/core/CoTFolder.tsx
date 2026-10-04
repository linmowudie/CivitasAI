/**
 * Core.CoTFolder——思维链折叠区组件。
 * 从 MessageBubble 抽离。
 *
 * 职责：展示 Agent 推理过程（reasoning），支持展开/折叠。
 * 流式期间强制展开，流结束后默认折叠。
 */

import { useState, useEffect } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import styles from './CoTFolder.module.css';

interface CoTFolderProps {
  /** 推理内容 */
  reasoning: string;
  /** 是否正在流式输出 */
  isStreaming: boolean;
}

export function CoTFolder({ reasoning, isStreaming }: CoTFolderProps) {
  // 流式期间强制展开，结束后默认折叠
  const [open, setOpen] = useState(isStreaming);
  useEffect(() => { setOpen(isStreaming); }, [isStreaming]);

  if (!reasoning) return null;

  return (
    <div className={styles.wrapper}>
      <button
        className={styles.toggle}
        onClick={() => setOpen(o => !o)}
      >
        <Brain size={12} className={isStreaming ? styles.iconThinking : ''} />
        <span>{isStreaming ? '思考中…' : '思考过程'}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className={styles.body}>
          {reasoning}
        </div>
      )}
    </div>
  );
}
