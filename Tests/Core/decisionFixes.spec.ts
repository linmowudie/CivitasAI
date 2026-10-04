/**
 * FE-070 回归测试：决策与输出简化项修复
 *
 * 覆盖：
 *  - TaskDecomposer：高耦合依赖回填**真实 assignmentId**（消除 assign-current 占位串）；
 *  - stopRules：`signal == "值"` 精确语法 + 风险触发器经 evaluateStopRules 真实触发；
 *  - complexityAssessor：SOP 模板外部化注入（configureAssessor / resetAssessorSops）；
 *  - postSupervision：archived 假标记诚实化为 false。
 *
 * 说明：纯单元，无网络/数据库依赖。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { decomposeTask, resetDecomposer } from '../../Src/Core/Decision/TaskDecomposer/taskDecomposer.js';
import type { ComplexityReport } from '../../Src/Core/Decision/types.js';
import {
  evaluateStopRules, buildStopRuleSet, getEvaluationOrder,
} from '../../Src/Services/LoopControl/stopRules.js';
import type { LoopRuntimeSnapshot } from '../../Src/Services/LoopControl/stopRules.js';
import { createInitialLoopState } from '../../Src/Services/LoopControl/loopState.js';
import {
  assessComplexity, configureAssessor, resetAssessorSops,
} from '../../Src/Core/Decision/complexityAssessor/complexityAssessor.js';
import { runPostSupervision } from '../../Src/Services/Supervision/postSupervision.js';

// ── 脚手架 ──────────────────────────────────────────────────────────

function makeReport(overrides: Partial<{
  subtaskCount: number; couplingScore: number; requiredDomains: string[];
}> = {}): ComplexityReport {
  return {
    taskId: 'task-fe070',
    estimatedTokens: 20000,
    requiredDomains: overrides.requiredDomains ?? ['backend'],
    subtaskCount: overrides.subtaskCount ?? 3,
    couplingScore: overrides.couplingScore ?? 0.8,
    hasSopMatch: false,
    riskLevel: 'medium',
  } as unknown as ComplexityReport;
}

function makeSnapshot(overrides: Partial<LoopRuntimeSnapshot> = {}): LoopRuntimeSnapshot {
  return {
    iteration: 0,
    startedAt: Date.now(),
    toolCallCount: 0,
    consecutiveErrors: 0,
    budgetUsed: { tokens: 0, usd: 0 },
    recentMetrics: [],
    riskSignals: [],
    verifierPassed: false,
    ...overrides,
  };
}

beforeEach(() => {
  resetDecomposer();
  resetAssessorSops();
});

afterEach(() => {
  resetAssessorSops();
});

// ═══════════════════════════════════════════════════════════════════
// 1. TaskDecomposer 依赖回填
// ═══════════════════════════════════════════════════════════════════

describe('FE-070 · TaskDecomposer 依赖回填', () => {
  it('高耦合：dependsOn 为真实 assignmentId（无 assign-current 占位串）', () => {
    const result = decomposeTask({
      taskId: 'task-fe070',
      traceId: 'trace-fe070',
      directorAgentId: 'agent-director',
      taskDescription: '实现后端与前端并集成',
      complexityReport: makeReport({ couplingScore: 0.8, subtaskCount: 3 }),
      totalTokenBudget: 30000,
      globalTimeLimitMs: 60000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.assignments.map(a => a.assignmentId);
    expect(ids).toEqual(['assign-task-fe070-0', 'assign-task-fe070-1', 'assign-task-fe070-2']);

    // 第 0 个无依赖；后续各自依赖前一个的**真实 ID**
    expect(result.value.assignments[0]!.dependsOn).toEqual([]);
    expect(result.value.assignments[1]!.dependsOn).toEqual(['assign-task-fe070-0']);
    expect(result.value.assignments[2]!.dependsOn).toEqual(['assign-task-fe070-1']);

    // 全量断言：无任何占位串残留
    const allDeps = result.value.assignments.flatMap(a => a.dependsOn);
    expect(allDeps.some(d => d.includes('assign-current'))).toBe(false);
  });

  it('低耦合：完全并行（无依赖）', () => {
    const result = decomposeTask({
      taskId: 'task-fe070b',
      traceId: 'trace-fe070b',
      directorAgentId: 'agent-director',
      taskDescription: '独立模块并行开发',
      complexityReport: makeReport({ couplingScore: 0.2, subtaskCount: 3 }),
      totalTokenBudget: 30000,
      globalTimeLimitMs: 60000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assignments.every(a => a.dependsOn.length === 0)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. 风险触发器（signal == 语法 + 真实触发）
// ═══════════════════════════════════════════════════════════════════

describe('FE-070 · 风险触发器', () => {
  function makeRules() {
    return buildStopRuleSet({
      tokenBudget: 100_000,
      softRatio: 0.6, hardRatio: 1.0, warmRatio: 0.36, expandRequestRatio: 0.8,
      limits: { maxIterations: 30, maxWallClockMs: 600000, maxToolCalls: 100, maxConsecutiveErrors: 5 },
      noProgress: { metric: 'custom', stagnationWindow: 5, minDelta: 0.01, action: 'switch_strategy' },
      riskTriggers: [
        { condition: 'signal == "UNRECOVERABLE_TOOL_ERROR"', action: 'abort' },
      ],
    });
  }

  it('riskSignals 含信号 → risk 退出（signal == 精确语法生效）', () => {
    const state = createInitialLoopState({
      loopId: 'l', traceId: 't',
      goal: { originalRequirement: 'x', successCriteria: [], immutableConstraints: [] },
    });
    const decision = evaluateStopRules(
      makeRules(), state,
      makeSnapshot({ riskSignals: ['UNRECOVERABLE_TOOL_ERROR'] }),
    );
    expect(decision.shouldStop).toBe(true);
    if (decision.shouldStop) {
      expect(decision.reason).toBe('risk');
    }
  });

  it('空信号 → 不触发；未被触发器覆盖的信号 → 保守退出（fail-safe）', () => {
    const state = createInitialLoopState({
      loopId: 'l', traceId: 't',
      goal: { originalRequirement: 'x', successCriteria: [], immutableConstraints: [] },
    });
    // 空信号
    const none = evaluateStopRules(makeRules(), state, makeSnapshot({ riskSignals: [] }));
    expect(none.shouldStop).toBe(false);

    // 未覆盖信号（触发器仅声明 UNRECOVERABLE_TOOL_ERROR）→ 保守退出
    const uncovered = evaluateStopRules(
      makeRules(), state,
      makeSnapshot({ riskSignals: ['SOME_OTHER_SIGNAL'] }),
    );
    expect(uncovered.shouldStop).toBe(true);
    if (uncovered.shouldStop) expect(uncovered.reason).toBe('risk');
  });

  it('pause_and_request_approval 类触发器命中 → 本层不中止（交审批门）', () => {
    const state = createInitialLoopState({
      loopId: 'l', traceId: 't',
      goal: { originalRequirement: 'x', successCriteria: [], immutableConstraints: [] },
    });
    const pausedRules = buildStopRuleSet({
      tokenBudget: 100_000,
      softRatio: 0.6, hardRatio: 1.0, warmRatio: 0.36, expandRequestRatio: 0.8,
      limits: { maxIterations: 30, maxWallClockMs: 600000, maxToolCalls: 100, maxConsecutiveErrors: 5 },
      noProgress: { metric: 'custom', stagnationWindow: 5, minDelta: 0.01, action: 'switch_strategy' },
      riskTriggers: [
        { condition: 'signal == "PAUSE_REQUIRED"', action: 'pause_and_request_approval' },
      ],
    });
    const decision = evaluateStopRules(
      pausedRules, state,
      makeSnapshot({ riskSignals: ['PAUSE_REQUIRED'] }),
    );
    expect(decision.shouldStop).toBe(false);
  });

  it('评估顺序导出稳定（risk 最优先语义保持）', () => {
    expect(getEvaluationOrder()[0]).toBe('risk');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. SOP 模板外部化
// ═══════════════════════════════════════════════════════════════════

describe('FE-070 · SOP 模板外部化', () => {
  it('configureAssessor 注入自定义 SOP → 评估命中自定义 id；reset 恢复内置', () => {
    configureAssessor({
      knownSops: [{ id: 'sop-custom-deploy', keywords: ['部署手册', '灰度发布'], domain: 'devops' }],
    });

    const custom = assessComplexity({ taskDescription: '按部署手册执行灰度发布流程' });
    expect(custom.ok).toBe(true);
    if (custom.ok) {
      expect(custom.value.hasSopMatch).toBe(true);
      expect(custom.value.matchedSopId).toBe('sop-custom-deploy');
    }

    resetAssessorSops();
    const back = assessComplexity({ taskDescription: '按部署手册执行灰度发布流程' });
    expect(back.ok).toBe(true);
    if (back.ok) {
      // 内置模板无这两关键词 → 不再命中自定义 SOP
      expect(back.value.matchedSopId).not.toBe('sop-custom-deploy');
    }

    // 内置模板仍可命中（回归）
    const builtin = assessComplexity({ taskDescription: '请 review 这段 API 代码 接口设计' });
    expect(builtin.ok).toBe(true);
    if (builtin.ok) {
      expect(builtin.value.hasSopMatch).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. postSupervision 归档标记诚实化
// ═══════════════════════════════════════════════════════════════════

describe('FE-070 · archived 诚实化', () => {
  it('archived 如实返回 false（真实归档由事件持久化/checkpoint 承担）', () => {
    const result = runPostSupervision({
      outputText: '完成',
      toolResults: [],
      tokensConsumed: 100,
      totalTokensConsumed: 100,
      tokenBudget: 10000,
      currentIteration: 1,
      maxIterations: 30,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.archived).toBe(false);
    }
  });
});
