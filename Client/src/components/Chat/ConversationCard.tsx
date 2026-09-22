/**
 * ConversationCard — L1 Agent 正方形卡片
 *
 * 始终保持 aspect-ratio: 1/1，不随数量变化而变形。
 * 展示：工作方式徽章、Agent 标题、状态指示器、会话 ID、时间戳。
 * 点击后进入该 Agent 的聊天区域。
 */
import { Bot, Hash } from 'lucide-react';
import type { AgentCard as AgentCardType, WorkingMode } from '@/stores/chatStore';

/** 工作方式 → 颜色 / 标签映射（与 WorkingModes.tsx 保持一致） */
export const WORKING_MODE_META: Record<WorkingMode, { label: string; color: string }> = {
  DIRECT:        { label: '直接执行', color: '#22d3ee' },
  DELEGATION:    { label: '并行委派', color: '#8b5cf6' },
  ASSEMBLY_LINE: { label: 'SOP 流水线', color: '#06b6d4' },
  CONSORTIUM:    { label: '高难攻坚', color: '#f59e0b' },
  LITIGATION:    { label: '司法仲裁', color: '#ef4444' },
  REGULATION:    { label: '行政协调', color: '#3b82f6' },
  AUDIT:         { label: '资源稽查', color: '#10b981' },
};

const STATUS_DOT: Record<string, string> = {
  active:   'bg-agent-running animate-pulse-dot',
  archived: 'bg-agent-ready',
  closed:   'bg-agent-destroyed',
};

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

interface Props {
  agent: AgentCardType;
  isActive: boolean;
  onClick: () => void;
}

export default function ConversationCard({ agent, isActive, onClick }: Props) {
  const mode = agent.working_mode;
  const meta = WORKING_MODE_META[mode];

  return (
    <div
      className={`agent-card ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      {/* ── 顶部：工作方式 + 状态 ── */}
      <div className="agent-card-header">
        <span
          className="badge font-mono"
          style={{ background: `${meta.color}20`, color: meta.color }}
        >
          {meta.label}
        </span>
        <span className={`agent-status-dot ${STATUS_DOT[agent.status] ?? STATUS_DOT.active}`} />
      </div>

      {/* ── Agent 图标 ── */}
      <div className="agent-card-icon-wrap">
        <Bot size={28} className="agent-card-icon" />
      </div>

      {/* ── 标题 ── */}
      <div className="agent-card-title" title={agent.title}>
        {truncate(agent.title, 20)}
      </div>

      {/* ── 会话 ID ── */}
      <div className="agent-card-id">
        <Hash size={9} />
        <span>{truncate(agent.session_id, 12)}</span>
      </div>

      {/* ── 底部时间 ── */}
      <div className="agent-card-time">
        {new Date(agent.updated_at).toLocaleDateString('zh-CN', {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        })}
      </div>
    </div>
  );
}
