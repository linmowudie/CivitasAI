/**
 * 底部状态栏——系统状态 / 活跃 Agent / 税率。
 */
import { useSystemStore } from '@/stores/systemStore';
import { useTokenStore } from '@/stores/tokenStore';
import { Activity } from 'lucide-react';

export default function StatusBar() {
  const online = useSystemStore(s => s.online);
  const dashboard = useSystemStore(s => s.dashboard);
  const tokenOverview = useTokenStore(s => s.overview);

  return (
    <div className="h-6 flex items-center px-3 border-t border-surface-700 bg-surface-900 text-[10px] font-mono text-text-muted gap-4">
      <span className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-success animate-pulse-dot' : 'bg-danger'}`} />
        {online ? '系统运行中' : '离线'}
      </span>
      {dashboard && (
        <>
          <span className="flex items-center gap-1">
            <Activity size={10} />
            {dashboard.activeAgents} Agent 活跃
          </span>
          <span>事件 {dashboard.recentEvents}</span>
        </>
      )}
      {tokenOverview && (
        <span>税率 {(tokenOverview.currentTaxRate * 100).toFixed(1)}%</span>
      )}
    </div>
  );
}
