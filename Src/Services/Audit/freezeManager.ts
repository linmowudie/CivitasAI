/**
 * @module Audit/freezeManager
 * @description
 * 冻结管理器——Docs/Agent/06 §2.4。
 * 对异常 Agent 执行钱包冻结/解冻。
 * 冻结通过 TokenEconomy 执行，WALLET_FROZEN 由 TokenEconomy 发布。
 */

import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { requireGovernanceRole } from '../Governance/governanceGuard.js';

// ── 冻结记录 ────────────────────────────────────────────────────────

export interface FreezeRecord {
  freezeId: string;
  agentId: string;
  reason: string;
  frozenAt: number;
  autoUnfreezeAt?: number;
  unfrozenAt?: number;
  unfrozenBy?: string;
  status: 'frozen' | 'unfrozen' | 'expired';
}

// ── 内部状态 ────────────────────────────────────────────────────────

const freezeRecords: Map<string, FreezeRecord> = new Map();
const frozenAgents: Set<string> = new Set();
let freezeCounter = 0;
let autoUnfreezeSec = 300; // 默认 5 分钟

// ── 配置 ────────────────────────────────────────────────────────────

export function setAutoUnfreezeSec(sec: number): void {
  autoUnfreezeSec = sec;
}

// ── 冻结 ────────────────────────────────────────────────────────────

/**
 * 冻结 Agent（**治理动作**：仅 L0 治理角色或人类所有者可执行）。
 *
 * @param actorRole 执行者角色；非治理角色一律拒绝（fail-closed）
 */
export function freezeAgent(agentId: string, reason: string, actorRole: string): Result<FreezeRecord> {
  const guard = requireGovernanceRole(actorRole, '冻结 Agent（审计执法）');
  if (!guard.ok) return err(guard.error);

  if (frozenAgents.has(agentId)) {
    return err(`Agent ${agentId} 已被冻结`);
  }

  const now = Date.now();
  const record: FreezeRecord = {
    freezeId: `freeze-${++freezeCounter}`,
    agentId,
    reason,
    frozenAt: now,
    autoUnfreezeAt: now + autoUnfreezeSec * 1000,
    status: 'frozen',
  };

  freezeRecords.set(record.freezeId, record);
  frozenAgents.add(agentId);

  // 发布 WALLET_FROZEN 事件（由审计局发起）
  publish(createEvent({
    eventType: EventType.WALLET_FROZEN,
    source: 'Audit/freezeManager',
    payload: {
      freezeId: record.freezeId,
      agentId,
      reason,
      initiator: 'AuditBureau',
      actedByRole: actorRole,
    },
  }));

  return ok(record);
}

// ── 解冻 ────────────────────────────────────────────────────────────

/**
 * 解冻 Agent（**治理动作**：仅 L0 治理角色或人类所有者可执行）。
 *
 * 注意：**系统到期自动解冻**不走此函数（见内部 `applyUnfreeze`）——
 * 自动解冻是"解除限制"的 fail-safe 行为，不是治理裁决。
 */
export function unfreezeAgent(agentId: string, by: string, actorRole: string): Result<void> {
  const guard = requireGovernanceRole(actorRole, '解冻 Agent（审计执法）');
  if (!guard.ok) return err(guard.error);
  return applyUnfreeze(agentId, by);
}

/** 内部解冻实现（不做角色校验；仅供治理入口与系统自动到期路径复用） */
function applyUnfreeze(agentId: string, by: string): Result<void> {
  if (!frozenAgents.has(agentId)) {
    return err(`Agent ${agentId} 未被冻结`);
  }

  frozenAgents.delete(agentId);

  // 更新记录
  for (const record of freezeRecords.values()) {
    if (record.agentId === agentId && record.status === 'frozen') {
      record.status = 'unfrozen';
      record.unfrozenAt = Date.now();
      record.unfrozenBy = by;
    }
  }

  // 发布 WALLET_UNFROZEN 事件
  publish(createEvent({
    eventType: EventType.WALLET_UNFROZEN,
    source: 'Audit/freezeManager',
    payload: {
      agentId,
      unfrozenBy: by,
    },
  }));

  return ok(undefined);
}

// ── 检查自动解冻 ────────────────────────────────────────────────────

export function checkAutoUnfreeze(): string[] {
  const now = Date.now();
  const expired: string[] = [];

  for (const record of freezeRecords.values()) {
    if (record.status === 'frozen' && record.autoUnfreezeAt && now >= record.autoUnfreezeAt) {
      record.status = 'expired';
      record.unfrozenAt = now;
      record.unfrozenBy = 'auto';
      frozenAgents.delete(record.agentId);
      expired.push(record.agentId);

      publish(createEvent({
        eventType: EventType.WALLET_UNFROZEN,
        source: 'Audit/freezeManager',
        payload: {
          agentId: record.agentId,
          unfrozenBy: 'auto',
          freezeId: record.freezeId,
        },
      }));
    }
  }

  return expired;
}

// ── 查询 ────────────────────────────────────────────────────────────

export function isFrozen(agentId: string): boolean {
  return frozenAgents.has(agentId);
}

export function getFreezeRecord(agentId: string): FreezeRecord | undefined {
  for (const r of freezeRecords.values()) {
    if (r.agentId === agentId && r.status === 'frozen') return { ...r };
  }
  return undefined;
}

export function getAllFrozenAgents(): string[] {
  return [...frozenAgents];
}

export function getFreezeHistory(): FreezeRecord[] {
  return [...freezeRecords.values()].map(r => ({ ...r }));
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetFreezeManager(): void {
  freezeRecords.clear();
  frozenAgents.clear();
  freezeCounter = 0;
  autoUnfreezeSec = 300;
}
