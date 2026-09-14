/**
 * AlertList — 系统告警列表。
 * 回答的问题：当前系统存在哪些异常需要关注？Critical 级别告警需要立即处理。
 *
 * 数据源：hooks/useAlerts（五条规则计算）
 * 无告警时显示"系统正常"。
 */
import { AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { useAlerts, type Alert, type AlertSeverity } from '@/hooks/useAlerts';

interface AlertListProps {
  question?: string;
}

const SEVERITY_CONFIG: Record<AlertSeverity, { icon: typeof AlertTriangle; color: string; bg: string }> = {
  CRITICAL: { icon: AlertTriangle, color: 'text-danger', bg: 'bg-danger/15' },
  WARNING: { icon: AlertTriangle, color: 'text-warning', bg: 'bg-warning/15' },
  INFO: { icon: Info, color: 'text-info', bg: 'bg-info/15' },
};

export default function AlertList({ question = '当前系统存在哪些异常需要关注？Critical 级别告警需要立即处理。' }: AlertListProps) {
  const alerts = useAlerts();

  const criticalCount = alerts.filter(a => a.severity === 'CRITICAL').length;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">系统告警</h3>
          <p className="text-[10px] text-text-muted italic">「{question}」</p>
        </div>
        {criticalCount > 0 && (
          <span className="badge badge-danger">
            <AlertTriangle size={10} />
            {criticalCount} 严重
          </span>
        )}
      </div>

      {alerts.length === 0 ? (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-success/10">
          <CheckCircle size={20} className="text-success" />
          <div>
            <p className="text-sm text-text-primary font-medium">系统运行正常</p>
            <p className="text-[10px] text-text-muted">暂无告警</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map(alert => {
            const config = SEVERITY_CONFIG[alert.severity];
            const Icon = config.icon;

            return (
              <div
                key={alert.id}
                className={`flex items-start gap-3 p-3 rounded-lg ${config.bg}`}
              >
                <Icon size={16} className={`${config.color} shrink-0 mt-0.5`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`text-xs font-semibold ${config.color}`}>
                      {alert.rule}
                    </span>
                    <span className="badge text-[9px]">{alert.severity}</span>
                  </div>
                  <p className="text-[11px] text-text-secondary">{alert.message}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 规则说明 */}
      <div className="mt-4 pt-3 border-t border-surface-700">
        <p className="text-[9px] text-text-muted">
          监控规则：Token 异常 · 队列积压 · 高失败率 · 仲裁积压 · 系统池不足
        </p>
      </div>
    </div>
  );
}
