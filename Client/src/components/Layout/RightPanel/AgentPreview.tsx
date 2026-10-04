/**
 * AgentPreview —— L1 Agent 列表预览。
 * 设计规格：§5.1
 *
 * 点击 Agent 项 → setMainView({ type: 'agent', id: agentId })
 */
import { useEffect } from 'react';
import { useAgentStore } from '@/stores/agentStore';
import { useUIStore } from '@/stores/uiStore';
import { Cpu } from 'lucide-react';

const statusDot: Record<string, string> = {
  creating: '#8b5cf6', ready: '#10b981', running: '#3b82f6',
  suspended: '#f59e0b', expelled: '#ef4444', destroyed: '#6b7280',
};

export default function AgentPreview() {
  const { agents, loading, hydrate } = useAgentStore();
  const { setMainView, mainView } = useUIStore();

  useEffect(() => { hydrate(); }, []);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1">
      <div className="px-2 py-1 text-[10px] font-semibold text-text-muted uppercase tracking-wider">
        L1 Agent 列表
      </div>
      {loading && agents.length === 0 && (
        <div className="px-2 py-3 text-[11px] text-text-muted text-center">加载中...</div>
      )}
      {agents.length === 0 && !loading && (
        <div className="px-2 py-3 text-[11px] text-text-muted text-center">暂无 Agent</div>
      )}
      {agents.map((a) => {
        const isActive = mainView.type === 'agent' && mainView.id === a.agentId;
        return (
          <button
            key={a.agentId}
            className={`
              w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors
              ${isActive ? 'bg-brand-500/10 text-brand-400' : 'text-text-secondary hover:bg-surface-700/50'}
            `}
            onClick={() => setMainView({ type: 'agent', id: a.agentId })}
          >
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: statusDot[a.status] ?? '#6b7280' }}
            />
            <Cpu size={11} className="flex-shrink-0 text-text-muted" />
            <span className="flex-1 text-[11px] truncate">{a.agentId.slice(0, 20)}</span>
            <span className="text-[9px] text-text-muted">{a.role}</span>
          </button>
        );
      })}
    </div>
  );
}
