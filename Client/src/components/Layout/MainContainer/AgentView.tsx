/**
 * AgentView —— L1 Agent 对话视图。
 * 设计规格：§4.2.4
 */
import { useUIStore } from '@/stores/uiStore';
import { useAgentStore } from '@/stores/agentStore';
import { Cpu } from 'lucide-react';

export default function AgentView() {
  const mainView = useUIStore((s) => s.mainView);
  const agents = useAgentStore((s) => s.agents);

  if (mainView.type !== 'agent') return null;

  const agent = agents.find(a => a.agentId === mainView.id);

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Agent 信息卡 */}
      <div className="p-4 rounded-lg border border-surface-700 bg-surface-800">
        <div className="flex items-center gap-2 mb-2">
          <Cpu size={14} className="text-brand-400" />
          <span className="text-sm font-semibold text-text-primary">{mainView.id}</span>
        </div>
        {agent && (
          <div className="grid grid-cols-2 gap-2 text-[11px] text-text-secondary">
            <div>角色: {agent.role}</div>
            <div>状态: {agent.status}</div>
            <div>信任等级: {agent.trustLevel}</div>
            {agent.model && <div>模型: {agent.model}</div>}
          </div>
        )}
        <div className="mt-2 text-[11px] text-text-muted">L1 Agent 对话视图</div>
      </div>

      {/* 对话区域占位 */}
      <div className="flex-1 p-4 rounded-lg border border-dashed border-surface-700 flex items-center justify-center">
        <div className="text-[11px] text-text-muted text-center">
          <div>Agent 对话区域</div>
          <div className="mt-1">待集成 AIEventBus + Subscribe 事件驱动渲染</div>
        </div>
      </div>
    </div>
  );
}
