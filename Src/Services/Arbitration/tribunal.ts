/**
 * @module Arbitration/tribunal
 * @description
 * 仲裁庭——Docs/05 §4 六步治理闭环。
 * 冲突接收 → 胶囊组装 → 裁决推理 → 律师函挂起 → 现场恢复 → 知识沉淀。
 * Phase 0-2：规则裁决（不调 LLM）；Phase 3 接真实 LLM 仲裁。
 */

import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import type {
  ArbitrationCase, ContextCapsule, FinalVerdict, ArbitratorVerdict,
  ConflictType, VerdictType, RestorationPlan,
} from './types.js';

// ── 内部状态 ────────────────────────────────────────────────────────

const cases: Map<string, ArbitrationCase> = new Map();
const restorationPlans: Map<string, RestorationPlan> = new Map();
let caseCounter = 0;

// ── 挂起防抖：同 (loopId, conflictId) 5 分钟内只挂一次 ─────────────

const SUSPEND_COOLDOWN_MS = 5 * 60 * 1000;
const suspendHistory: Map<string, number> = new Map(); // conflictId → lastSuspendAt

// ── Step 1：立案 ────────────────────────────────────────────────────

/**
 * 接收冲突事件，创建仲裁案件。
 */
export function fileCase(params: {
  conflictId: string;
  traceId: string;
  conflictType: ConflictType;
  plaintiffAgentId: string;
  defendantAgentId: string;
}): Result<ArbitrationCase> {
  // 检查是否已有同 conflictId 的案件
  for (const c of cases.values()) {
    if (c.conflictId === params.conflictId && c.status !== 'completed') {
      return err(`冲突 ${params.conflictId} 已有进行中案件 ${c.caseId}`);
    }
  }

  const caseId = `case-${++caseCounter}`;
  const now = Date.now();

  const arbitrationCase: ArbitrationCase = {
    caseId,
    conflictId: params.conflictId,
    traceId: params.traceId,
    status: 'filed',
    conflictType: params.conflictType,
    plaintiffAgentId: params.plaintiffAgentId,
    defendantAgentId: params.defendantAgentId,
    filedAt: now,
    suspendIssued: false,
  };

  cases.set(caseId, arbitrationCase);

  // 发布立案事件
  publish(createEvent({
    eventType: EventType.ARBITRATION_FILED,
    source: 'Arbitration/tribunal/fileCase',
    traceId: params.traceId,
    payload: { caseId, conflictId: params.conflictId },
  }));

  return ok(arbitrationCase);
}

// ── Step 2：胶囊组装 ────────────────────────────────────────────────

/**
 * 组装上下文胶囊（Phase 0-2：简化版，不拉取真实证据）。
 */
export function assembleCapsule(caseId: string, params: {
  newMemoryContent: string;
  oldMemoryContent: string;
  taskDescription: string;
}): Result<ContextCapsule> {
  const c = cases.get(caseId);
  if (!c) return err(`案件 ${caseId} 不存在`);

  const capsule: ContextCapsule = {
    capsuleId: `capsule-${caseId}`,
    conflictId: c.conflictId,
    evidence: {
      newMemory: {
        content: params.newMemoryContent,
        metadata: { source: c.plaintiffAgentId },
        agentId: c.plaintiffAgentId,
      },
      oldMemory: {
        content: params.oldMemoryContent,
        metadata: { source: c.defendantAgentId },
        agentId: c.defendantAgentId,
      },
    },
    taskContext: {
      parentTaskDescription: params.taskDescription,
      constraints: [],
    },
    agentHistory: {
      plaintiffOps: [],
      defendantOps: [],
    },
    tokenBudget: 5000,
    createdAt: Date.now(),
  };

  c.capsule = capsule;
  c.status = 'assembling';
  return ok(capsule);
}

// ── Step 3：裁决推理 ────────────────────────────────────────────────

/**
 * 执行裁决推理（Phase 0-2：规则裁决；后续接 3-LLM 多数决）。
 * 优先级协议：LWW > 任务权威性 > 证据链完整性 > LLM 兜底。
 */
