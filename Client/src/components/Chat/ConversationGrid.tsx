/**
 * ConversationGrid — Agent 卡片横向排列区
 *
 * 展示当前对话下的所有 L1 级 Agent 卡片。
 * 卡片始终保持正方形（aspect-ratio: 1/1），横向排列并填充可用空间。
 * 点击卡片进入该 Agent 的聊天区域。
 */
import ConversationCard from './ConversationCard';
import type { AgentCard } from '@/stores/chatStore';

interface Props {
  agents: AgentCard[];
  activeAgentSessionId: string | null;
  onSelectAgent: (agentSessionId: string) => void;
}

export default function ConversationGrid({ agents, activeAgentSessionId, onSelectAgent }: Props) {
  if (agents.length === 0) {
    return (
      <div className="agent-grid-empty">
        <p>该对话下暂无 Agent</p>
      </div>
    );
  }

  return (
    <div className="agent-grid">
      {agents.map(agent => (
        <ConversationCard
          key={agent.session_id}
          agent={agent}
          isActive={agent.session_id === activeAgentSessionId}
          onClick={() => onSelectAgent(agent.session_id)}
        />
      ))}
    </div>
  );
}
