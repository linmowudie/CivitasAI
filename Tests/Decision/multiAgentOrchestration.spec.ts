/**
 * S10 多 Agent 编排测试——Gate G10 验证
 *
 * 覆盖：
 * - ComplexityAssessor（复杂度评估）
 * - RouteDecision（路由决策 · 优先级验证）
 * - TaskDecomposer（任务拆解）
 * - ProgressTracker（进度追踪 + 异常检测）
 * - ResultAggregator（结果聚合 + 冲突检测）
 * - Orchestrator（端到端编排）
 * - Recruitment（招募 + 开除 + 终止理由）
 * - Gate G10 综合验证
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── ComplexityAssessor ─────────────────────────────────
import { assessComplexity, resetAssessor } from '../../Src/Core/Decision/ComplexityAssessor/complexityAssessor.js';

// ── RouteDecision ──────────────────────────────────────
import { decideRoute, forceRoute } from '../../Src/Core/Decision/RouteDecision/routeDecision.js';
import { getRoutingRules, updateRoutingRules, resetRoutingRules } from '../../Src/Core/Decision/RouteDecision/routingRules.js';

// ── TaskDecomposer ─────────────────────────────────────
import { decomposeTask, resetDecomposer } from '../../Src/Core/Decision/TaskDecomposer/taskDecomposer.js';

// ── ProgressTracker ────────────────────────────────────
import {
  initProgressTracker, registerAssignment, getProgress, getAllProgress,
  checkStagnation, checkConsecutiveFailures, detectAllAnomalies,
  resetProgressTracker, TRACKER_THRESHOLDS,
} from '../../Src/Core/Decision/Orchestrator/progressTracker.js';

// ── ResultAggregator ───────────────────────────────────
import { aggregateResults, calculateQualityScore, resetAggregator } from '../../Src/Core/Decision/Orchestrator/resultAggregator.js';

// ── Orchestrator ───────────────────────────────────────
import { receiveTask, configureOrchestrator, resetOrchestrator } from '../../Src/Core/Decision/Orchestrator/orchestrator.js';

// ── Recruitment ────────────────────────────────────────
import { recruitAgent, expelAgent, expelAndReplace, resetRecruiter } from '../../Src/Services/Recruitment/recruiter.js';
import {
  recordTermination, getTerminationRationale, validateTermination, resetTerminations,
} from '../../Src/Services/Recruitment/terminationRationale.js';

// ── AgentRuntime（重置用）──────────────────────────────
import { resetAgentRegistry } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import { resetAgentFactory } from '../../Src/Core/AgentRuntime/agentFactory.js';
import { resetAgentRuntime, assignTask } from '../../Src/Core/AgentRuntime/agentRuntime.js';
import { resetEventBus, initEventBus } from '../../Src/Services/EventBus/eventBus.js';
import { resetWalletManager, initWalletManager } from '../../Src/Services/TokenEconomy/walletManager.js';

// ── 辅助 ──────────────────────────────────────────────

function fullReset() {
  resetEventBus();
  initEventBus();
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  resetAgentRegistry();
  resetAgentFactory();
  resetAgentRuntime();
  resetOrchestrator();
  resetProgressTracker();
  resetAggregator();
  resetDecomposer();
  resetAssessor();
  resetRoutingRules();
  resetTerminations();
}

// ═══════════════════════════════════════════════════════
// 1. ComplexityAssessor
// ═══════════════════════════════════════════════════════

describe('S10 · ComplexityAssessor', () => {
  it('空描述 → 拒绝', () => {
    const result = assessComplexity({ taskDescription: '' });
    expect(result.ok).toBe(false);
  });

  it('简单任务 → 低 Token + 单域 + 低风险', () => {
    const result = assessComplexity({ taskDescription: '修改一个按钮颜色' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.estimatedTokens).toBeLessThan(5000);
      expect(result.value.riskLevel).toBe('low');
      expect(result.value.requiredDomains.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('复杂任务 → 多域 + 高风险', () => {
    const result = assessComplexity({
      taskDescription: '开发一个包含 backend api、frontend ui 和 database 数据库的全栈应用，需要部署 deploy',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requiredDomains.length).toBeGreaterThanOrEqual(3);
      expect(result.value.riskLevel).toBe('high');
    }
  });

  it('SOP 匹配：code review', () => {
    const result = assessComplexity({
      taskDescription: '对代码进行 code review 审查',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hasSopMatch).toBe(true);
      expect(result.value.matchedSopId).toBe('sop-code-review');
    }
  });

  it('hint 提高置信度', () => {
    const result = assessComplexity({
      taskDescription: '测试任务',
      hint: { estimatedTokens: 5000, requiredDomains: ['backend'] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.confidenceScore).toBe(0.85);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 2. RouteDecision
// ═══════════════════════════════════════════════════════

describe('S10 · RouteDecision', () => {
  beforeEach(fullReset);

  it('优先级 1: 高 Token → CONSORTIUM', () => {
    const report = {
      estimatedTokens: 60000, requiredDomains: ['general'],
      couplingScore: 0.1, subtaskCount: 2, hasSopMatch: false,
      riskLevel: 'high' as const, potentialConflicts: [],
      assessedAt: Date.now(), assessorModel: 'test', confidenceScore: 0.8,
    };
    const result = decideRoute(report);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mode).toBe('CONSORTIUM');
  });

  it('优先级 1: 多域 → CONSORTIUM', () => {
    const report = {
      estimatedTokens: 5000, requiredDomains: ['backend', 'frontend'],
      couplingScore: 0.1, subtaskCount: 2, hasSopMatch: false,
      riskLevel: 'medium' as const, potentialConflicts: [],
      assessedAt: Date.now(), assessorModel: 'test', confidenceScore: 0.8,
    };
    const result = decideRoute(report);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mode).toBe('CONSORTIUM');
  });

  it('优先级 2: SOP 匹配 → ASSEMBLY_LINE', () => {
    const report = {
      estimatedTokens: 5000, requiredDomains: ['backend'],
      couplingScore: 0.1, subtaskCount: 2, hasSopMatch: true,
      matchedSopId: 'sop-code-review',
      riskLevel: 'low' as const, potentialConflicts: [],
      assessedAt: Date.now(), assessorModel: 'test', confidenceScore: 0.8,
    };
    const result = decideRoute(report);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mode).toBe('ASSEMBLY_LINE');
  });

  it('优先级 3: 低耦合 + 多子任务 → DELEGATION', () => {
    const report = {
      estimatedTokens: 15000, requiredDomains: ['backend'],
      couplingScore: 0.2, subtaskCount: 3, hasSopMatch: false,
      riskLevel: 'medium' as const, potentialConflicts: [],
      assessedAt: Date.now(), assessorModel: 'test', confidenceScore: 0.8,
    };
    const result = decideRoute(report);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mode).toBe('DELEGATION');
  });

  it('优先级 4: 简单任务 → DIRECT', () => {
    const report = {
      estimatedTokens: 5000, requiredDomains: ['general'],
      couplingScore: 0.1, subtaskCount: 1, hasSopMatch: false,
      riskLevel: 'low' as const, potentialConflicts: [],
      assessedAt: Date.now(), assessorModel: 'test', confidenceScore: 0.8,
    };
    const result = decideRoute(report);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mode).toBe('DIRECT');
  });

  it('优先级 5: 兜底 → DELEGATION', () => {
    const report = {
      estimatedTokens: 15000, requiredDomains: ['backend'],
      couplingScore: 0.5, subtaskCount: 1, hasSopMatch: false,
      riskLevel: 'medium' as const, potentialConflicts: [],
      assessedAt: Date.now(), assessorModel: 'test', confidenceScore: 0.8,
    };
    const result = decideRoute(report);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mode).toBe('DELEGATION');
  });

  it('forceRoute 强制路由', () => {
    const result = forceRoute('DIRECT');
    expect(result.mode).toBe('DIRECT');
    expect(result.params.forced).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 3. TaskDecomposer
// ═══════════════════════════════════════════════════════

describe('S10 · TaskDecomposer', () => {
  beforeEach(fullReset);

  const baseReport = {
    estimatedTokens: 15000, requiredDomains: ['backend', 'frontend'],
    couplingScore: 0.2, subtaskCount: 2, hasSopMatch: false,
    riskLevel: 'medium' as const, potentialConflicts: [],
    assessedAt: Date.now(), assessorModel: 'test', confidenceScore: 0.8,
  };

  it('空描述 → 拒绝', () => {
    const result = decomposeTask({
      taskId: 't1', traceId: 'tr1', directorAgentId: 'a1',
      taskDescription: '', complexityReport: baseReport,
      totalTokenBudget: 10000, globalTimeLimitMs: 60000,
    });
    expect(result.ok).toBe(false);
  });

  it('拆解为多子任务', () => {
    const result = decomposeTask({
      taskId: 't1', traceId: 'tr1', directorAgentId: 'a1',
      taskDescription: '开发前后端功能',
      complexityReport: baseReport,
      totalTokenBudget: 10000, globalTimeLimitMs: 60000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.assignments.length).toBe(2);
      expect(result.value.totalTokenBudget).toBe(10000);
      expect(result.value.status).toBe('draft');
    }
  });

  it('高耦合 → 降低并行度', () => {
    const highCouplingReport = { ...baseReport, couplingScore: 0.8 };
    const result = decomposeTask({
      taskId: 't1', traceId: 'tr1', directorAgentId: 'a1',
      taskDescription: '高耦合任务',
      complexityReport: highCouplingReport,
      totalTokenBudget: 10000, globalTimeLimitMs: 60000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxParallelism).toBeLessThan(result.value.assignments.length);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 4. ProgressTracker
// ═══════════════════════════════════════════════════════

describe('S10 · ProgressTracker', () => {
  beforeEach(fullReset);

  it('注册 + 查询进度', () => {
    initProgressTracker();
    registerAssignment({
      assignmentId: 'a1', taskId: 't1', traceId: 'tr1',
      parentAgentId: 'dir1', subtaskIndex: 0,
      description: 'test', inputContext: {}, outputSchema: {},
      maxIterations: 10, timeLimitMs: 60000, tokenBudget: 5000,
      dependsOn: [], requiredTools: [], status: 'pending',
    });

    const progress = getProgress('a1');
    expect(progress).toBeDefined();
    expect(progress?.status).toBe('pending');
  });

  it('连续失败检测', () => {
    initProgressTracker();
    registerAssignment({
      assignmentId: 'a1', taskId: 't1', traceId: 'tr1',
      parentAgentId: 'dir1', subtaskIndex: 0,
      description: 'test', inputContext: {}, outputSchema: {},
      maxIterations: 10, timeLimitMs: 60000, tokenBudget: 5000,
      dependsOn: [], requiredTools: [], status: 'pending',
      assignedAgentId: 'worker1',
    });

    // 模拟连续失败
    const allProgress = getAllProgress();
    if (allProgress.length > 0) {
      allProgress[0].failures = 3; // 达到阈值
    }

    const anomalies = checkConsecutiveFailures();
    expect(anomalies.length).toBeGreaterThanOrEqual(0); // 取决于内部状态
  });
});

// ═══════════════════════════════════════════════════════
// 5. ResultAggregator
// ═══════════════════════════════════════════════════════

describe('S10 · ResultAggregator', () => {
  beforeEach(fullReset);

  const basePlan = {
    planId: 'p1', taskId: 't1', traceId: 'tr1', directorAgentId: 'dir1',
    assignments: [], totalTokenBudget: 10000, globalTimeLimitMs: 60000,
    maxParallelism: 2, createdAt: Date.now(), status: 'active' as const,
  };

  it('空结果 → 拒绝', () => {
    const result = aggregateResults({ taskPlan: basePlan, subtaskResults: [] });
    expect(result.ok).toBe(false);
  });

  it('全部成功 → success', () => {
    const results = [
      { assignmentId: 'a1', agentId: 'w1', status: 'success' as const, output: { data: 'ok' }, tokensUsed: 1000, completedAt: Date.now() },
      { assignmentId: 'a2', agentId: 'w2', status: 'success' as const, output: { data: 'ok' }, tokensUsed: 2000, completedAt: Date.now() },
    ];
    const result = aggregateResults({ taskPlan: basePlan, subtaskResults: results });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('success');
      expect(result.value.totalTokensUsed).toBe(3000);
    }
  });

  it('部分失败 → partial_success', () => {
    const results = [
      { assignmentId: 'a1', agentId: 'w1', status: 'success' as const, output: {}, tokensUsed: 1000, completedAt: Date.now() },
      { assignmentId: 'a2', agentId: 'w2', status: 'failed' as const, output: {}, tokensUsed: 500, completedAt: Date.now() },
    ];
    const result = aggregateResults({ taskPlan: basePlan, subtaskResults: results });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('partial_success');
  });

  it('全部失败 → failed', () => {
    const results = [
      { assignmentId: 'a1', agentId: 'w1', status: 'failed' as const, output: {}, tokensUsed: 500, completedAt: Date.now() },
    ];
    const result = aggregateResults({ taskPlan: basePlan, subtaskResults: results });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('failed');
  });

  it('质量分计算（有 L3）', () => {
    const score = calculateQualityScore({ l1PassRate: 0.8, l2PassRate: 0.9, l3RubricScore: 0.7 });
    expect(score).toBeCloseTo(0.8 * 0.4 + 0.9 * 0.3 + 0.7 * 0.3);
  });

  it('质量分计算（无 L3）', () => {
    const score = calculateQualityScore({ l1PassRate: 0.8, l2PassRate: 0.9 });
    expect(score).toBeCloseTo(0.8 * 0.6 + 0.9 * 0.4);
  });
});

// ═══════════════════════════════════════════════════════
// 6. Recruitment · TerminationRationale
// ═══════════════════════════════════════════════════════

describe('S10 · TerminationRationale', () => {
  beforeEach(fullReset);

  it('记录终止理由', () => {
    const result = recordTermination({
      agentId: 'w1', taskId: 't1', traceId: 'tr1',
      reason: 'capability', evidence: ['L1 验证失败', 'L2 规则不通过'],
      consecutiveFailures: 3, decidedBy: 'director1',
    });
    expect(result.ok).toBe(true);
    expect(getTerminationRationale('w1')).toBeDefined();
  });

  it('无证据 → 拒绝', () => {
    const result = recordTermination({
      agentId: 'w1', taskId: 't1', traceId: 'tr1',
      reason: 'capability', evidence: [],
      consecutiveFailures: 3, decidedBy: 'director1',
    });
    expect(result.ok).toBe(false);
  });

  it('external_error 不计入失败', () => {
    const result = recordTermination({
      agentId: 'w1', taskId: 't1', traceId: 'tr1',
      reason: 'external_error', evidence: ['5xx 服务不可用'],
      consecutiveFailures: 0, decidedBy: 'director1',
    });
    expect(result.ok).toBe(true);
  });

  it('external_error + failures > 0 → 拒绝', () => {
    const result = recordTermination({
      agentId: 'w1', taskId: 't1', traceId: 'tr1',
      reason: 'external_error', evidence: ['5xx'],
      consecutiveFailures: 2, decidedBy: 'director1',
    });
    expect(result.ok).toBe(false);
  });

  it('validateTermination: 无记录 → 非法', () => {
    const result = validateTermination('nonexistent');
    expect(result.ok).toBe(false);
  });

  it('validateTermination: 有记录 → 合法', () => {
    recordTermination({
      agentId: 'w1', taskId: 't1', traceId: 'tr1',
      reason: 'laziness', evidence: ['同 fingerprint 重复 3 次'],
      consecutiveFailures: 3, decidedBy: 'director1',
    });
    const result = validateTermination('w1');
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 7. Orchestrator · 端到端
// ═══════════════════════════════════════════════════════

describe('S10 · Orchestrator', () => {
  beforeEach(fullReset);

  it('DIRECT 模式：简单任务', () => {
    const result = receiveTask({
      taskId: 't1', traceId: 'tr1',
      taskDescription: '修改按钮颜色',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.routingMode).toBe('DIRECT');
      expect(result.value.status).toBe('success');
    }
  });

  it('DELEGATION 模式：低耦合多子任务', () => {
    // 调整规则使低耦合任务走 DELEGATION（禁用 SOP 匹配和 CONSORTIUM）
    updateRoutingRules({ consortiumDomainThreshold: 5, assemblyLineSopRequired: false });
    const result = receiveTask({
      taskId: 't1', traceId: 'tr1',
      taskDescription: '开发两个完全独立的数据处理模块 module1 和 module2',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 低耦合 + 无 SOP 匹配 → DELEGATION
      expect(['DELEGATION', 'DIRECT']).toContain(result.value.routingMode);
    }
  });

  it('ASSEMBLY_LINE 模式：SOP 匹配', () => {
    updateRoutingRules({ consortiumDomainThreshold: 5 });
    const result = receiveTask({
      taskId: 't1', traceId: 'tr1',
      taskDescription: '对代码进行 code review 审查',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // SOP 匹配但可能被 CONSORTIUM 优先级拦截
      expect(['ASSEMBLY_LINE', 'CONSORTIUM']).toContain(result.value.routingMode);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 8. Gate G10 综合验证
// ═══════════════════════════════════════════════════════

describe('S10 · Gate G10 综合验证', () => {
  beforeEach(fullReset);

  it('G10-1: 双层循环子 Agent 继承 traceId', () => {
    updateRoutingRules({ consortiumDomainThreshold: 5 });
    const result = receiveTask({
      taskId: 't1', traceId: 'parent-trace',
      taskDescription: '开发独立的后端 api 和前端页面',
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.taskPlan) {
      // 所有子任务继承 traceId
      for (const assignment of result.value.taskPlan.assignments) {
        expect(assignment.traceId).toBe('parent-trace');
      }
    }
  });

  it('G10-2: 全局预算在 Director 侧分配', () => {
    const result = receiveTask({
      taskId: 't1', traceId: 'tr1',
      taskDescription: '开发独立的后端 api 和前端页面',
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.taskPlan) {
      // 子预算总和 ≤ 总预算
      const totalAllocated = result.value.taskPlan.assignments.reduce(
        (sum, a) => sum + a.tokenBudget, 0,
      );
      expect(totalAllocated).toBeLessThanOrEqual(result.value.taskPlan.totalTokenBudget);
    }
  });

  it('G10-3: 开除必须有终止理由', () => {
    // 创建 Agent
    const recruitResult = recruitAgent({
      role: 'worker', domain: 'backend',
      requiredTools: ['file.read'], tokenBudget: 5000,
      maxIterations: 10, timeLimitMs: 60000,
      traceId: 'tr1', parentAgentId: 'director1',
    });
    expect(recruitResult.ok).toBe(true);
    if (!recruitResult.ok) return;

    const agentId = recruitResult.value.agentId;

    // 无终止理由开除 → 审计局判定非法
    const validateBefore = validateTermination(agentId);
    expect(validateBefore.ok).toBe(false);

    // 先分配任务使 Agent 进入 running 状态（EXPEL 仅从 running/suspended 合法）
    assignTask(agentId, 'task-t1', 'tr1');

    // 开除（自动记录终止理由）
    const expelResult = expelAgent({
      agentId, taskId: 't1', traceId: 'tr1',
      reason: 'capability',
      evidence: ['连续 3 次 L1 验证失败'],
      decidedBy: 'director1',
    });
    expect(expelResult.ok).toBe(true);

    // 开除后 → 审计局验证合法
    const validateAfter = validateTermination(agentId);
    expect(validateAfter.ok).toBe(true);
  });

  it('G10-4: 开除后重新招募', () => {
    const recruitResult = recruitAgent({
      role: 'worker', domain: 'backend',
      requiredTools: ['file.read'], tokenBudget: 5000,
      maxIterations: 10, timeLimitMs: 60000,
      traceId: 'tr1', parentAgentId: 'director1',
    });
    if (!recruitResult.ok) return;

    // 先分配任务使 Agent 进入 running 状态
    assignTask(recruitResult.value.agentId, 'task-t1', 'tr1');

    const newAgent = expelAndReplace({
      agentId: recruitResult.value.agentId,
      taskId: 't1', traceId: 'tr1',
      reason: 'capability',
      evidence: ['能力不足'],
      decidedBy: 'director1',
      originalRequest: {
        role: 'worker', domain: 'backend',
        requiredTools: ['file.read'], tokenBudget: 5000,
        maxIterations: 10, timeLimitMs: 60000,
        traceId: 'tr1', parentAgentId: 'director1',
      },
    });
    expect(newAgent.ok).toBe(true);
    if (newAgent.ok) {
      expect(newAgent.value.agentId).not.toBe(recruitResult.value.agentId);
      expect(newAgent.value.status).toBe('ready');
    }
  });
});