export function reasonVerdict(caseId: string): Result<FinalVerdict> {
  const c = cases.get(caseId);
  if (!c) return err(`案件 ${caseId} 不存在`);
  if (!c.capsule) return err(`案件 ${caseId} 胶囊未组装`);

  c.status = 'reasoning';

  // Phase 0-2：规则裁决（LWW 时间戳优先）
  const individualVerdicts: ArbitratorVerdict[] = [];
  const now = Date.now();

  // 模拟 3 个仲裁者（规则一致）
  for (let i = 1; i <= 3; i++) {
    individualVerdicts.push({
      arbitratorId: `arbitrator-${i}`,
      verdict: 'new_wins', // 规则：新记忆胜
      winnerId: c.plaintiffAgentId,
      loserId: c.defendantAgentId,
      reasoning: 'Phase 0-2 规则裁决：LWW 时间戳优先',
      confidence: 0.8,
      deliveredAt: now,
    });
  }

  // 多数决汇总
  const verdictCounts: Record<string, number> = {};
  for (const v of individualVerdicts) {
    verdictCounts[v.verdict] = (verdictCounts[v.verdict] ?? 0) + 1;
  }

  const maxVerdict = Object.entries(verdictCounts).sort((a, b) => b[1] - a[1])[0];
  const isUnanimous = maxVerdict[1] === 3;
  const isDeadlocked = Object.keys(verdictCounts).length === 3; // 三种不同裁决

  const finalVerdict: FinalVerdict = {
    caseId,
    conflictId: c.conflictId,
    verdict: maxVerdict[0] as VerdictType,
    winnerId: c.plaintiffAgentId,
    loserId: c.defendantAgentId,
    majorityReasoning: 'Phase 0-2 规则裁决：多数一致',
    individualVerdicts,
    isUnanimous,
    isDeadlocked,
    issuedAt: now,
  };

  c.finalVerdict = finalVerdict;
  c.status = isDeadlocked ? 'deadlocked' : 'verdict_ready';
  c.verdictAt = now;

  // 发布裁决事件
  publish(createEvent({
    eventType: EventType.ARBITRATION_VERDICT,
    source: 'Arbitration/tribunal/reasonVerdict',
    traceId: c.traceId,
    payload: { caseId, verdict: finalVerdict.verdict, isDeadlocked },
  }));

  return ok(finalVerdict);
}

// ── Step 4：律师函挂起 ──────────────────────────────────────────────

/**
 * 发布律师函挂起涉事 Agent。
 * 5 分钟内同 (loopId, conflictId) 只挂一次。
 */
export function issueSuspension(caseId: string): Result<void> {
  const c = cases.get(caseId);
  if (!c) return err(`案件 ${caseId} 不存在`);

  const now = Date.now();

  // 防抖检查
  const lastSuspend = suspendHistory.get(c.conflictId);
  if (lastSuspend && now - lastSuspend < SUSPEND_COOLDOWN_MS) {
    return ok(undefined); // 5 分钟内已挂起，跳过
  }

  // 发布挂起事件
  publish(createEvent({
    eventType: EventType.SUSPEND_AND_NOTIFY,
    source: 'Arbitration/tribunal/issueSuspension',
    traceId: c.traceId,
    priority: 'critical',
    payload: {
      caseId,
      conflictId: c.conflictId,
      targetAgentIds: [c.plaintiffAgentId, c.defendantAgentId],
      suspensionReason: `仲裁案件 ${caseId} 进行中`,
    },
  }));

  c.suspendIssued = true;
  c.lastSuspendAt = now;
  c.status = 'suspended';
  suspendHistory.set(c.conflictId, now);

  return ok(undefined);
}

// ── Step 5：现场恢复 ────────────────────────────────────────────────

/**
 * 创建恢复计划。
 */
export function createRestorationPlan(caseId: string, params: {
  restorerAgentId: string;
  strategy: 'self_healing' | 'global_takeover';
}): Result<RestorationPlan> {
  const c = cases.get(caseId);
  if (!c) return err(`案件 ${caseId} 不存在`);

  const plan: RestorationPlan = {
    planId: `restore-${caseId}`,
    caseId,
    conflictId: c.conflictId,
    restorerAgentId: params.restorerAgentId,
    strategy: params.strategy,
    compensatingActions: [],
    status: 'pending',
    createdAt: Date.now(),
  };

  restorationPlans.set(plan.planId, plan);
  c.status = 'restoring';
  return ok(plan);
}

