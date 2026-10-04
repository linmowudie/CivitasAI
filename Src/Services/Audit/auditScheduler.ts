/**
 * @module Audit/auditScheduler
 * @description
 * 审计周期接线（FE-061 实装）——把审计域四件接入运行期：
 *  ① 快照刷新：从经济记账（`consumptionRecorder`）与 Agent 注册表聚合真实消耗/失败数据
 *     （此前 `patrolScheduler.agentSnapshots` 无生产注入方，巡检无数据可审）；
 *  ② 滚动窗口异常检查（`anomalyDetector.checkRollingWindow`）；
 *  ③ 全量巡检（`patrolScheduler.executePatrol` → PATROL_REPORT）；
 *  ④ 冻结到期自动解冻（`freezeManager.checkAutoUnfreeze`）。
 *
 * 周期任务模式与 FE-049（仲裁池）/ FE-065（税率）一致：main.ts 启动、shutdown 对称停止。
 */

import { logger } from '../../Infra/Logging/logger.js';
import { getAllAgents } from '../../Core/AgentRuntime/agentRegistry.js';
import { getConsumptionRecords } from '../TokenEconomy/consumptionRecorder.js';
import {
  registerAgentSnapshot, executePatrol, getLatestReport,
  type PatrolReport,
} from './patrolScheduler.js';
import { checkAutoUnfreeze } from './freezeManager.js';
import { checkRollingWindow } from './anomalyDetector.js';

// ── 快照刷新（真实数据源接线）───────────────────────────────────────

/**
 * 从经济记账 + Agent 注册表刷新巡检快照。
 * @returns 刷新的 Agent 数
 */
export function refreshAgentSnapshots(): number {
  const records = getConsumptionRecords();
  const agents = getAllAgents();

  // 按 agentId 聚合消耗
  const byAgent = new Map<string, { tokens: number; requests: number; lastAt: number }>();
  for (const r of records) {
    const cur = byAgent.get(r.agentId) ?? { tokens: 0, requests: 0, lastAt: 0 };
    cur.tokens += r.totalTokens;
    cur.requests += 1;
    cur.lastAt = Math.max(cur.lastAt, r.completedAt);
    byAgent.set(r.agentId, cur);
  }

  let count = 0;
  for (const agent of agents) {
    const agg = byAgent.get(agent.agentId);
    registerAgentSnapshot({
      agentId: agent.agentId,
      totalConsumption: agg?.tokens ?? 0,
      failureCount: agent.consecutiveFailures ?? 0,
      totalRequests: Math.max(agg?.requests ?? 0, 1), // 避免除零（有 Agent 即计 1 次基线请求）
      lastActiveAt: agg?.lastAt ?? agent.updatedAt ?? Date.now(),
    });
    count++;
  }
  return count;
}

// ── 单次审计周期 ────────────────────────────────────────────────────

export interface AuditCycleResult {
  snapshots: number;
  expiredFreezes: string[];
  patrol?: PatrolReport;
}

/**
 * 执行一次完整审计周期（可测试直接调用）。
 * 顺序：刷新快照 → 滚动窗口检查 → 巡检 → 自动解冻（全链 fail-soft）。
 */
export function runAuditCycle(): AuditCycleResult {
  const snapshots = refreshAgentSnapshots();

  // 滚动窗口异常检查（逐 Agent；告警由 anomalyDetector 内部记录/发布）
  for (const agent of getAllAgents()) {
    try {
      checkRollingWindow(agent.agentId);
    } catch {
      /* fail-soft */
    }
  }

  let patrol: PatrolReport | undefined;
  const patrolResult = executePatrol();
  if (patrolResult.ok) {
    patrol = patrolResult.value;
  } else {
    logger.debug('巡检未产出报告', {
      source: 'Audit/auditScheduler',
      reason: patrolResult.error,
      snapshots,
    });
  }

  const expiredFreezes = checkAutoUnfreeze();
  if (expiredFreezes.length > 0) {
    logger.info('冻结到期自动解冻', {
      source: 'Audit/auditScheduler',
      agents: expiredFreezes,
    });
  }

  return { snapshots, expiredFreezes, patrol };
}

// ── 周期任务 ────────────────────────────────────────────────────────

let cycleTimer: ReturnType<typeof setInterval> | null = null;

/** 启动审计周期（main.ts 启动接线；间隔来自 Configs/audit.json → audit.patrolIntervalSec） */
export function startAuditCycle(intervalMs = 3600_000): void {
  stopAuditCycle();
  cycleTimer = setInterval(() => {
    try {
      runAuditCycle();
    } catch (e) {
      logger.warn('审计周期任务异常（已忽略）', {
        source: 'Audit/auditScheduler',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, intervalMs);
}

/** 停止审计周期（shutdown 对称调用） */
export function stopAuditCycle(): void {
  if (cycleTimer) {
    clearInterval(cycleTimer);
    cycleTimer = null;
  }
}

/** 最新巡检报告（REST 查询透传） */
export { getLatestReport };
