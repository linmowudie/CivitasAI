/**
 * useAlerts — 五条前端告警规则（Docs/09 §6.3）。
 *
 * 规则：
 * 1. Token 异常：单 Agent 消耗 > 平均 3 倍
 * 2. 队列积压：待处理任务 > 10
 * 3. 高失败率：最近 10 任务失败率 > 50%
 * 4. 仲裁积压：进行中仲裁案件 > 3
 * 5. 系统池不足：系统池 < 初始供应 10%
 */
import { useMemo } from 'react';
import { useTokenStore } from '@/stores/tokenStore';
import { useTaskStore } from '@/stores/taskStore';
import { useSystemStore } from '@/stores/systemStore';

export type AlertSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface Alert {
  id: string;
  rule: string;
  severity: AlertSeverity;
  message: string;
  timestamp: number;
}

const INITIAL_SUPPLY = 10000; // 与后端配置对齐（Configs/economyRules.json）
const SYSTEM_POOL_THRESHOLD = 0.1; // 10%
const QUEUE_BACKLOG_THRESHOLD = 10;
const FAILURE_RATE_THRESHOLD = 0.5;
const ARBITRATION_BACKLOG_THRESHOLD = 3;
const TOKEN_ANOMALY_MULTIPLIER = 3;

export function useAlerts(): Alert[] {
  const overview = useTokenStore(s => s.overview);
  const tasks = useTaskStore(s => s.tasks);
  const dashboard = useSystemStore(s => s.dashboard);

  return useMemo(() => {
    const alerts: Alert[] = [];
    const now = Date.now();

    // 规则 5：系统池不足
    if (overview && overview.systemPool < INITIAL_SUPPLY * SYSTEM_POOL_THRESHOLD) {
      alerts.push({
        id: 'rule-system-pool',
        rule: '系统池不足',
        severity: 'CRITICAL',
        message: `系统池 ${overview.systemPool} < 阈值 ${INITIAL_SUPPLY * SYSTEM_POOL_THRESHOLD}`,
        timestamp: now,
      });
    }

    // 规则 2：队列积压
    const pendingTasks = tasks.filter(t => t.status === 'submitted' || t.status === 'running');
    if (pendingTasks.length > QUEUE_BACKLOG_THRESHOLD) {
      alerts.push({
        id: 'rule-queue-backlog',
        rule: '队列积压',
        severity: 'WARNING',
        message: `${pendingTasks.length} 个任务待处理（阈值 ${QUEUE_BACKLOG_THRESHOLD}）`,
        timestamp: now,
      });
    }

    // 规则 3：高失败率（最近 10 个已完成任务）
    const completedTasks = tasks.filter(t => t.status === 'completed' || t.status === 'failed').slice(-10);
    if (completedTasks.length >= 5) {
      const failedCount = completedTasks.filter(t => t.status === 'failed').length;
      const failureRate = failedCount / completedTasks.length;
      if (failureRate > FAILURE_RATE_THRESHOLD) {
        alerts.push({
          id: 'rule-high-failure',
          rule: '高失败率',
          severity: 'WARNING',
          message: `最近 ${completedTasks.length} 任务失败率 ${(failureRate * 100).toFixed(0)}%（阈值 ${FAILURE_RATE_THRESHOLD * 100}%）`,
          timestamp: now,
        });
      }
    }

    // 规则 4：仲裁积压
    if (dashboard && dashboard.activeArbitrationCases > ARBITRATION_BACKLOG_THRESHOLD) {
      alerts.push({
        id: 'rule-arbitration-backlog',
        rule: '仲裁积压',
        severity: 'WARNING',
        message: `${dashboard.activeArbitrationCases} 个仲裁案件进行中（阈值 ${ARBITRATION_BACKLOG_THRESHOLD}）`,
        timestamp: now,
      });
    }

    // 规则 1：Token 异常（简化版——无 Agent 级别消耗数据时跳过）
    // 实际实现需要后端提供 Agent 级别消耗统计，此处预留接口
    if (overview && overview.walletCount > 0) {
      // TODO: 当后端提供 Agent 级别消耗统计时实现
      // 当前仅检查系统池是否异常低
    }

    return alerts;
  }, [overview, tasks, dashboard]);
}
