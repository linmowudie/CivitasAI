/**
 * @module Arbitration/tribunal
 * @description
 * 仲裁庭——Docs/Agent/05 §4 六步治理闭环。
 * 冲突接收 → 胶囊组装 → 裁决推理 → 律师函挂起 → 现场恢复 → 知识沉淀。
 * Phase 0-2：规则裁决（不调 LLM）；Phase 3 接真实 LLM 仲裁。
 */

import { EventType } from '../EventBus/eventTypes.js';
import { logger } from '../../Infra/Logging/logger.js';
import { recordConflict, evaluateScaling } from './dynamicScaling.js';
import { requireGovernanceRole } from '../Governance/governanceGuard.js';
import { writeMemory } from '../SharedMemory/longTermMemory.js';

// FE-062 收敛：胶囊/恢复的唯一实现（tribunal 委托，消除双实现漂移）
import {
  assembleCapsule as assembleCapsuleFromSource,
  resetCapsuleAssembler,
} from './capsuleAssembler.js';
import {
  createPlan as createRestorationPlanCore,
  executePlan as executeRestorationPlan,
  getPlan as getRestorationPlanCore,
  resetRestorationManager,
} from './restorationManager.js';

/** 仲裁庭自身即治理机构：其裁决/执法动作以 arbitrator 角色记录 */
const TRIBUNAL_ROLE = 'arbitrator';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import type {
  ArbitrationCase, ContextCapsule, FinalVerdict, ArbitratorVerdict,
  ConflictType, VerdictType, RestorationPlan,
} from './types.js';

// ── 内部状态 ────────────────────────────────────────────────────────

const cases: Map<string, ArbitrationCase> = new Map();
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

  // ★ 动态扩容生产调用者（2026-10-04）：立案即登记冲突频率并评估仲裁者池规模。
  //   此前 `dynamicScaling.{recordConflict,evaluateScaling}` **无任何生产调用者**（孤岛），
  //   "按需扩容"因此永不触发。现在由立案驱动；评估失败不阻断立案。
  try {
    recordConflict();
    const scaled = evaluateScaling();
    if (scaled.ok && scaled.value.action === 'scale_up') {
      logger.info('冲突频率触发仲裁者池扩容', {
        source: 'Arbitration/tribunal/fileCase',
        conflictId: params.conflictId,
        targetCount: scaled.value.targetCount,
      });
    }
  } catch (e) {
    logger.warn('仲裁者池扩缩评估失败（立案继续）', {
      source: 'Arbitration/tribunal/fileCase',
      error: e instanceof Error ? e.message : String(e),
    });
  }

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
 * 组装上下文胶囊（FE-062 收敛：委托 capsuleAssembler 唯一实现；内容直传路径）。
 * 本函数仅保留案件语义（写入 case.capsule + 状态流转）。
 */
export function assembleCapsule(caseId: string, params: {
  newMemoryContent: string;
  oldMemoryContent: string;
  taskDescription: string;
}): Result<ContextCapsule> {
  const c = cases.get(caseId);
  if (!c) return err(`案件 ${caseId} 不存在`);

  const assembled = assembleCapsuleFromSource({
    conflictId: c.conflictId,
    newMemoryContent: params.newMemoryContent,
    oldMemoryContent: params.oldMemoryContent,
    plaintiffAgentId: c.plaintiffAgentId,
    defendantAgentId: c.defendantAgentId,
    taskDescription: params.taskDescription,
  });
  if (!assembled.ok) return err(assembled.error);

  c.capsule = assembled.value;
  c.status = 'assembling';
  return ok(assembled.value);
}

// ── Step 3：裁决推理 ────────────────────────────────────────────────

/**
 * 执行裁决推理（Phase 0-2：规则裁决；后续接 3-LLM 多数决）。
 * 优先级协议：LWW > 任务权威性 > 证据链完整性 > LLM 兜底。
 */
