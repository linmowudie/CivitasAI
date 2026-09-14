import { useState, useEffect } from 'react';
import { Search, Filter, Wallet, History, ChevronRight, Cpu } from 'lucide-react';
import { useAgentStore, type AgentInfo } from '@/stores/agentStore';

const statusColor: Record<string, string> = {
  creating: 'bg-agent-creating', ready: 'bg-agent-ready', running: 'bg-agent-running',
  suspended: 'bg-agent-suspended', expelled: 'bg-agent-expelled', destroyed: 'bg-agent-destroyed',
};

export default function AgentMonitor() {
  const { agents, hydrate } = useAgentStore();
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => { hydrate(); }, []);

  const agent = agents.find(a => a.agentId === selected) ?? agents[0];

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Agent 监控</h1>
          <p className="text-xs text-text-muted mt-0.5">6 态生命周期实时状态</p>
        </div>
        <div className="flex gap-2">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-800 border border-surface-700">
            <Search size={14} className="text-text-muted" />
            <input className="bg-transparent text-xs text-text-primary outline-none w-40 placeholder:text-text-muted" placeholder="搜索 Agent..." />
          </div>
          <button className="btn btn-ghost"><Filter size={14} />筛选</button>
        </div>
      </div>

      {agents.length === 0 ? (
        <div className="card text-center py-12">
          <Cpu size={32} className="mx-auto text-text-muted mb-3" />
          <p className="text-sm text-text-secondary">暂无 Agent</p>
          <p className="text-xs text-text-muted mt-1">提交任务后，系统将自动招募 Agent 执行</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {/* Agent 列表 */}
          <div className="col-span-2 card">
            <div className="grid grid-cols-[1fr_80px_80px_80px] gap-2 px-4 py-2 text-[10px] text-text-muted font-mono uppercase tracking-wider border-b border-surface-700">
              <span>Agent</span><span>状态</span><span>角色</span><span>信任级</span>
            </div>
            {agents.map(a => (
              <div
                key={a.agentId}
                onClick={() => setSelected(a.agentId)}
                className={`grid grid-cols-[1fr_80px_80px_80px] gap-2 px-4 py-3 cursor-pointer transition-colors ${selected === a.agentId ? 'bg-brand-600/10 border-l-2 border-brand-500' : 'hover:bg-surface-700/50 border-l-2 border-transparent'}`}
              >
                <div className="flex items-center gap-2.5">
                  <span className={`w-2 h-2 rounded-full ${statusColor[a.status] ?? 'bg-text-muted'} ${a.status === 'running' ? 'animate-pulse-dot' : ''}`} />
                  <div>
                    <div className="text-xs font-medium text-text-primary">{a.agentId}</div>
                    <div className="text-[10px] text-text-muted font-mono">{a.traceId.slice(0, 8)}</div>
                  </div>
                </div>
                <span className="badge text-[10px] w-fit self-center">{a.status}</span>
                <span className="text-[11px] text-text-secondary self-center font-mono">{a.role}</span>
                <span className="text-[11px] text-text-primary self-center font-mono">{a.trustLevel}</span>
              </div>
            ))}
          </div>

          {/* 详情面板 */}
          {agent && (
            <div className="card space-y-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${statusColor[agent.status] ?? 'bg-surface-700'}`}>
                  <span className={`w-3 h-3 rounded-full ${statusColor[agent.status] ?? 'bg-text-muted'}`} />
                </div>
                <div>
                  <div className="text-sm font-bold text-text-primary">{agent.agentId}</div>
                  <div className="text-[10px] text-text-muted font-mono">{agent.traceId}</div>
                </div>
              </div>

              <div className="data-flow-line" />

              {/* 生命周期状态机 */}
              <div>
                <div className="text-[10px] text-text-muted mb-2 uppercase tracking-wider">生命周期</div>
                <div className="flex items-center gap-1 flex-wrap">
                  {['creating', 'ready', 'running', 'suspended', 'expelled', 'destroyed'].map(s => (
                    <span key={s} className={`px-2 py-0.5 rounded text-[10px] font-mono ${agent.status === s ? `${statusColor[s]} text-white` : 'bg-surface-700 text-text-muted'}`}>
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
