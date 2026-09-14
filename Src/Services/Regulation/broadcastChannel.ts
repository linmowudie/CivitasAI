/**
 * @module Regulation/broadcastChannel
 * @description
 * 广播通道——Docs/06 §1.4。
 * 管理全局广播消息：规则更新 / 紧急警报 / 系统通知 / 仲裁死锁。
 */

import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 类型定义 ────────────────────────────────────────────────────────

export type BroadcastType = 'rule_update' | 'emergency_alert' | 'system_notice' | 'arbitration_deadlock';
export type BroadcastPriority = 'normal' | 'high' | 'critical';
export type TargetScope = 'all' | 'specific_agents' | 'specific_role';

export interface BroadcastMessage {
  broadcastId: string;
  type: BroadcastType;
  priority: BroadcastPriority;
  title: string;
  content: string;
  targetScope: TargetScope;
  targetAgentIds?: string[];
  targetRole?: string;
  requiresAck: boolean;
  ackDeadline?: number;
  publishedAt: number;
  publishedBy: 'regulatory_authority';
  acks: Map<string, number>;  // agentId → ackTime
}

// ── 内部状态 ────────────────────────────────────────────────────────

const messages: Map<string, BroadcastMessage> = new Map();
let broadcastCounter = 0;

// ── 发布广播 ────────────────────────────────────────────────────────

export function broadcast(params: {
  type: BroadcastType;
  priority?: BroadcastPriority;
  title: string;
  content: string;
  targetScope?: TargetScope;
  targetAgentIds?: string[];
  targetRole?: string;
  requiresAck?: boolean;
  ackDeadlineMs?: number;
}): Result<BroadcastMessage> {
  const now = Date.now();
  const msg: BroadcastMessage = {
    broadcastId: `broadcast-${++broadcastCounter}`,
    type: params.type,
    priority: params.priority ?? 'normal',
    title: params.title,
    content: params.content,
    targetScope: params.targetScope ?? 'all',
    targetAgentIds: params.targetAgentIds,
    targetRole: params.targetRole,
    requiresAck: params.requiresAck ?? false,
    ackDeadline: params.ackDeadlineMs ? now + params.ackDeadlineMs : undefined,
    publishedAt: now,
    publishedBy: 'regulatory_authority',
    acks: new Map(),
  };

  messages.set(msg.broadcastId, msg);

  // 通过 EventBus 广播
  publish(createEvent({
    eventType: EventType.BROADCAST_MESSAGE,
    source: 'Regulation/broadcastChannel',
    priority: msg.priority === 'critical' ? 'critical' : msg.priority === 'high' ? 'high' : 'normal',
    payload: {
      broadcastId: msg.broadcastId,
      type: msg.type,
      title: msg.title,
      content: msg.content,
      targetScope: msg.targetScope,
      targetAgentIds: msg.targetAgentIds,
      targetRole: msg.targetRole,
      requiresAck: msg.requiresAck,
    },
  }));

  return ok(msg);
}

// ── 确认收到 ────────────────────────────────────────────────────────

export function acknowledge(broadcastId: string, agentId: string): Result<void> {
  const msg = messages.get(broadcastId);
  if (!msg) return err(`广播 ${broadcastId} 不存在`);

  msg.acks.set(agentId, Date.now());
  return ok(undefined);
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getBroadcast(broadcastId: string): BroadcastMessage | undefined {
  const msg = messages.get(broadcastId);
  if (!msg) return undefined;
  return { ...msg, acks: new Map(msg.acks) };
}

export function getBroadcasts(type?: BroadcastType): BroadcastMessage[] {
  const all = [...messages.values()];
  const filtered = type ? all.filter(m => m.type === type) : all;
  return filtered.map(m => ({ ...m, acks: new Map(m.acks) }));
}

export function getUnacknowledged(agentId: string): BroadcastMessage[] {
  const now = Date.now();
  return [...messages.values()]
    .filter(m => m.requiresAck && !m.acks.has(agentId))
    .filter(m => !m.ackDeadline || m.ackDeadline > now)
    .map(m => ({ ...m, acks: new Map(m.acks) }));
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetBroadcastChannel(): void {
  messages.clear();
  broadcastCounter = 0;
}
