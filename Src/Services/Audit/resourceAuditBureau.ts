/**
 * @module Audit/resourceAuditBureau
 * @description
 * 资源审计局主入口——Docs/06 §2。
 * 整合异常检测、冻结管理、巡检调度。
 * 职责：Token 异常检测 / 自动冻结 / 稽查分析 / 定期巡检 / 处罚执行。
 */

import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import {
  initPatrolScheduler, executePatrol, registerAgentSnapshot,
  type PatrolReport, type AgentConsumptionSnapshot, type PatrolConfig,
} from './patrolScheduler.js';
import {
  freezeAgent, unfreezeAgent, isFrozen, checkAutoUnfreeze,
  getAllFrozenAgents,
} from './freezeManager.js';
import {
  initAnomalyDetector, checkRollingWindow, checkDeviation, checkLoop,
  recordConsumption, getAlerts,
  type AnomalyAlert, type DetectorConfig,
} from './anomalyDetector.js';

// ── 稽查报告 ────────────────────────────────────────────────────────

export type AuditFinding = 'false_positive' | 'confirmed_anomaly' | 'attack';
export type AuditRecommendation = 'unfreeze' | 'confiscate' | 'destroy' | 'escalate';

export interface AuditReport {
  auditId: string;
  agentId: string;
  finding: AuditFinding;
  rootCause: string;
  evidence: string[];
  recommendation: AuditRecommendation;
  confiscateAmount?: number;
  createdAt: number;
}

// ── 内部状态 ────────────────────────────────────────────────────────

const auditReports: Map<string, AuditReport> = new Map();
let auditCounter = 0;

// ── 初始化 ──────────────────────────────────────────────────────────

export function initResourceAuditBureau(params: {
  detectorConfig?: Partial<DetectorConfig>;
  patrolConfig?: Partial<PatrolConfig>;
} = {}): void {
  initAnomalyDetector(params.detectorConfig);
  initPatrolScheduler(params.patrolConfig);
}

// ── 异常检测代理 ────────────────────────────────────────────────────

export function monitorAgent(agentId: string, tokens: number, outputFingerprint?: string): {
  rollingAlert: AnomalyAlert | null;
  deviationAlert: AnomalyAlert | null;
  loopAlert: AnomalyAlert | null;
  frozen: boolean;
} {
  // 记录消耗
  recordConsumption(agentId, tokens);

  // 三条规则检查
  const rolling = checkRollingWindow(agentId);
  const deviation = checkDeviation(agentId, tokens);
  const loop = outputFingerprint ? checkLoop(agentId, outputFingerprint) : ok(null);

  const rollingAlert = rolling.ok ? rolling.value : null;
  const deviationAlert = deviation.ok ? deviation.value : null;
  const loopAlert = loop.ok ? loop.value : null;

  // critical 告警 → 自动冻结
  const hasCritical = [rollingAlert, deviationAlert, loopAlert]
    .some(a => a?.level === 'critical');

  let frozen = false;
  if (hasCritical && !isFrozen(agentId)) {
    const freezeResult = freezeAgent(agentId, '异常检测自动冻结');
    frozen = freezeResult.ok;
  }

  return { rollingAlert, deviationAlert, loopAlert, frozen };
}

// ── 稽查 ────────────────────────────────────────────────────────────

/**
 * 对冻结 Agent 执行深度稽查。
 * Phase 0-2：基于告警类型判定；Phase 3 接 LLM 分析。
 */
export function investigate(agentId: string): Result<AuditReport> {
  const agentAlerts = getAlerts(agentId);
  if (agentAlerts.length === 0) {
    return err(`Agent ${agentId} 无告警记录`);
  }

  const criticalAlerts = agentAlerts.filter(a => a.level === 'critical');
  const loopAlerts = agentAlerts.filter(a => a.type === 'loop_detected');

  // 判定
  let finding: AuditFinding;
  let recommendation: AuditRecommendation;
  let rootCause: string;
  let confiscateAmount: number | undefined;

  if (loopAlerts.length >= 3) {
    // 多次循环检测 → 攻击嫌疑
    finding = 'attack';
    recommendation = 'destroy';
    rootCause = '疑似死循环/注入攻击：连续多轮输出高度重复';
  } else if (criticalAlerts.length >= 2) {
    // 多次 critical → 确认异常
    finding = 'confirmed_anomaly';
    recommendation = 'confiscate';
    rootCause = '多次 Token 消耗异常确认';
    confiscateAmount = criticalAlerts.reduce((sum, a) => sum + a.currentValue, 0) * 0.1;
  } else {
    // 单次 critical → 可能误报
    finding = 'false_positive';
    recommendation = 'unfreeze';
    rootCause = '单次异常告警，判定为误报';
  }

  const report: AuditReport = {
    auditId: `audit-${++auditCounter}`,
    agentId,
    finding,
    rootCause,
    evidence: agentAlerts.map(a => `[${a.level}] ${a.type}: ${a.detail}`),
    recommendation,
    confiscateAmount,
    createdAt: Date.now(),
  };

  auditReports.set(report.auditId, report);

  // 发布 AUDIT_COMPLETED 事件
  publish(createEvent({
    eventType: EventType.AUDIT_COMPLETED,
    source: 'Audit/resourceAuditBureau',
    payload: {
      auditId: report.auditId,
      agentId,
      finding,
      recommendation,
    },
  }));

  // 执行建议
  if (recommendation === 'unfreeze' && isFrozen(agentId)) {
    unfreezeAgent(agentId, 'audit_investigation');
  }

  return ok(report);
}

// ── 巡检代理 ────────────────────────────────────────────────────────

export function runPatrol(): Result<PatrolReport> {
  return executePatrol();
}

export function addAgentSnapshot(snapshot: AgentConsumptionSnapshot): void {
  registerAgentSnapshot(snapshot);
}

// ── 冻结管理代理 ────────────────────────────────────────────────────

export function freeze(agentId: string, reason: string) {
  return freezeAgent(agentId, reason);
}

export function unfreeze(agentId: string, by?: string) {
  return unfreezeAgent(agentId, by);
}

export function checkExpired(): string[] {
  return checkAutoUnfreeze();
}

export function getFrozenAgents(): string[] {
  return getAllFrozenAgents();
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getAuditReports(): AuditReport[] {
  return [...auditReports.values()];
}

export function getAuditReport(auditId: string): AuditReport | undefined {
  return auditReports.get(auditId);
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetResourceAuditBureau(): void {
  auditReports.clear();
  auditCounter = 0;
}
