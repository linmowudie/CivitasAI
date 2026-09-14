/**
 * AgentTopologyGraph — Agent 力导向拓扑图。
 * 回答的问题：当前有哪些 Agent 在线？它们之间如何通信？Director-Partner-Worker 分层关系如何？
 *
 * 数据源：agentStore.agents（6 态着色）+ WS 事件增量
 * 无数据时显示"暂无"而非空坐标系。
 */
import { useEffect, useMemo, useRef } from 'react';
import { useAgentStore, type AgentInfo } from '@/stores/agentStore';

interface AgentTopologyGraphProps {
  question?: string;
}

// Agent 6 态颜色
const STATUS_COLORS: Record<string, string> = {
  IDLE: '#6b7280',      // 灰
  WORKING: '#3b82f6',   // 蓝
  REVIEWING: '#f59e0b', // 橙
  BLOCKED: '#ef4444',   // 红
  COMPLETED: '#10b981', // 绿
  FAILED: '#dc2626',    // 深红
};

// 角色层级半径
const ROLE_RADIUS: Record<string, number> = {
  DIRECTOR: 0,     // 中心
  PARTNER: 80,     // 内环
  WORKER: 150,     // 外环
  VERIFIER: 120,   // 中环偏外
  ARBITRATOR: 100, // 中环
};

interface NodePosition {
  agentId: string;
  x: number;
  y: number;
  role: string;
  status: string;
}

export default function AgentTopologyGraph({ question = '当前有哪些 Agent 在线？它们之间如何通信？Director-Partner-Worker 分层关系如何？' }: AgentTopologyGraphProps) {
  const agents = useAgentStore(s => s.agents);
  const hydrate = useAgentStore(s => s.hydrate);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    hydrate();
  }, []);

  // 计算节点位置（简化力导向：按角色分层环形布局）
  const { nodes, hasData } = useMemo(() => {
    if (agents.length === 0) return { nodes: [], hasData: false };

    const centerX = 200;
    const centerY = 150;

    // 按角色分组
    const roleGroups = new Map<string, AgentInfo[]>();
    for (const agent of agents) {
      const role = agent.role.toUpperCase();
      if (!roleGroups.has(role)) roleGroups.set(role, []);
      roleGroups.get(role)!.push(agent);
    }

    const nodes: NodePosition[] = [];

    // 为每个角色组的 Agent 分配位置
    for (const [role, roleAgents] of roleGroups) {
      const radius = ROLE_RADIUS[role] ?? 130;
      const angleStep = (2 * Math.PI) / roleAgents.length;

      roleAgents.forEach((agent, i) => {
        const angle = angleStep * i - Math.PI / 2;
        nodes.push({
          agentId: agent.agentId,
          x: centerX + radius * Math.cos(angle),
          y: centerY + radius * Math.sin(angle),
          role: agent.role,
          status: agent.status,
        });
      });
    }

    return { nodes, hasData: true };
  }, [agents]);

  if (!hasData) {
    return (
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-1">Agent 拓扑</h3>
        <p className="text-[10px] text-text-muted mb-3 italic">「{question}」</p>
        <div className="flex items-center justify-center h-48 text-text-muted text-sm">
          暂无 Agent 数据
        </div>
      </div>
    );
  }

  const svgWidth = 400;
  const svgHeight = 300;

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-text-primary mb-1">Agent 拓扑</h3>
      <p className="text-[10px] text-text-muted mb-3 italic">「{question}」</p>
      <svg ref={svgRef} width={svgWidth} height={svgHeight} className="w-full h-auto">
        {/* 中心点（系统） */}
        <circle cx={200} cy={150} r={8} fill="#3b82f6" fillOpacity={0.3} />
        <text x={200} y={150} textAnchor="middle" dominantBaseline="middle" className="text-[8px] fill-brand-400">系统</text>

        {/* 环形参考线 */}
        {[80, 120, 150].map(r => (
          <circle key={r} cx={200} cy={150} r={r} fill="none" stroke="currentColor" strokeOpacity={0.1} strokeDasharray="2,4" />
        ))}

        {/* Agent 节点 */}
        {nodes.map(node => {
          const color = STATUS_COLORS[node.status.toUpperCase()] ?? STATUS_COLORS.IDLE;
          return (
            <g key={node.agentId}>
              {/* 光晕 */}
              <circle cx={node.x} cy={node.y} r={12} fill={color} fillOpacity={0.2} />
              {/* 节点 */}
              <circle cx={node.x} cy={node.y} r={6} fill={color} />
              {/* 标签 */}
              <text
                x={node.x}
                y={node.y + 18}
                textAnchor="middle"
                className="text-[8px] fill-text-muted"
              >
                {node.agentId.slice(0, 8)}
              </text>
              <text
                x={node.x}
                y={node.y + 28}
                textAnchor="middle"
                className="text-[7px] fill-text-muted"
              >
                {node.role}
              </text>
            </g>
          );
        })}
      </svg>

      {/* 图例 */}
      <div className="flex flex-wrap gap-3 mt-3 text-[10px] text-text-muted">
        {Object.entries(STATUS_COLORS).map(([status, color]) => (
          <span key={status} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
            {status}
          </span>
        ))}
      </div>

      {/* 统计 */}
      <div className="mt-2 text-[10px] text-text-muted font-mono">
        共 {agents.length} 个 Agent ·{' '}
        {agents.filter(a => a.status.toUpperCase() === 'WORKING').length} 个工作中
      </div>
    </div>
  );
}
