/**
 * @module Regulation/regulatoryAuthority
 * @description
 * 监管局主入口——Docs/06 §1。
 * 整合行为准则、广播通道、最终裁决、紧急干预。
 * 职责：全局规则维护 / 跨域协调 / 最终裁决 / 紧急干预。
 */

import {
  initBehaviorCode, getCurrentCode, getRules, checkViolation,
  addRule, removeRule, updateVersion,
  type BehaviorRule, type BehaviorCode,
} from './behaviorCode.js';
import {
  broadcast, acknowledge, getBroadcast, getBroadcasts, getUnacknowledged,
  type BroadcastMessage, type BroadcastType,
} from './broadcastChannel.js';
import {
  issueFinalVerdict, getIntervention, getInterventionsByCase, getAllInterventions,
  type RegulatoryIntervention,
} from './finalArbiter.js';
import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { ArbitrationCase } from '../Arbitration/types.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 紧急干预类型 ────────────────────────────────────────────────────

export type InterventionType = 'force_terminate' | 'pause_all' | 'force_restart' | 'rule_emergency';

export interface EmergencyRecord {
  emergencyId: string;
  type: InterventionType;
  reason: string;
  targetAgentIds?: string[];
  issuedAt: number;
  executed: boolean;
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

export function addBehaviorRule(rule: BehaviorRule) {
  return addRule(rule);
}

export function removeBehaviorRule(ruleId: string) {
  return removeRule(ruleId);
}

// ── 广播代理 ────────────────────────────────────────────────────────

export function broadcastMessage(params: {
  type: BroadcastType;
  title: string;
  content: string;
  priority?: 'normal' | 'high' | 'critical';
  targetAgentIds?: string[];
  requiresAck?: boolean;
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
export function escalateDeadlock(case_: ArbitrationCase, reason: 'deadlock' | 'timeout' | 'escalation') {
  return issueFinalVerdict({ case_, reason });
}

// ── 紧急干预 ────────────────────────────────────────────────────────

/**
 * 执行紧急干预。
 */
export function emergencyIntervene(params: {
  type: InterventionType;
  reason: string;
  targetAgentIds?: string[];
}): Result<EmergencyRecord> {
  const record: EmergencyRecord = {
    emergencyId: `emergency-${++emergencyCounter}`,
    type: params.type,
    reason: params.reason,
    targetAgentIds: params.targetAgentIds,
    issuedAt: Date.now(),
    executed: false,
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