/**
 * 完成恢复。
 */
export function completeRestoration(planId: string): Result<void> {
  const plan = restorationPlans.get(planId);
  if (!plan) return err(`恢复计划 ${planId} 不存在`);

  plan.status = 'completed';
  plan.completedAt = Date.now();

  const c = cases.get(plan.caseId);
  if (c) {
    c.status = 'completed';
    c.restoredAt = Date.now();
    c.completedAt = Date.now();
  }

  // 发布恢复确认事件
  publish(createEvent({
    eventType: EventType.RESTORATION_ACK,
    source: 'Arbitration/tribunal/completeRestoration',
    traceId: c?.traceId,
    payload: { planId, caseId: plan.caseId },
  }));

  return ok(undefined);
}

// ── Step 6：知识沉淀 ────────────────────────────────────────────────

/**
 * 将裁决结果提炼为长期知识（Phase 0-2：标记事件）。
 */
export function consolidateKnowledge(caseId: string): Result<void> {
  const c = cases.get(caseId);
  if (!c) return err(`案件 ${caseId} 不存在`);
  if (!c.finalVerdict) return err(`案件 ${caseId} 无裁决结果`);

  // 发布知识沉淀事件
  publish(createEvent({
    eventType: EventType.KNOWLEDGE_CONSOLIDATION,
    source: 'Arbitration/tribunal/consolidateKnowledge',
    traceId: c.traceId,
    payload: {
      caseId,
      conflictId: c.conflictId,
      verdict: c.finalVerdict.verdict,
    },
  }));

  return ok(undefined);
}

// ── 端到端执行 ──────────────────────────────────────────────────────

/**
 * 端到端执行六步治理闭环。
 */
export function executeFullArbitration(params: {
  conflictId: string;
  traceId: string;
  conflictType: ConflictType;
  plaintiffAgentId: string;
  defendantAgentId: string;
  newMemoryContent: string;
  oldMemoryContent: string;
  taskDescription: string;
  restorerAgentId: string;
}): Result<ArbitrationCase> {
  // Step 1: 立案
  const fileResult = fileCase(params);
  if (!fileResult.ok) return fileResult;
  const caseId = fileResult.value.caseId;

  // Step 2: 胶囊组装
  const capsuleResult = assembleCapsule(caseId, {
    newMemoryContent: params.newMemoryContent,
    oldMemoryContent: params.oldMemoryContent,
    taskDescription: params.taskDescription,
  });
  if (!capsuleResult.ok) return err(capsuleResult.error);

  // Step 3: 裁决推理
  const verdictResult = reasonVerdict(caseId);
  if (!verdictResult.ok) return err(verdictResult.error);

  // 死锁 → 升级监管局
  if (verdictResult.value.isDeadlocked) {
    return ok(cases.get(caseId)!);
  }

  // Step 4: 律师函挂起
  issueSuspension(caseId);

  // Step 5: 现场恢复
  const restoreResult = createRestorationPlan(caseId, {
    restorerAgentId: params.restorerAgentId,
    strategy: 'self_healing',
  });
  if (restoreResult.ok) {
    completeRestoration(restoreResult.value.planId);
  }

  // Step 6: 知识沉淀
  consolidateKnowledge(caseId);

  return ok(cases.get(caseId)!);
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getCase(caseId: string): ArbitrationCase | undefined {
  const c = cases.get(caseId);
  return c ? { ...c } : undefined;
}

export function getCaseByConflictId(conflictId: string): ArbitrationCase | undefined {
  for (const c of cases.values()) {
    if (c.conflictId === conflictId) return { ...c };
  }
  return undefined;
}

export function getAllCases(): ArbitrationCase[] {
  return [...cases.values()].map(c => ({ ...c }));
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetTribunal(): void {
  cases.clear();
  restorationPlans.clear();
  suspendHistory.clear();
  caseCounter = 0;
}