export function reasonVerdict(caseId: string, actorRole: string): Result<FinalVerdict> {
  const guard = requireGovernanceRole(actorRole, '仲裁裁决');
  if (!guard.ok) return err(guard.error);
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

  const maxVerdict = Object.entries(verdictCounts).sort((a, b) => b[1] - a[1])[0] ?? ['unknown', 0] as [string, number];
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
export function issueSuspension(caseId: string, actorRole: string): Result<void> {
  const guard = requireGovernanceRole(actorRole, '仲裁停职（执法）');
  if (!guard.ok) return err(guard.error);
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
 * 创建恢复计划（FE-062 收敛：委托 restorationManager 唯一实现）。
 */
export function createRestorationPlan(caseId: string, params: {
  restorerAgentId: string;
  strategy: 'self_healing' | 'global_takeover';
}): Result<RestorationPlan> {
  const c = cases.get(caseId);
  if (!c) return err(`案件 ${caseId} 不存在`);

  const created = createRestorationPlanCore({
    caseId,
    conflictId: c.conflictId,
    restorerAgentId: params.restorerAgentId,
    strategy: params.strategy,
  });
  if (!created.ok) return err(created.error);

  c.status = 'restoring';
  return ok(created.value);
}

/**
 * 完成恢复（FE-062 收敛：委托 restorationManager.executePlan——
 * 回填补偿动作执行状态 + 发布 RESTORATION_ACK；本函数仅保留案件状态流转）。
 */
export function completeRestoration(planId: string): Result<void> {
  const plan = getRestorationPlanCore(planId);
  if (!plan) return err(`恢复计划 ${planId} 不存在`);

  const executed = executeRestorationPlan(planId);
  if (!executed.ok) return err(executed.error);

  const c = cases.get(plan.caseId);
  if (c) {
    c.status = 'completed';
    c.restoredAt = Date.now();
    c.completedAt = Date.now();
  }

  return ok(undefined);
}

// ── Step 6：知识沉淀 ────────────────────────────────────────────────

/**
 * 将裁决结果提炼为长期知识（FE-059 实装）。
 * 注：Docs/Agent/14 §8 #24 裁定 KNOWLEDGE_CONSOLIDATION 事件由仲裁与 Loop 退出口双源发布；
 * Loop 退出口的接线由 `Core/Loop/loopKnowledge.ts` 承担（成功退出时）。
 * 本函数此前仅发布事件、不写记忆（“接线尚未落地”）；现落实：裁决写入长期记忆
 * （category='decision'，携带 caseId/traceId 溯源）——仲裁者的“史官”职责全链闭环。
 */
export function consolidateKnowledge(caseId: string, actorRole: string): Result<void> {
  // ★ 知识沉淀 = 仲裁者的"史官"职责（灵感源《一些思考2》§4.5：裁决完成后由仲裁者清理全局上下文、
  //   提炼静态知识并写入长期记忆）→ 属**治理动作**，仅 L0（arbitrator）/ user 可执行。
  const knowledgeGuard = requireGovernanceRole(actorRole, '知识沉淀（史官职责）');
  if (!knowledgeGuard.ok) return err(knowledgeGuard.error);

  const c = cases.get(caseId);
  if (!c) return err(`案件 ${caseId} 不存在`);
  if (!c.finalVerdict) return err(`案件 ${caseId} 无裁决结果`);

  const v = c.finalVerdict;

  // FE-059：落实写长期记忆（此前仅发布事件，无任何写入——“接线尚未落地”）。
  //   裁决 = 决策型知识（observed：实际发生的裁决事实，携带 caseId 溯源）。
  const memoryContent = [
    `裁决：${v.verdict}（${v.isUnanimous ? '一致' : '多数决'}）`,
    v.majorityReasoning ? `理由：${v.majorityReasoning}` : '',
    `胜方：${v.winnerId ?? '无'}；败方：${v.loserId ?? '无'}`,
  ].filter(Boolean).join('\n');

  const memoryResult = writeMemory({
    title: `仲裁裁决 ${caseId}：${v.verdict}`,
    content: memoryContent,
    category: 'decision',
    sourceTraceIds: c.traceId ? [c.traceId] : [],
    sourceArbitrationIds: [caseId],
  });

  if (!memoryResult.ok) {
    // 沉淀失败不阻断治理闭环的事件契约，但如实返回错误（调用方可见）
    logger.warn('裁决知识沉淀失败', {
      source: 'Arbitration/tribunal/consolidateKnowledge',
      caseId,
      error: memoryResult.error,
    });
    return err(`裁决知识沉淀失败：${memoryResult.error}`);
  }

  // 发布知识沉淀事件
  publish(createEvent({
    eventType: EventType.KNOWLEDGE_CONSOLIDATION,
    source: 'Arbitration/tribunal/consolidateKnowledge',
    traceId: c.traceId,
    payload: {
      caseId,
      conflictId: c.conflictId,
      verdict: c.finalVerdict.verdict,
      memoryId: memoryResult.value.memoryId,
    },
  }));

  return ok(undefined);
}

// ── 端到端执行 ──────────────────────────────────────────────────────

/**
 * 端到端执行六步治理闭环。
 *
 * FE-047（2026-10-04）：新增 `actorRole` 参数 —— 闭环中的裁决/停职/知识沉淀
 * 均属治理执法，此前内部硬编码 `TRIBUNAL_ROLE`，外部无法以实际发起者身份留痕。
 * 缺省仍为仲裁庭自身角色 `arbitrator`（本函数即仲裁庭的端到端执行器）。
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
  /** 执行者角色（须为 L0 / user）；缺省为仲裁庭自身角色 `arbitrator` */
  actorRole?: string;
}): Result<ArbitrationCase> {
  const actor = params.actorRole ?? TRIBUNAL_ROLE;

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
  const verdictResult = reasonVerdict(caseId, actor);
  if (!verdictResult.ok) return err(verdictResult.error);

  // 死锁 → 升级监管局
  if (verdictResult.value.isDeadlocked) {
    return ok(cases.get(caseId)!);
  }

  // Step 4: 律师函挂起
  issueSuspension(caseId, actor);

  // Step 5: 现场恢复
  const restoreResult = createRestorationPlan(caseId, {
    restorerAgentId: params.restorerAgentId,
    strategy: 'self_healing',
  });
  if (restoreResult.ok) {
    completeRestoration(restoreResult.value.planId);
  }

  // Step 6: 知识沉淀
  consolidateKnowledge(caseId, actor);

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
  suspendHistory.clear();
  caseCounter = 0;
  // FE-062：同域收敛——胶囊/恢复状态一并重置（供测试隔离）
  resetCapsuleAssembler();
  resetRestorationManager();
}
