/**
 * StreamingIndicator——流式输出指示器。
 * F2.6：排队/生成中状态显示。
 */

interface StreamingIndicatorProps {
  status: 'queued' | 'streaming';
  model?: string;
}

export default function StreamingIndicator({ status, model }: StreamingIndicatorProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs text-text-muted">
      {status === 'queued' ? (
        <>
          <span className="w-2 h-2 rounded-full bg-text-muted animate-pulse" />
          <span>排队等待中…</span>
        </>
      ) : (
        <>
          <span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse-dot" />
          <span>正在生成</span>
          {model && <span className="font-mono text-[10px] text-text-muted">· {model}</span>}
          <span className="streaming-dots">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </span>
        </>
      )}
    </div>
  );
}
