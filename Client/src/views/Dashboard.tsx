import { Cpu, Zap, Scale, Activity } from 'lucide-react';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useAlerts } from '@/hooks/useAlerts';
import TokenFlowSankey from '@/components/Dashboard/TokenFlowSankey';
import AgentTopologyGraph from '@/components/Dashboard/AgentTopologyGraph';
import TaskGanttChart from '@/components/Dashboard/TaskGanttChart';
import AlertList from '@/components/Dashboard/AlertList';

export default function Dashboard() {
  const { dashboard, agents, tasks, lastUpdated } = useDashboardData();
  const alerts = useAlerts();

  const activeAgents = dashboard?.activeAgents ?? 0;
  const totalAgents = dashboard?.totalAgents ?? 0;
  const activeCases = dashboard?.activeArbitrationCases ?? 0;
  const recentEvents = dashboard?.recentEvents ?? 0;
  const criticalAlerts = alerts.filter(a => a.severity === 'CRITICAL').length;

  return (
    <div className="p-6 space-y-5">
      {/* ─ 页头 ──────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">总控大屏</h1>
          <p className="text-xs text-text-muted mt-0.5 font-mono">Civitas-AI · 实时监控</p>
        </div>
        <div className="flex items-center gap-3">
          {/* 告警角标 */}
          {criticalAlerts > 0 && (
            <span className="badge badge-danger animate-pulse-dot">
              {criticalAlerts} 严重告警
            </span>
          )}
          <span className="badge badge-brand">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-dot" />
            LIVE
          </span>
          <span className="text-xs text-text-muted font-mono">
            {lastUpdated > 0 ? `更新于 ${new Date(lastUpdated).toLocaleTimeString('zh-CN')}` : '加载中…'}
          </span>
        </div>
      </div>

      {/* ── 核心指标卡片 ──────────────────────────────── */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard icon={Cpu} label="在线 Agent" value={activeAgents} sub={totalAgents > 0 ? `共 ${totalAgents}` : undefined} />
        <StatCard icon={Activity} label="任务总数" value={tasks.length} />
        <StatCard icon={Zap} label="事件总数" value={recentEvents} />
        <StatCard icon={Scale} label="仲裁案件" value={activeCases} sub={activeCases > 0 ? `进行中` : undefined} />
      </div>

      {/* ── 可视化图表区 ──────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4">
        {/* 左上：Token 流向桑基图 */}
        <TokenFlowSankey />

        {/* 右上：Agent 拓扑图 */}
        <AgentTopologyGraph />
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* 左下：任务甘特图 */}
        <TaskGanttChart />

        {/* 右下：告警列表 */}
        <AlertList />
      </div>

      {/* ── 空状态提示 ──────────────────────────────── */}
      {totalAgents === 0 && tasks.length === 0 && (
        <div className="card text-center py-8">
          <Activity size={32} className="mx-auto text-text-muted mb-3" />
          <p className="text-sm text-text-secondary">暂无活跃数据</p>
          <p className="text-xs text-text-muted mt-1">提交任务后，大屏将实时展示 Agent 状态与 Token 流向</p>
        </div>
      )}
    </div>
  );
}

/* ── 统计卡片组件 ─────────────────────────────────────── */
function StatCard({ icon: Icon, label, value, sub }: {
  icon: typeof Cpu; label: string; value: number | string; sub?: string;
}) {
  return (
    <div className="card card-glow group hover:border-brand-600/30 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <div className="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center group-hover:bg-brand-600/20 transition-colors">
          <Icon size={16} className="text-brand-400" />
        </div>
      </div>
      <div className="stat-value text-text-primary">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="text-[10px] text-text-muted mt-1 font-mono">{sub}</div>}
    </div>
  );
}
