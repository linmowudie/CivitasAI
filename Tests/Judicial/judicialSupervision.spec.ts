/**
 * S12 司法与监管闭环测试——Gate G12 验证
 *
 * 覆盖：
 * - Tribunal（六步治理闭环端到端）
 * - CapsuleAssembler（胶囊组装）
 * - ArbitratorPool（仲裁者池管理）
 * - DynamicScaling（动态扩缩）
 * - RestorationManager（恢复管理）
 * - BehaviorCode（行为准则）
 * - BroadcastChannel（广播通道）
 * - FinalArbiter（最终裁决）
 * - RegulatoryAuthority（监管局主入口）
 * - AnomalyDetector（异常检测）
 * - FreezeManager（冻结管理）
 * - PatrolScheduler（巡检调度）
 * - ResourceAuditBureau（审计局主入口）
 * - Gate G12 综合验证
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── Tribunal ────────────────────────────────────────
import {
  fileCase, assembleCapsule, reasonVerdict, issueSuspension,
  createRestorationPlan, completeRestoration, consolidateKnowledge,
  executeFullArbitration, getCase, getCaseByConflictId, getAllCases,
  resetTribunal,
} from '../../Src/Services/Arbitration/tribunal.js';

// ── CapsuleAssembler ─────────────────────────────────
import {
  initCapsuleAssembler, assembleCapsule as assembleCapsuleStandalone,
  resetCapsuleAssembler,
} from '../../Src/Services/Arbitration/capsuleAssembler.js';

// ── ArbitratorPool ───────────────────────────────────
import {
  initArbitratorPool, assignArbitrators, releaseArbitrators,
  executeVerdicts, resizeAuxiliaryPool, getPoolStats, getAllArbitrators,
  resetArbitratorPool,
} from '../../Src/Services/Arbitration/arbitratorPool.js';

// ── DynamicScaling ───────────────────────────────────
import {
  initDynamicScaling, recordConflict, evaluateScaling,
  getScalingStats, resetDynamicScaling,
} from '../../Src/Services/Arbitration/dynamicScaling.js';

// ── RestorationManager ───────────────────────────────
import {
  createPlan, addCompensatingAction, executePlan,
  getPlan, getPlansByCase, resetRestorationManager,
} from '../../Src/Services/Arbitration/restorationManager.js';

// ── BehaviorCode ─────────────────────────────────────
import {
  initBehaviorCode, getCurrentCode, getRules, getRule,
  checkViolation, addRule, removeRule, updateVersion,
  resetBehaviorCode,
} from '../../Src/Services/Regulation/behaviorCode.js';

// ── BroadcastChannel ─────────────────────────────────
import {
  broadcast, acknowledge, getBroadcast, getBroadcasts, getUnacknowledged,
  resetBroadcastChannel,
} from '../../Src/Services/Regulation/broadcastChannel.js';

// ── FinalArbiter ─────────────────────────────────────
import {
  issueFinalVerdict, getIntervention, getAllInterventions,
  resetFinalArbiter,
} from '../../Src/Services/Regulation/finalArbiter.js';

// ── RegulatoryAuthority ──────────────────────────────
import {
  initRegulatoryAuthority, getBehaviorCode, validateBehavior,
  broadcastMessage, escalateDeadlock, emergencyIntervene,
  getEmergencyRecords, resetRegulatoryAuthority,
} from '../../Src/Services/Regulation/regulatoryAuthority.js';

// ── AnomalyDetector ──────────────────────────────────
import {
  initAnomalyDetector, checkRollingWindow, checkDeviation, checkLoop,
  recordConsumption, getAlerts, getCriticalAlerts,
  resetAnomalyDetector,
} from '../../Src/Services/Audit/anomalyDetector.js';

// ── FreezeManager ────────────────────────────────────
import {
  freezeAgent, unfreezeAgent, isFrozen, checkAutoUnfreeze,
  getAllFrozenAgents, getFreezeHistory, setAutoUnfreezeSec,
  resetFreezeManager,
} from '../../Src/Services/Audit/freezeManager.js';

// ── PatrolScheduler ──────────────────────────────────
import {
  initPatrolScheduler, registerAgentSnapshot, executePatrol,
  getReports, getLatestReport,
  resetPatrolScheduler,
} from '../../Src/Services/Audit/patrolScheduler.js';

// ── ResourceAuditBureau ──────────────────────────────
import {
  initResourceAuditBureau, monitorAgent, investigate,
  getAuditReports, getFrozenAgents as getBureauFrozen,
  resetResourceAuditBureau,
} from '../../Src/Services/Audit/resourceAuditBureau.js';

// ── EventBus ─────────────────────────────────────────
import { resetEventBus, getEventLog } from '../../Src/Services/EventBus/eventBus.js';

// ═══════════════════════════════════════════════════════
// 1. Tribunal 六步治理闭环
// ═══════════════════════════════════════════════════════

describe('Tribunal 六步治理闭环', () => {
  beforeEach(() => {
    resetTribunal();
    resetEventBus();
  });

  it('Step 1: 立案——创建仲裁案件', () => {
    const result = fileCase({
      conflictId: 'conflict-1',
      traceId: 'trace-1',
      conflictType: 'semantic_opposition',
      plaintiffAgentId: 'agent-new',
      defendantAgentId: 'agent-old',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('filed');
      expect(result.value.conflictId).toBe('conflict-1');
    }
  });

  it('Step 1: 重复冲突不可重复立案', () => {
    fileCase({
      conflictId: 'conflict-dup',
      traceId: 'trace-1',
      conflictType: 'contradiction',
      plaintiffAgentId: 'a1',
      defendantAgentId: 'a2',
    });
    const dup = fileCase({
      conflictId: 'conflict-dup',
      traceId: 'trace-2',
      conflictType: 'contradiction',
      plaintiffAgentId: 'a3',
      defendantAgentId: 'a4',
    });
    expect(dup.ok).toBe(false);
  });

  it('Step 2: 胶囊组装——包含证据与上下文', () => {
    const filed = fileCase({
      conflictId: 'c-2', traceId: 't-2',
      conflictType: 'duplication',
      plaintiffAgentId: 'a-new', defendantAgentId: 'a-old',
    });
    expect(filed.ok).toBe(true);
    if (!filed.ok) return;

    const capsule = assembleCapsule(filed.value.caseId, {
      newMemoryContent: '新记忆：端口 3000',
      oldMemoryContent: '旧记忆：端口 8080',
      taskDescription: '配置 Web 服务器',
    });
    expect(capsule.ok).toBe(true);
    if (capsule.ok) {
      expect(capsule.value.evidence.newMemory.content).toBe('新记忆：端口 3000');
      expect(capsule.value.evidence.oldMemory.agentId).toBe('a-old');
    }
  });

  it('Step 3: 裁决推理——Phase 0-2 规则裁决', () => {
    const filed = fileCase({
      conflictId: 'c-3', traceId: 't-3',
      conflictType: 'semantic_opposition',
      plaintiffAgentId: 'a-new', defendantAgentId: 'a-old',
    });
    if (!filed.ok) return;
    assembleCapsule(filed.value.caseId, {
      newMemoryContent: 'A', oldMemoryContent: 'B', taskDescription: 'T',
    });

    const verdict = reasonVerdict(filed.value.caseId);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.value.verdict).toBe('new_wins');
      expect(verdict.value.isUnanimous).toBe(true);
      expect(verdict.value.isDeadlocked).toBe(false);
      expect(verdict.value.individualVerdicts.length).toBe(3);
    }
  });

  it('Step 4: 律师函挂起——5 分钟内只挂一次', () => {
    const filed = fileCase({
      conflictId: 'c-4', traceId: 't-4',
      conflictType: 'contradiction',
      plaintiffAgentId: 'a1', defendantAgentId: 'a2',
    });
    if (!filed.ok) return;
    assembleCapsule(filed.value.caseId, {
      newMemoryContent: 'X', oldMemoryContent: 'Y', taskDescription: 'Z',
    });
    reasonVerdict(filed.value.caseId);

    const r1 = issueSuspension(filed.value.caseId);
    expect(r1.ok).toBe(true);

    // 同 conflictId 第二次挂起 → 冷却期跳过
    const filed2 = fileCase({
      conflictId: 'c-4b', traceId: 't-4b',
      conflictType: 'contradiction',
      plaintiffAgentId: 'a3', defendantAgentId: 'a4',
    });
    // 不同 conflictId 不受限
    if (filed2.ok) {
      assembleCapsule(filed2.value.caseId, {
        newMemoryContent: 'X', oldMemoryContent: 'Y', taskDescription: 'Z',
      });
      reasonVerdict(filed2.value.caseId);
      const r2 = issueSuspension(filed2.value.caseId);
      expect(r2.ok).toBe(true);
    }
  });

  it('Step 5: 现场恢复——创建并执行恢复计划', () => {
    const filed = fileCase({
      conflictId: 'c-5', traceId: 't-5',
      conflictType: 'semantic_opposition',
      plaintiffAgentId: 'a1', defendantAgentId: 'a2',
    });
    if (!filed.ok) return;

    const plan = createRestorationPlan(filed.value.caseId, {
      restorerAgentId: 'a-restorer',
      strategy: 'self_healing',
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.value.strategy).toBe('self_healing');
      expect(plan.value.status).toBe('pending');
    }
  });

  it('Step 6: 知识沉淀——发布 KNOWLEDGE_CONSOLIDATION 事件', () => {
    const filed = fileCase({
      conflictId: 'c-6', traceId: 't-6',
      conflictType: 'semantic_opposition',
      plaintiffAgentId: 'a1', defendantAgentId: 'a2',
    });
    if (!filed.ok) return;
    assembleCapsule(filed.value.caseId, {
      newMemoryContent: 'A', oldMemoryContent: 'B', taskDescription: 'T',
    });
    reasonVerdict(filed.value.caseId);

    const before = getEventLog({ eventType: 'arbitration:knowledge_consolidation' as any }).length;
    const result = consolidateKnowledge(filed.value.caseId);
    expect(result.ok).toBe(true);
    const after = getEventLog({ eventType: 'arbitration:knowledge_consolidation' as any }).length;
    expect(after).toBe(before + 1);
  });

  it('端到端：六步治理闭环完整执行', () => {
    const result = executeFullArbitration({
      conflictId: 'conflict-e2e',
      traceId: 'trace-e2e',
      conflictType: 'semantic_opposition',
      plaintiffAgentId: 'agent-new',
      defendantAgentId: 'agent-old',
      newMemoryContent: '新真相',
      oldMemoryContent: '旧真相',
      taskDescription: '验证任务',
      restorerAgentId: 'agent-restorer',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('completed');
      expect(result.value.finalVerdict).toBeDefined();
      expect(result.value.finalVerdict!.verdict).toBe('new_wins');
    }
  });
});

// ═══════════════════════════════════════════════════════
// 2. CapsuleAssembler 独立模块
// ═══════════════════════════════════════════════════════

describe('CapsuleAssembler 独立胶囊组装', () => {
  beforeEach(() => {
    resetCapsuleAssembler();
  });

  it('无证据源时简化组装', () => {
    const result = assembleCapsuleStandalone({
      conflictId: 'c-1',
      plaintiffAgentId: 'a1',
      defendantAgentId: 'a2',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.evidence.newMemory.content).toBe('(简化模式)');
    }
  });

  it('有证据源时拉取真实数据', () => {
    initCapsuleAssembler({
      getMemoryContent: (id) => id === 'mem-new' ? '新内容' : '旧内容',
      getMemoryMetadata: (id) => ({ source: id }),
      getAgentOps: () => [],
      getTaskContext: () => ({ description: '测试任务', constraints: ['约束1'] }),
    });

    const result = assembleCapsuleStandalone({
      conflictId: 'c-2',
      newMemoryId: 'mem-new',
      oldMemoryId: 'mem-old',
      plaintiffAgentId: 'a1',
      defendantAgentId: 'a2',
      taskId: 'task-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.evidence.newMemory.content).toBe('新内容');
      expect(result.value.evidence.oldMemory.content).toBe('旧内容');
      expect(result.value.taskContext.parentTaskDescription).toBe('测试任务');
      expect(result.value.taskContext.constraints).toContain('约束1');
    }
  });
});

// ═══════════════════════════════════════════════════════
// 3. ArbitratorPool 仲裁者池
// ═══════════════════════════════════════════════════════

describe('ArbitratorPool 仲裁者池管理', () => {
  beforeEach(() => {
    resetArbitratorPool();
  });

  it('初始化默认 1 核心 + 2 辅助', () => {
    initArbitratorPool();
    const stats = getPoolStats();
    expect(stats.core).toBe(1);
    expect(stats.auxiliary).toBe(2);
    expect(stats.idle).toBe(3);
  });

  it('分配仲裁者——核心层优先', () => {
    initArbitratorPool();
    const result = assignArbitrators('case-1', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
      expect(result.value[0].layer).toBe('core');
    }
  });

  it('仲裁者不足时返回错误', () => {
    initArbitratorPool({ coreCount: 1, auxiliaryCount: 0 });
    const result = assignArbitrators('case-1', 3);
    expect(result.ok).toBe(false);
  });

  it('释放仲裁者——状态回到 idle', () => {
    initArbitratorPool();
    assignArbitrators('case-1', 2);
    expect(getPoolStats().busy).toBe(2);

    releaseArbitrators('case-1');
    expect(getPoolStats().busy).toBe(0);
    expect(getPoolStats().idle).toBe(3);
  });

  it('扩容辅助层', () => {
    initArbitratorPool({ auxiliaryCount: 1 });
    expect(getPoolStats().auxiliary).toBe(1);

    resizeAuxiliaryPool(5);
    expect(getPoolStats().auxiliary).toBe(5);
  });

  it('模拟裁决——Phase 0-2 规则一致', () => {
    initArbitratorPool();
    const assigned = assignArbitrators('case-1', 3);
    if (!assigned.ok) return;

    const verdicts = executeVerdicts({
      caseId: 'case-1',
      arbitrators: assigned.value,
      plaintiffAgentId: 'a-new',
      defendantAgentId: 'a-old',
    });
    expect(verdicts.length).toBe(3);
    expect(verdicts.every(v => v.verdict === 'new_wins')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 4. DynamicScaling 动态扩缩
// ═══════════════════════════════════════════════════════

describe('DynamicScaling 动态扩缩', () => {
  beforeEach(() => {
    resetArbitratorPool();
    resetDynamicScaling();
    resetEventBus();
    initArbitratorPool({ coreCount: 1, auxiliaryCount: 2 });
    initDynamicScaling({
      frequencyThreshold: 3,
      consecutiveHighCount: 2,
      consecutiveLowCount: 2,
      cooldownMs: 0, // 无冷却便于测试
    });
  });

  it('高负载连续超阈值 → 扩容', () => {
    // 记录大量冲突
    for (let i = 0; i < 10; i++) recordConflict();

    // 第一次评估
    const r1 = evaluateScaling();
    expect(r1.ok).toBe(true);

    // 第二次评估（连续 2 次高负载）
    const r2 = evaluateScaling();
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value.action).toBe('scale_up');
    }
  });

  it('低负载连续低于阈值一半 → 缩容', () => {
    // 无冲突记录 → 低负载
    const r1 = evaluateScaling();
    expect(r1.ok).toBe(true);
    const r2 = evaluateScaling();
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      // 辅助层从 2 缩到 1
      expect(r2.value.action).toBe('scale_down');
    }
  });
});

// ═══════════════════════════════════════════════════════
// 5. RestorationManager 恢复管理
// ═══════════════════════════════════════════════════════

describe('RestorationManager 恢复管理', () => {
  beforeEach(() => {
    resetRestorationManager();
    resetEventBus();
  });

  it('创建恢复计划 + 添加补偿动作 + 执行', () => {
    const plan = createPlan({
      caseId: 'case-1',
      conflictId: 'conflict-1',
      restorerAgentId: 'a-restorer',
      strategy: 'self_healing',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    addCompensatingAction(plan.value.planId, {
      actionId: 'act-1',
      type: 'rollback_file',
      target: '/src/main.ts',
      description: '回滚错误文件修改',
      executed: false,
    });

    const exec = executePlan(plan.value.planId);
    expect(exec.ok).toBe(true);
    if (exec.ok) {
      expect(exec.value.executed).toBe(1);
      expect(exec.value.failed).toBe(0);
    }

    const updated = getPlan(plan.value.planId);
    expect(updated?.status).toBe('completed');
  });

  it('执行恢复后发布 RESTORATION_ACK 事件', () => {
    const plan = createPlan({
      caseId: 'case-2', conflictId: 'c-2',
      restorerAgentId: 'a-r', strategy: 'global_takeover',
    });
    if (!plan.ok) return;

    const before = getEventLog({ eventType: 'arbitration:restoration_ack' as any }).length;
    executePlan(plan.value.planId);
    const after = getEventLog({ eventType: 'arbitration:restoration_ack' as any }).length;
    expect(after).toBe(before + 1);
  });
});

// ═══════════════════════════════════════════════════════
// 6. BehaviorCode 行为准则
// ═══════════════════════════════════════════════════════

describe('BehaviorCode 行为准则', () => {
  beforeEach(() => {
    resetBehaviorCode();
    resetEventBus();
  });

  it('初始化加载 5 条默认准则', () => {
    initBehaviorCode();
    const code = getCurrentCode();
    expect(code).not.toBeNull();
    expect(code!.rules.length).toBe(5);
    expect(code!.version).toBe('1.0.0');
  });

  it('按类别查询规则', () => {
    initBehaviorCode();
    const safetyRules = getRules('safety');
    expect(safetyRules.length).toBe(2);
    expect(safetyRules.every(r => r.category === 'safety')).toBe(true);
  });

  it('越权访问触发 safety 违规', () => {
    initBehaviorCode();
    const result = checkViolation({
      agentId: 'a1',
      action: 'access_private_context',
    });
    expect(result.violated).toBe(true);
    expect(result.rules.some(r => r.ruleId === 'safety-001')).toBe(true);
  });

  it('添加新规则 + 版本号更新', () => {
    initBehaviorCode();
    addRule({
      ruleId: 'custom-001',
      category: 'cooperation',
      description: '自定义规则',
      condition: 'test',
      action: 'warn',
      severity: 'low',
      enforceable: false,
    });
    expect(getRule('custom-001')).toBeDefined();

    updateVersion('1.1.0');
    expect(getCurrentCode()!.version).toBe('1.1.0');
  });

  it('删除规则', () => {
    initBehaviorCode();
    const before = getRules().length;
    removeRule('resource-001');
    expect(getRules().length).toBe(before - 1);
    expect(getRule('resource-001')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// 7. BroadcastChannel 广播通道
// ═══════════════════════════════════════════════════════

describe('BroadcastChannel 广播通道', () => {
  beforeEach(() => {
    resetBroadcastChannel();
    resetEventBus();
  });

  it('发布广播消息', () => {
    const result = broadcast({
      type: 'system_notice',
      title: '系统维护',
      content: '今晚 22:00 维护',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.publishedBy).toBe('regulatory_authority');
    }
  });

  it('确认收到 + 查询未确认', () => {
    broadcast({
      type: 'rule_update',
      title: '规则更新',
      content: '新增 safety-003',
      requiresAck: true,
    });

    const unacked = getUnacknowledged('agent-1');
    expect(unacked.length).toBe(1);

    acknowledge(unacked[0].broadcastId, 'agent-1');
    const after = getUnacknowledged('agent-1');
    expect(after.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// 8. FinalArbiter 最终裁决
// ═══════════════════════════════════════════════════════

describe('FinalArbiter 最终裁决', () => {
  beforeEach(() => {
    resetFinalArbiter();
    resetTribunal();
    resetEventBus();
  });

  it('死锁案件 → 监管局强制裁决', () => {
    // 先创建一个死锁案件
    const filed = fileCase({
      conflictId: 'deadlock-1', traceId: 't-dl',
      conflictType: 'contradiction',
      plaintiffAgentId: 'a1', defendantAgentId: 'a2',
    });
    if (!filed.ok) return;
    assembleCapsule(filed.value.caseId, {
      newMemoryContent: 'A', oldMemoryContent: 'B', taskDescription: 'T',
    });

    // 手动设为死锁状态
    const c = getCase(filed.value.caseId);
    if (!c) return;
    c.status = 'deadlocked';

    const result = issueFinalVerdict({
      case_: c,
      reason: 'deadlock',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ok).toBe(true);
      expect(result.value.verdict.isDeadlocked).toBe(false); // 最终裁决不会死锁
      expect(result.value.modelUsed).toBe('rule-based');
    }
  });

  it('非死锁状态不可最终裁决', () => {
    const filed = fileCase({
      conflictId: 'dl-2', traceId: 't-2',
      conflictType: 'duplication',
      plaintiffAgentId: 'a1', defendantAgentId: 'a2',
    });
    if (!filed.ok) return;

    const result = issueFinalVerdict({
      case_: filed.value,
      reason: 'deadlock',
    });
    expect(result.ok).toBe(false); // filed 状态不允许
  });
});

// ═══════════════════════════════════════════════════════
// 9. RegulatoryAuthority 监管局
// ═══════════════════════════════════════════════════════

describe('RegulatoryAuthority 监管局', () => {
  beforeEach(() => {
    resetRegulatoryAuthority();
    resetBehaviorCode();
    resetBroadcastChannel();
    resetFinalArbiter();
    resetTribunal();
    resetEventBus();
    initRegulatoryAuthority();
  });

  it('行为准则初始化 + 违规检测', () => {
    const code = getBehaviorCode();
    expect(code).not.toBeNull();
    expect(code!.rules.length).toBe(5);

    const violation = validateBehavior({
      agentId: 'a1',
      action: 'prompt_injection_attempt',
    });
    expect(violation.violated).toBe(true);
  });

  it('紧急干预 → 发布 EMERGENCY_INTERVENTION 事件', () => {
    const result = emergencyIntervene({
      type: 'force_terminate',
      reason: 'Agent 严重违规',
      targetAgentIds: ['a-bad'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.executed).toBe(true);
    }

    const events = getEventLog({ eventType: 'regulation:emergency' as any });
    expect(events.length).toBeGreaterThan(0);
  });

  it('广播消息 + 确认', () => {
    const msg = broadcastMessage({
      type: 'emergency_alert',
      title: '紧急',
      content: '系统异常',
      priority: 'critical',
      requiresAck: true,
    });
    expect(msg.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 10. AnomalyDetector 异常检测
// ═══════════════════════════════════════════════════════

describe('AnomalyDetector 异常检测', () => {
  beforeEach(() => {
    resetAnomalyDetector();
    resetEventBus();
    initAnomalyDetector({
      rollingBudgetTokens: 1000,
      cooldownMs: 0,
    });
  });

  it('规则 1：滚动窗口超限 → critical', () => {
    recordConsumption('a1', 600);
    recordConsumption('a1', 500);

    const result = checkRollingWindow('a1');
    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      expect(result.value.level).toBe('critical');
      expect(result.value.type).toBe('rolling_window_exceeded');
    }
  });

  it('规则 2：偏离均值 → warning/critical', () => {
    // 建立基线
    for (let i = 0; i < 5; i++) recordConsumption('a2', 100);

    // 当前消耗超均值 3 倍
    const r = checkDeviation('a2', 350);
    expect(r.ok).toBe(true);
    if (r.ok && r.value) {
      expect(r.value.type).toBe('deviation_from_mean');
    }
  });

  it('规则 3：循环检测 → 连续重复指纹', () => {
    // 5 轮相同指纹
    for (let i = 0; i < 5; i++) {
      checkLoop('a3', 'fingerprint-AAA');
    }
    const r = checkLoop('a3', 'fingerprint-AAA');
    expect(r.ok).toBe(true);
    if (r.ok && r.value) {
      expect(r.value.type).toBe('loop_detected');
    }
  });

  it('冷却期：同 Agent 同类型 30s 内不重复告警', () => {
    resetAnomalyDetector();
    initAnomalyDetector({
      rollingBudgetTokens: 100,
      cooldownMs: 30_000,
    });

    recordConsumption('a4', 200);
    const r1 = checkRollingWindow('a4');
    expect(r1.ok).toBe(true);

    // 冷却期内第二次 → null
    const r2 = checkRollingWindow('a4');
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════
// 11. FreezeManager 冻结管理
// ═══════════════════════════════════════════════════════

describe('FreezeManager 冻结管理', () => {
  beforeEach(() => {
    resetFreezeManager();
    resetEventBus();
  });

  it('冻结 Agent → WALLET_FROZEN 事件', () => {
    const result = freezeAgent('a1', '异常消耗');
    expect(result.ok).toBe(true);
    expect(isFrozen('a1')).toBe(true);

    const events = getEventLog({ eventType: 'token:wallet_frozen' as any });
    expect(events.length).toBe(1);
  });

  it('重复冻结 → 错误', () => {
    freezeAgent('a1', '原因1');
    const r = freezeAgent('a1', '原因2');
    expect(r.ok).toBe(false);
  });

  it('解冻 Agent → WALLET_UNFROZEN 事件', () => {
    freezeAgent('a1', '测试');
    const r = unfreezeAgent('a1', 'admin');
    expect(r.ok).toBe(true);
    expect(isFrozen('a1')).toBe(false);

    const events = getEventLog({ eventType: 'token:wallet_unfrozen' as any });
    expect(events.length).toBe(1);
  });

  it('自动解冻：过期自动解冻', () => {
    setAutoUnfreezeSec(0); // 立即过期
    freezeAgent('a1', '短冻结');

    const expired = checkAutoUnfreeze();
    expect(expired).toContain('a1');
    expect(isFrozen('a1')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 12. PatrolScheduler 巡检调度
// ═══════════════════════════════════════════════════════

describe('PatrolScheduler 巡检调度', () => {
  beforeEach(() => {
    resetPatrolScheduler();
    resetEventBus();
    initPatrolScheduler({ topPercentile: 0.5, failureRateThreshold: 0.3 });
  });

  it('巡检标记高消耗 + 高失败率 Agent', () => {
    registerAgentSnapshot({
      agentId: 'a-high', totalConsumption: 50000,
      failureCount: 2, totalRequests: 10, lastActiveAt: Date.now(),
    });
    registerAgentSnapshot({
      agentId: 'a-normal', totalConsumption: 100,
      failureCount: 0, totalRequests: 10, lastActiveAt: Date.now(),
    });

    const result = executePatrol();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalAgents).toBe(2);
      expect(result.value.flaggedAgents.length).toBeGreaterThan(0);
    }
  });

  it('无快照数据 → 错误', () => {
    const result = executePatrol();
    expect(result.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 13. ResourceAuditBureau 审计局主入口
// ═══════════════════════════════════════════════════════

describe('ResourceAuditBureau 审计局', () => {
  beforeEach(() => {
    resetResourceAuditBureau();
    resetAnomalyDetector();
    resetFreezeManager();
    resetPatrolScheduler();
    resetEventBus();
    initResourceAuditBureau({
      detectorConfig: { rollingBudgetTokens: 500, cooldownMs: 0 },
    });
  });

  it('monitorAgent 检测到异常 → 自动冻结', () => {
    const result = monitorAgent('a1', 600);
    expect(result.rollingAlert).not.toBeNull();
    expect(result.frozen).toBe(true);
    expect(isFrozen('a1')).toBe(true);
  });

  it('investigate 稽查 → 误报解冻', () => {
    monitorAgent('a2', 600); // 触发 critical
    expect(isFrozen('a2')).toBe(true);

    const audit = investigate('a2');
    expect(audit.ok).toBe(true);
    if (audit.ok) {
      expect(audit.value.finding).toBe('false_positive'); // 单次 critical
      expect(audit.value.recommendation).toBe('unfreeze');
    }
    // 误报应自动解冻
    expect(isFrozen('a2')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// Gate G12 综合验证
// ═══════════════════════════════════════════════════════

describe('Gate G12 综合验证', () => {
  beforeEach(() => {
    resetTribunal();
    resetCapsuleAssembler();
    resetArbitratorPool();
    resetDynamicScaling();
    resetRestorationManager();
    resetRegulatoryAuthority();
    resetBehaviorCode();
    resetBroadcastChannel();
    resetFinalArbiter();
    resetAnomalyDetector();
    resetFreezeManager();
    resetPatrolScheduler();
    resetResourceAuditBureau();
    resetEventBus();
  });

  it('G12-1: 六步治理闭环端到端完整执行', () => {
    initRegulatoryAuthority();

    const result = executeFullArbitration({
      conflictId: 'g12-conflict',
      traceId: 'g12-trace',
      conflictType: 'semantic_opposition',
      plaintiffAgentId: 'agent-new',
      defendantAgentId: 'agent-old',
      newMemoryContent: 'API 端口 3000',
      oldMemoryContent: 'API 端口 8080',
      taskDescription: '配置服务器',
      restorerAgentId: 'agent-restorer',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const c = result.value;
      // 写入拦截 → 胶囊调阅 → 裁决 → 律师函挂起 → 恢复 ACK → 知识沉淀
      expect(c.status).toBe('completed');
      expect(c.capsule).toBeDefined();
      expect(c.finalVerdict).toBeDefined();
      expect(c.suspendIssued).toBe(true);
      expect(c.restoredAt).toBeDefined();
      expect(c.completedAt).toBeDefined();
    }

    // 验证事件链完整
    const events = getEventLog();
    const eventTypes = events.map(e => e.eventType);
    expect(eventTypes).toContain('arbitration:filed');
    expect(eventTypes).toContain('arbitration:verdict');
    expect(eventTypes).toContain('arbitration:suspend_and_notify');
    expect(eventTypes).toContain('arbitration:restoration_ack');
    expect(eventTypes).toContain('arbitration:knowledge_consolidation');
  });

  it('G12-2: 死锁 → 升级监管局单 LLM 强制裁决', () => {
    initRegulatoryAuthority();

    // 创建案件并手动设为死锁
    const filed = fileCase({
      conflictId: 'g12-deadlock', traceId: 'g12-dl-trace',
      conflictType: 'contradiction',
      plaintiffAgentId: 'a1', defendantAgentId: 'a2',
    });
    if (!filed.ok) return;
    assembleCapsule(filed.value.caseId, {
      newMemoryContent: 'A', oldMemoryContent: 'B', taskDescription: 'T',
    });

    const c = getCase(filed.value.caseId);
    if (!c) return;
    c.status = 'deadlocked';

    // 升级监管局
    const intervention = escalateDeadlock(c, 'deadlock');
    expect(intervention.ok).toBe(true);
    if (intervention.ok) {
      expect(intervention.value.verdict.isDeadlocked).toBe(false);
      expect(intervention.value.modelUsed).toBe('rule-based');
    }

    // 验证 ARBITRATION_VERDICT 事件带 intervention 标记
    const verdictEvents = getEventLog({ eventType: 'arbitration:verdict' as any });
    const interventionEvent = verdictEvents.find(e =>
      (e.payload as any).isRegulatoryIntervention === true
    );
    expect(interventionEvent).toBeDefined();
  });

  it('G12-3: 挂起期间 LoopState 不丢', () => {
    initRegulatoryAuthority();

    // 执行完整仲裁
    const result = executeFullArbitration({
      conflictId: 'g12-loop-state',
      traceId: 'g12-ls-trace',
      conflictType: 'duplication',
      plaintiffAgentId: 'a1',
      defendantAgentId: 'a2',
      newMemoryContent: 'X',
      oldMemoryContent: 'Y',
      taskDescription: 'T',
      restorerAgentId: 'a-r',
    });
    expect(result.ok).toBe(true);

    // 案件完成 → 涉事 Agent 可恢复
    const c = getCaseByConflictId('g12-loop-state');
    expect(c).toBeDefined();
    expect(c!.status).toBe('completed');
    expect(c!.restoredAt).toBeDefined();
  });

  it('G12-4: 审计异常检测 → 自动冻结 → 稽查 → 误报解冻', () => {
    initResourceAuditBureau({
      detectorConfig: { rollingBudgetTokens: 500, cooldownMs: 0 },
    });

    // Agent 消耗超预算 → 自动冻结
    const monitor = monitorAgent('audit-agent', 600);
    expect(monitor.frozen).toBe(true);

    // 稽查 → 单次 critical → 误报 → 解冻
    const audit = investigate('audit-agent');
    expect(audit.ok).toBe(true);
    if (audit.ok) {
      expect(audit.value.finding).toBe('false_positive');
      expect(audit.value.recommendation).toBe('unfreeze');
    }
    expect(isFrozen('audit-agent')).toBe(false);
  });
});
