/**
 * AgentPreparing——Agent 准备态指示器。
 *
 * 场景：用户消息发出后，前端会先插入一条空的 assistant 占位消息
 * （status: streaming/queued，content/reasoning/toolCalls 均为空）。
 * 这段"模型尚未产出任何内容"的窗口内不应渲染空的 Agent 对话容器，
 * 而应展示本准备态（旋转动画 + 文案）。
 *
 * variant：
 *  - block ：尚无任何可见子容器时独立呈现（取代对话容器）
 *  - inline：已有可见子容器时，作为容器内的最后一行
 *
 * prefers-reduced-motion 下 animate-spin 被禁用（见 index.css），
 * 此时保留环形与文案，状态依然可读。
 */

interface AgentPreparingProps {
  variant?: 'block' | 'inline';
  /** 当前模型（可选展示） */
  model?: string;
}

export default function AgentPreparing({ variant = 'block', model }: AgentPreparingProps) {
  const spinner = (
    <span
      aria-hidden="true"
      className="w-3.5 h-3.5 flex-shrink-0 rounded-full border-2 border-surface-600 border-t-brand-500 animate-spin"
    />
  );

  const label = (
    <>
      <span>Agent 正在准备…</span>
      {model && <span className="font-mono text-[10px] text-text-muted">{model}</span>}
    </>
  );

  if (variant === 'inline') {
    return (
      <div
        data-testid="agent-preparing"
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 px-3 py-2 text-xs text-text-muted"
      >
        {spinner}
        {label}
      </div>
    );
  }

  return (
    <div
      data-testid="agent-preparing"
      role="status"
      aria-live="polite"
      className="flex items-center gap-2.5 px-4 py-3 rounded-lg border border-surface-700 bg-surface-800/60 text-xs text-text-secondary"
    >
      {spinner}
      {label}
    </div>
  );
}
