/**
 * @module Audit/patrolScheduler
 * @description
 * 巡检调度器——Docs/06 §2.5。
 * 定期全量审计所有 Agent 的 Token 使用。
 * 标记"需关注"Agent → 生成巡检报告 → 发布 PATROL_REPORT 事件。
 */

import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 类型定义 ────────────────────────────────────────────────────────

export interface PatrolReport {
  reportId: string;
  patrolId: string;
  startedAt: number;
  completedAt: number;
  totalAgents: number;
  flaggedAgents: FlaggedAgent[];
  summary: string;
}

export interface FlaggedAgent {
  agentId: string;
  reason: string;
  consumption: number;
  failureRate: number;
  severity: 'low' | 'medium' | 'high';
}

export interface AgentConsumptionSnapshot {
  agentId: string;
  totalConsumption: number;
  failureCount: number;
  totalRequests: number;
  lastActiveAt: number;
}

// ── 配置 ────────────────────────────────────────────────────────────

export interface PatrolConfig {
  intervalMs: number;            // 巡检间隔
  windowHours: number;           // 巡检窗口
  topPercentile: number;         // 消耗 Top N%
  failureRateThreshold: number;  // 失败率阈值
}

const DEFAULT_CONFIG: PatrolConfig = {
  intervalMs: 86400_000,  // 24 小时
  windowHours: 24,
  topPercentile: 0.1,
  failureRateThreshold: 0.3,
};

// ── 内部状态 ────────────────────────────────────────────────────────

let config: PatrolConfig = { ...DEFAULT_CONFIG };
const reports: Map<string, PatrolReport> = new Map();
let patrolCounter = 0;
let reportCounter = 0;
let timerHandle: ReturnType<typeof setInterval> | null = null;

// Agent 消耗数据源（由外部注入或手动录入）
const agentSnapshots: Map<string, AgentConsumptionSnapshot> = new Map();

// ── 初始化 ──────────────────────────────────────────────────────────

export function initPatrolScheduler(cfg: Partial<PatrolConfig> = {}): void {
  config = { ...DEFAULT_CONFIG, ...cfg };
}

// ── 注入 Agent 快照（测试/Phase 0-2）───────────────────────────────

export function registerAgentSnapshot(snapshot: AgentConsumptionSnapshot): void {
  agentSnapshots.set(snapshot.agentId, snapshot);
}

// ── 执行巡检 ────────────────────────────────────────────────────────

export function executePatrol(): Result<PatrolReport> {
  const patrolId = `patrol-${++patrolCounter}`;
  const now = Date.now();
  const snapshots = [...agentSnapshots.values()];

  if (snapshots.length === 0) {
    return err('无 Agent 快照数据');
  }

  const flaggedAgents: FlaggedAgent[] = [];

  // 按消耗排序，标记 Top N%
  const sorted = [...snapshots].sort((a, b) => b.totalConsumption - a.totalConsumption);
  const topCount = Math.max(1, Math.ceil(sorted.length * config.topPercentile));
  const topThreshold = sorted[topCount - 1]?.totalConsumption ?? 0;

  for (const snap of snapshots) {
    const failureRate = snap.totalRequests > 0
      ? snap.failureCount / snap.totalRequests
      : 0;

    const reasons: string[] = [];

    // 消耗 Top N%
    if (snap.totalConsumption >= topThreshold && snap.totalConsumption > 0) {
      reasons.push(`消耗 Top ${config.topPercentile * 100}%`);
    }

    // 失败率超阈值
    if (failureRate > config.failureRateThreshold) {
      reasons.push(`失败率 ${(failureRate * 100).toFixed(1)}% 超阈值`);
    }

    if (reasons.length > 0) {
      flaggedAgents.push({
        agentId: snap.agentId,
        reason: reasons.join('；'),
        consumption: snap.totalConsumption,
        failureRate,
        severity: failureRate > config.failureRateThreshold * 2 ? 'high'
          : failureRate > config.failureRateThreshold ? 'medium'
          : 'low',
      });
    }
  }

  const report: PatrolReport = {
    reportId: `report-${++reportCounter}`,
    patrolId,
    startedAt: now,
    completedAt: Date.now(),
    totalAgents: snapshots.length,
    flaggedAgents,
    summary: `巡检 ${snapshots.length} 个 Agent，标记 ${flaggedAgents.length} 个需关注`,
  };

  reports.set(report.reportId, report);

  // 发布 PATROL_REPORT 事件
  publish(createEvent({
    eventType: EventType.PATROL_REPORT,
    source: 'Audit/patrolScheduler',
    payload: {
      reportId: report.reportId,
      patrolId,
      totalAgents: report.totalAgents,
      flaggedCount: flaggedAgents.length,
      summary: report.summary,
    },
  }));

  return ok(report);
}

// ── 自动调度 ────────────────────────────────────────────────────────

export function startAutoPatrol(): void {
  stopAutoPatrol();
  timerHandle = setInterval(() => {
    executePatrol();
  }, config.intervalMs);
}

export function stopAutoPatrol(): void {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getReports(): PatrolReport[] {
  return [...reports.values()];
}

export function getLatestReport(): PatrolReport | undefined {
  const all = [...reports.values()];
  return all.length > 0 ? all[all.length - 1] : undefined;
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetPatrolScheduler(): void {
  stopAutoPatrol();
  reports.clear();
  agentSnapshots.clear();
  patrolCounter = 0;
  reportCounter = 0;
  config = { ...DEFAULT_CONFIG };
}
