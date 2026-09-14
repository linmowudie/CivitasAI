/**
 * @module Arbitration/restorationManager
 * @description
 * 恢复管理器——Docs/05 §5 现场恢复。
 * 指定恢复者 → 执行补偿动作 → 二次广播 RESTORATION_ACK。
 * 两种策略：self_healing（失败方自愈）/ global_takeover（全局接管）。
 */

import type { RestorationPlan, CompensatingAction } from './types.js';
import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 内部状态 ────────────────────────────────────────────────────────

const plans: Map<string, RestorationPlan> = new Map();
let planCounter = 0;

// ── 创建恢复计划 ────────────────────────────────────────────────────

export function createPlan(params: {
  caseId: string;
  conflictId: string;
  restorerAgentId: string;
  strategy: 'self_healing' | 'global_takeover';
  compensatingActions?: CompensatingAction[];
}): Result<RestorationPlan> {
  const plan: RestorationPlan = {
    planId: `restore-${++planCounter}`,
    caseId: params.caseId,
    conflictId: params.conflictId,
    restorerAgentId: params.restorerAgentId,
    strategy: params.strategy,
    compensatingActions: params.compensatingActions ?? [],
    status: 'pending',
    createdAt: Date.now(),
  };

  plans.set(plan.planId, plan);
  return ok(plan);
}

// ── 添加补偿动作 ────────────────────────────────────────────────────

export function addCompensatingAction(planId: string, action: CompensatingAction): Result<void> {
  const plan = plans.get(planId);
  if (!plan) return err(`恢复计划 ${planId} 不存在`);

  plan.compensatingActions.push(action);
  return ok(undefined);
}

// ── 执行恢复 ────────────────────────────────────────────────────────

/**
 * 执行恢复计划中的所有补偿动作。
 * Phase 0-2：标记执行状态；Phase 3 实际执行回滚。
 */
export function executePlan(planId: string): Result<{
  executed: number;
  failed: number;
}> {
  const plan = plans.get(planId);
  if (!plan) return err(`恢复计划 ${planId} 不存在`);
  if (plan.status === 'completed') return err(`恢复计划 ${planId} 已完成`);

  plan.status = 'executing';
  let executed = 0;
  let failed = 0;

  for (const action of plan.compensatingActions) {
    if (!action.executed) {
      // Phase 0-2：直接标记为已执行
      action.executed = true;
      executed++;
    }
  }

  plan.status = failed > 0 ? 'failed' : 'completed';
  plan.completedAt = Date.now();

  // 二次广播 RESTORATION_ACK
  publish(createEvent({
    eventType: EventType.RESTORATION_ACK,
    source: 'Arbitration/restorationManager',
    payload: {
      planId,
      caseId: plan.caseId,
      conflictId: plan.conflictId,
      restorerAgentId: plan.restorerAgentId,
      compensationActions: plan.compensatingActions,
      restoredAt: plan.completedAt,
    },
  }));

  return ok({ executed, failed });
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getPlan(planId: string): RestorationPlan | undefined {
  const p = plans.get(planId);
  return p ? { ...p } : undefined;
}

export function getPlansByCase(caseId: string): RestorationPlan[] {
  return [...plans.values()].filter(p => p.caseId === caseId).map(p => ({ ...p }));
}

export function getAllPlans(): RestorationPlan[] {
  return [...plans.values()].map(p => ({ ...p }));
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetRestorationManager(): void {
  plans.clear();
  planCounter = 0;
}
