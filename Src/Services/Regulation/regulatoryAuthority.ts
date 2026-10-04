/**
 * @module Regulation/regulatoryAuthority
 * @description
 * 监管局主入口——Docs/Agent/06 §1。
 * 整合行为准则、广播通道、最终裁决、紧急干预。
 * 职责：全局规则维护 / 跨域协调 / 最终裁决 / 紧急干预。
 */

import { EventType } from '../EventBus/eventTypes.js';
import { requireGovernanceRole } from '../Governance/governanceGuard.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { ArbitrationCase } from '../Arbitration/types.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import {
  issueFinalVerdict, getAllInterventions,
} from './finalArbiter.js';
import {
  broadcast, acknowledge,
  type BroadcastType,
} from './broadcastChannel.js';
import {
  initBehaviorCode, getCurrentCode, getRules, checkViolation,
  addRule, removeRule,
  type BehaviorRule, type BehaviorCode,
} from './behaviorCode.js';

// ── 紧急干预类型 ────────────────────────────────────────────────────

export type InterventionType = 'force_terminate' | 'pause_all' | 'force_restart' | 'rule_emergency';

export interface EmergencyRecord {
  emergencyId: string;
  type: InterventionType;
  reason: string;
  targetAgentIds?: string[];
  issuedAt: number;
  executed: boolean;
  /** 执行者角色（2026-10-04 治理留痕） */
  actedByRole?: string;
}

// ── 内部状态 ────────────────────────────────────────────────────────

const emergencies: Map<string, EmergencyRecord> = new Map();
let emergencyCounter = 0;

// ── 初始化 ──────────────────────────────────────────────────────────

export function initRegulatoryAuthority(): void {
  initBehaviorCode();
}

// ── 行为准则代理 ────────────────────────────────────────────────────

export function getBehaviorCode(): BehaviorCode | null {
  return getCurrentCode();
}

export function getBehaviorRules(category?: string) {
  return getRules(category as any);
}

export function validateBehavior(params: { agentId: string; action: string; context?: Record<string, unknown> }) {
  return checkViolation(params);
}

// 守卫已下沉至 behaviorCode 本层（FE-043，单次留痕）；本层仅透传 actorRole。
export function addBehaviorRule(rule: BehaviorRule, actorRole: string) {
  return addRule(rule, actorRole);
}

export function removeBehaviorRule(ruleId: string, actorRole: string) {
  return removeRule(ruleId, actorRole);
}

// ── 广播代理 ────────────────────────────────────────────────────────

export function broadcastMessage(params: {
  type: BroadcastType;
  title: string;
  content: string;
  priority?: 'normal' | 'high' | 'critical';
  targetAgentIds?: string[];
  requiresAck?: boolean;
  /** 发布者角色（2026-10-04）：治理广播必须 L0 / user */
  actorRole: string;
}) {
  return broadcast(params);
}

export function ackBroadcast(broadcastId: string, agentId: string) {
  return acknowledge(broadcastId, agentId);
}

// ── 最终裁决代理 ────────────────────────────────────────────────────

/**
 * 接收仲裁庭死锁升级，执行最终裁决。
 */
export function escalateDeadlock(case_: ArbitrationCase, reason: 'deadlock' | 'timeout' | 'escalation', actorRole: string) {
  const guard = requireGovernanceRole(actorRole, '僵局升级（监管执法）');
  if (!guard.ok) return err(guard.error);
  return issueFinalVerdict({ case_, reason, actorRole });
}

// ── 紧急干预 ────────────────────────────────────────────────────────

/**
 * 执行紧急干预。
 */
export function emergencyIntervene(params: {
  type: InterventionType;
  reason: string;
  targetAgentIds?: string[];
  /** 执行者角色（2026-10-04）：裁量执法必须 L0（regulatory_authority）/ user */
  actorRole: string;
}): Result<EmergencyRecord> {
  const guard = requireGovernanceRole(params.actorRole, '紧急干预（监管执法）');
  if (!guard.ok) return err(guard.error);
  const record: EmergencyRecord = {
    emergencyId: `emergency-${++emergencyCounter}`,
    type: params.type,
    reason: params.reason,
    targetAgentIds: params.targetAgentIds,
    issuedAt: Date.now(),
    executed: false,
    actedByRole: params.actorRole,
  };

  // 发布紧急干预事件
  const eventResult = publish(createEvent({
    eventType: EventType.EMERGENCY_INTERVENTION,
    source: 'Regulation/regulatoryAuthority',
    priority: 'critical',
    payload: {
      emergencyId: record.emergencyId,
      type: params.type,
      reason: params.reason,
      targetAgentIds: params.targetAgentIds,
    },
  }));

  if (eventResult.ok) {
    record.executed = true;
  }

  emergencies.set(record.emergencyId, record);

  // 同时广播紧急警报
  broadcast({
    type: 'emergency_alert',
    priority: 'critical',
    title: `紧急干预：${params.type}`,
    content: params.reason,
    targetAgentIds: params.targetAgentIds,
    actorRole: params.actorRole,
  });

  return ok(record);
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getEmergencyRecords(): EmergencyRecord[] {
  return [...emergencies.values()];
}

export function getInterventions() {
  return getAllInterventions();
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetRegulatoryAuthority(): void {
  emergencies.clear();
  emergencyCounter = 0;
}
