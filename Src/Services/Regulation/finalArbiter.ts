/**
 * @module Regulation/finalArbiter
 * @description
 * 最终裁决器——Docs/06 §1.5。
 * 仲裁庭死锁时，作为最终裁决方介入。
 * 降级为单 LLM 强制裁决（不再要求多数决）。
 * Phase 0-2：规则强制裁决；Phase 3 接高能力模型。
 */

import type { ArbitrationCase, FinalVerdict, VerdictType } from '../Arbitration/types.js';
import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 内部状态 ────────────────────────────────────────────────────────

const interventions: Map<string, RegulatoryIntervention> = new Map();
let interventionCounter = 0;

export interface RegulatoryIntervention {
  interventionId: string;
  caseId: string;
  conflictId: string;
  reason: 'deadlock' | 'timeout' | 'escalation';
  verdict: FinalVerdict;
  issuedAt: number;
  modelUsed: string;  // Phase 0-2: 'rule-based'; Phase 3: model name
}

// ── 最终裁决 ────────────────────────────────────────────────────────

/**
 * 对死锁案件执行最终裁决。
 * 降级为单 LLM 强制裁决，裁决标记为 "regulatory_intervention"。
 */
export function issueFinalVerdict(params: {
  case_: ArbitrationCase;
  reason: 'deadlock' | 'timeout' | 'escalation';
  overrideVerdict?: VerdictType;
}): Result<RegulatoryIntervention> {
  const c = params.case_;
  if (c.status !== 'deadlocked' && c.status !== 'reasoning') {
    return err(`案件 ${c.caseId} 状态为 ${c.status}，不可执行最终裁决`);
  }

  const now = Date.now();

  // Phase 0-2：规则强制裁决（新记忆胜）
  const verdict: VerdictType = params.overrideVerdict ?? 'new_wins';

  const finalVerdict: FinalVerdict = {
    caseId: c.caseId,
    conflictId: c.conflictId,
    verdict,
    winnerId: verdict === 'new_wins' ? c.plaintiffAgentId
      : verdict === 'old_wins' ? c.defendantAgentId
      : null,
    loserId: verdict === 'new_wins' ? c.defendantAgentId
      : verdict === 'old_wins' ? c.plaintiffAgentId
      : null,
    majorityReasoning: '监管局最终裁决：降级单 LLM 强制裁决',
    individualVerdicts: [],
    isUnanimous: true,
    isDeadlocked: false,
    issuedAt: now,
  };

  const intervention: RegulatoryIntervention = {
    interventionId: `intervention-${++interventionCounter}`,
    caseId: c.caseId,
    conflictId: c.conflictId,
    reason: params.reason,
    verdict: finalVerdict,
    issuedAt: now,
    modelUsed: 'rule-based',
  };

  interventions.set(intervention.interventionId, intervention);

  // 广播裁决（带 intervention 标记）
  publish(createEvent({
    eventType: EventType.ARBITRATION_VERDICT,
    source: 'Regulation/finalArbiter',
    traceId: c.traceId,
    priority: 'critical',
    payload: {
      caseId: c.caseId,
      verdict: finalVerdict.verdict,
      isRegulatoryIntervention: true,
      interventionId: intervention.interventionId,
    },
  }));

  return ok(intervention);
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getIntervention(interventionId: string): RegulatoryIntervention | undefined {
  return interventions.get(interventionId);
}

export function getInterventionsByCase(caseId: string): RegulatoryIntervention[] {
  return [...interventions.values()].filter(i => i.caseId === caseId);
}

export function getAllInterventions(): RegulatoryIntervention[] {
  return [...interventions.values()];
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetFinalArbiter(): void {
  interventions.clear();
  interventionCounter = 0;
}
