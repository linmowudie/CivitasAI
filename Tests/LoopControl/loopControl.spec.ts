/**
 * S6 Loop 控制系统测试——Gate G6 验证
 *
 * 覆盖：
 * - LoopState（不可变区保护 · ADR-0005）
 * - StopRules（五类独立退出 · 优先级链）
 * - Verifier（四级分层 · ADR-0003/0004）
 * - ActionFingerprint（四规则检测 · 重叠仲裁）
 * - StrategyLedger（策略记录 · 换策略）
 * - FailureFeedback（可行动反馈 · P5）
 * - ApprovalGate（审批门 · 超时默认拒绝）
 * - Middleware（5 个控制中间件）
 * - Gate G6 综合验证
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── LoopState ──────────────────────────────────────────
import {
  createInitialLoopState, setGoalImmutable, verifyGoalIntegrity,
  hashGoal, cloneImmutableZone,
} from '../../Src/Services/LoopControl/loopState.js';
import type { LoopState } from '../../Src/Services/LoopControl/loopState.js';

// ── StopRules ──────────────────────────────────────────
import {
  evaluateStopRules, detectBudgetPhase, buildStopRuleSet, getEvaluationOrder,
} from '../../Src/Services/LoopControl/stopRules.js';
import type { StopRuleSet, LoopRuntimeSnapshot } from '../../Src/Services/LoopControl/stopRules.js';

// ── Verifier ───────────────────────────────────────────
import { runHardVerification } from '../../Src/Services/LoopControl/verifier/hardVerifier.js';
import { runRuleVerification } from '../../Src/Services/LoopControl/verifier/ruleVerifier.js';
import { runLlmJudge } from '../../Src/Services/LoopControl/verifier/llmJudge.js';
import { runVerifierPipeline } from '../../Src/Services/LoopControl/verifier/index.js';
import { validateAntiGaming, checkAntiGaming } from '../../Src/Services/LoopControl/verifier/antiGaming.js';

// ── ActionFingerprint ──────────────────────────────────
import {
  computeFingerprint, canonicalJson, detectFingerprintAction, recordFingerprint,
} from '../../Src/Services/LoopControl/actionFingerprint.js';

// ── StrategyLedger ─────────────────────────────────────
import {
  validateTurnStrategy, recordStrategy, getStrategies,
  getFailedStrategies, selectNextStrategy, clearLedger,
  backfillStrategyResult,
} from '../../Src/Services/LoopControl/strategyLedger.js';

// ── FailureFeedback ────────────────────────────────────
import {
  buildFailureFeedback, feedbackToToolResult,
} from '../../Src/Services/LoopControl/failureFeedback.js';

// ── ApprovalGate ───────────────────────────────────────
import {
  createApproval, registerApproval, decideApproval,
  checkTimeoutApprovals, getPendingApprovals, clearApprovalQueue,
} from '../../Src/Services/LoopControl/approvalGate.js';

// ── Middleware ──────────────────────────────────────────
import { createGoalReanchorControlMiddleware } from '../../Src/Services/LoopControl/middleware/goalReanchorControl.js';
import { createCheckpointWriterMiddleware, clearCheckpointStore, getLatestCheckpoint } from '../../Src/Services/LoopControl/middleware/checkpointWriter.js';

// ── 辅助函数 ───────────────────────────────────────────

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    ...createInitialLoopState({
      loopId: 'test-loop-1',
      traceId: 'trace-1',
      goal: {
        originalRequirement: '实现一个计数器组件',
        successCriteria: [{ level: 'L1', kind: 'test', payload: { command: 'npm test', expectExit: 0 } }],
        immutableConstraints: ['不允许修改配置文件'],
      },
    }),
    ...overrides,
  };
}

function makeRules(overrides: Partial<StopRuleSet> = {}): StopRuleSet {
  return buildStopRuleSet({
    tokenBudget: 100000,
    softRatio: 0.6,
    hardRatio: 1.0,
    warmRatio: 0.36,
    expandRequestRatio: 0.8,
    limits: { maxIterations: 30, maxWallClockMs: 900000, maxToolCalls: 100, maxConsecutiveErrors: 3 },
    noProgress: { metric: 'goal_distance', stagnationWindow: 3, minDelta: 0.05, action: 'switch_strategy' },
    ...overrides,
  }) as StopRuleSet;
}

function makeSnapshot(overrides: Partial<LoopRuntimeSnapshot> = {}): LoopRuntimeSnapshot {
  return {
    iteration: 5,
    startedAt: Date.now() - 60000,
    toolCallCount: 10,
    consecutiveErrors: 0,
    budgetUsed: { tokens: 30000, usd: 0 },
    recentMetrics: [0.1, 0.2, 0.3, 0.4, 0.5],
    riskSignals: [],
    verifierPassed: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════
// 1. LoopState（不可变区保护 · ADR-0005）
// ═══════════════════════════════════════════════════════

describe('S6 · LoopState', () => {
  it('创建初始状态', () => {
    const state = makeState();
    expect(state.schemaVersion).toBe(1);
    expect(state.loopId).toBe('test-loop-1');
    expect(state.phase).toBe('planning');
    expect(state.iteration).toBe(0);
    expect(state.goal.originalRequirement).toBe('实现一个计数器组件');
  });

  it('ADR-0005: setGoalImmutable 仅允许初始化一次', () => {
    const state = makeState();
    const newGoal = {
      originalRequirement: '新目标',
      successCriteria: [],
      immutableConstraints: [],
    };
    // 已有 goal → 拒绝
    const result = setGoalImmutable(state, newGoal);
    expect(result.ok).toBe(false);
    // 原始 goal 未被修改
    expect(state.goal.originalRequirement).toBe('实现一个计数器组件');
  });

  it('ADR-0005: hashGoal 完整性验证', () => {
    const state = makeState();
    const hash1 = hashGoal(state.goal);
    const hash2 = hashGoal(state.goal);
    expect(hash1).toBe(hash2);
    // 修改 goal 后 hash 变化
    const modifiedGoal = { ...state.goal, originalRequirement: '被篡改的目标' };
    const hash3 = hashGoal(modifiedGoal);
    expect(hash3).not.toBe(hash1);
  });

  it('verifyGoalIntegrity 检测篡改', () => {
    const state = makeState();
    const originalHash = hashGoal(state.goal);
    expect(verifyGoalIntegrity(state, originalHash)).toBe(true);
    // 模拟压缩尝试修改 goal
    state.goal.originalRequirement = '压缩后的目标';
    expect(verifyGoalIntegrity(state, originalHash)).toBe(false);
  });

  it('cloneImmutableZone 深拷贝', () => {
    const state = makeState();
    const clone = cloneImmutableZone(state);
    clone.originalRequirement = '修改克隆';
    expect(state.goal.originalRequirement).toBe('实现一个计数器组件');
  });
});

// ═══════════════════════════════════════════════════════
// 2. StopRules（五类独立退出 · 优先级链）
// ═══════════════════════════════════════════════════════

describe('S6 · StopRules', () => {
  it('评估顺序：risk > limits > budget_hard > no_progress > success', () => {
    const order = getEvaluationOrder();
    expect(order).toEqual(['risk', 'limits', 'budget_hard', 'no_progress', 'success']);
  });

  it('⑤ 风险退出：riskSignals 触发', () => {
    const rules = makeRules();
    const state = makeState();
    const snapshot = makeSnapshot({ riskSignals: ['DANGEROUS'] });
    const result = evaluateStopRules(rules, state, snapshot);
    expect(result.shouldStop).toBe(true);
    if (result.shouldStop) expect(result.reason).toBe('risk');
  });

  it('② 上限退出：maxIterations', () => {
    const rules = makeRules();
    const state = makeState();
    const snapshot = makeSnapshot({ iteration: 30 });
    const result = evaluateStopRules(rules, state, snapshot);
    expect(result.shouldStop).toBe(true);
    if (result.shouldStop) expect(result.reason).toBe('limits');
  });

  it('② 上限退出：maxConsecutiveErrors', () => {
    const rules = makeRules();
    const state = makeState();
    const snapshot = makeSnapshot({ consecutiveErrors: 3 });
    const result = evaluateStopRules(rules, state, snapshot);
    expect(result.shouldStop).toBe(true);
    if (result.shouldStop) expect(result.reason).toBe('limits');
  });

  it('③ 硬预算退出：tokens >= hardTokens', () => {
    const rules = makeRules();
    const state = makeState();
    const snapshot = makeSnapshot({ budgetUsed: { tokens: 100000, usd: 0 } });
    const result = evaluateStopRules(rules, state, snapshot);
    expect(result.shouldStop).toBe(true);
    if (result.shouldStop) expect(result.reason).toBe('budget_hard');
  });

  it('④ 无进展退出：stagnation', () => {
    const rules = makeRules();
    const state = makeState();
    const snapshot = makeSnapshot({ recentMetrics: [0.5, 0.5, 0.5] });
    const result = evaluateStopRules(rules, state, snapshot);
    expect(result.shouldStop).toBe(true);
    if (result.shouldStop) expect(result.reason).toBe('no_progress');
  });

  it('① 成功退出：verifier 通过 + 无失败条件', () => {
    const rules = makeRules();
    const state = makeState();
    const snapshot = makeSnapshot({ verifierPassed: true });
    const result = evaluateStopRules(rules, state, snapshot);
    expect(result.shouldStop).toBe(true);
    if (result.shouldStop) expect(result.reason).toBe('success');
  });

  it('成功判定位于所有失败判定之后', () => {
    const rules = makeRules();
    const state = makeState();
    // verifier 通过但有风险信号 → 应判 risk 而非 success
    const snapshot = makeSnapshot({ verifierPassed: true, riskSignals: ['FORBIDDEN'] });
    const result = evaluateStopRules(rules, state, snapshot);
    expect(result.shouldStop).toBe(true);
    if (result.shouldStop) expect(result.reason).toBe('risk');
  });

  it('无退出条件 → 继续下一轮', () => {
    const rules = makeRules();
    const state = makeState();
    const snapshot = makeSnapshot();
    const result = evaluateStopRules(rules, state, snapshot);
    expect(result.shouldStop).toBe(false);
  });

  it('预算阶段检测：warm/soft/expand/hard', () => {
    const rules = makeRules();
    expect(detectBudgetPhase(rules, 10000)).toBe('normal');
    expect(detectBudgetPhase(rules, 40000)).toBe('warm');
    expect(detectBudgetPhase(rules, 65000)).toBe('soft');
    expect(detectBudgetPhase(rules, 85000)).toBe('expand_request');
    expect(detectBudgetPhase(rules, 100000)).toBe('hard');
  });
});

// ═══════════════════════════════════════════════════════
// 3. Verifier（四级分层 · ADR-0003/0004）
// ═══════════════════════════════════════════════════════

describe('S6 · Verifier', () => {
  it('L1 硬验证：numeric 通过', async () => {
    const specs = [{ level: 'L1' as const, kind: 'numeric' as const, payload: { metric: 'coverage', op: '>=' as const, threshold: 80 } }];
    const result = await runHardVerification(specs, { currentMetrics: { coverage: 85 } });
    expect(result.ok).toBe(true);
    expect(result.value[0].pass).toBe(true);
  });

  it('L1 硬验证：numeric 失败', async () => {
    const specs = [{ level: 'L1' as const, kind: 'numeric' as const, payload: { metric: 'coverage', op: '>=' as const, threshold: 80 } }];
    const result = await runHardVerification(specs, { currentMetrics: { coverage: 50 } });
    expect(result.ok).toBe(true);
    expect(result.value[0].pass).toBe(false);
  });

  it('L1 硬验证：schema 通过', async () => {
    const specs = [{ level: 'L1' as const, kind: 'schema' as const, payload: { jsonSchema: { type: 'object', required: ['name'] } } }];
    const result = await runHardVerification(specs, { dataToValidate: { name: 'test' } });
    expect(result.value[0].pass).toBe(true);
  });

  it('L1 硬验证：schema 失败（缺 required 字段）', async () => {
    const specs = [{ level: 'L1' as const, kind: 'schema' as const, payload: { jsonSchema: { type: 'object', required: ['name'] } } }];
    const result = await runHardVerification(specs, { dataToValidate: { age: 25 } });
    expect(result.value[0].pass).toBe(false);
  });

  it('ADR-0003: L1 未通过禁止跳到 L3（pipeline 短路）', async () => {
    const specs = [
      { level: 'L1' as const, kind: 'numeric' as const, payload: { metric: 'x', op: '>=' as const, threshold: 100 } },
      { level: 'L3' as const, kind: 'llm_judge' as const, payload: { model: 'judge-model', rubric: [], minScore: 0.8, requireEvidence: true as const } },
    ];
    const result = await runVerifierPipeline(specs, {
      hard: { currentMetrics: { x: 50 } },
      rule: { artifact: 'test' },
      llm: { artifact: 'test', producerModel: 'producer' },
      human: { loopId: 'l1', iteration: 1, requestedAt: Date.now() },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.allPassed).toBe(false);
      expect(result.value.levelsRun).toBe(1); // 只跑了 L1
    }
  });

  it('ADR-0004: producerModel === verifierModel → 拒绝', async () => {
    const specs = [
      { level: 'L1' as const, kind: 'numeric' as const, payload: { metric: 'x', op: '>=' as const, threshold: 0 } },
      { level: 'L3' as const, kind: 'llm_judge' as const, payload: { model: 'same-model', rubric: [], minScore: 0.8, requireEvidence: true as const } },
    ];
    const result = await runVerifierPipeline(specs, {
      hard: { currentMetrics: { x: 10 } },
      rule: { artifact: 'test' },
      llm: { artifact: 'test', producerModel: 'same-model' },
      human: { loopId: 'l1', iteration: 1, requestedAt: Date.now() },
    });
    // L3 校验应失败
    expect(result.ok).toBe(false);
  });

  it('反博弈：规则数不足 → 验证失败', () => {
    const spec = {
      primary: { level: 'L1' as const, kind: 'test' as const, payload: { command: 'test', expectExit: 0 as const } },
      antiGaming: [],
    };
    const result = validateAntiGaming(spec, { minRules: 1, maxChangedFiles: 8 });
    expect(result.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 4. ActionFingerprint（四规则检测）
// ═══════════════════════════════════════════════════════

describe('S6 · ActionFingerprint', () => {
  it('canonicalJson 字典序排序', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1.0,"b":2.0}');
  });

  it('computeFingerprint 确定性', () => {
    const fp1 = computeFingerprint('read_file', { path: '/test.ts' });
    const fp2 = computeFingerprint('read_file', { path: '/test.ts' });
    expect(fp1).toBe(fp2);
  });

  it('不同参数 → 不同指纹', () => {
    const fp1 = computeFingerprint('read_file', { path: '/a.ts' });
    const fp2 = computeFingerprint('read_file', { path: '/b.ts' });
    expect(fp1).not.toBe(fp2);
  });

  it('规则 1：单次迭代内重复 → warn', () => {
    const config = { singleIterationWarnThreshold: 2, consecutiveDuplicateRounds: 3, windowRounds: 5, windowHitThreshold: 3, crossAgentDuplicateThreshold: 2 };
    const history = [
      { fingerprint: 'abc123', toolName: 'read', iteration: 5, countInIteration: 1, recordedAt: Date.now() },
    ];
    const action = detectFingerprintAction('abc123', 5, history, config);
    // countInIteration 在 history 中是 1，加上当前这次 = 2 >= threshold 2
    // 但 detectFingerprintAction 只查 history 中的 countInIteration 之和
    // history 中 countInIteration=1, 不够 2, 所以是 none
    expect(action.type).toBe('none');
    // 再添加一条
    history.push({ fingerprint: 'abc123', toolName: 'read', iteration: 5, countInIteration: 1, recordedAt: Date.now() });
    const action2 = detectFingerprintAction('abc123', 5, history, config);
    expect(action2.type).toBe('warn');
  });

  it('规则 2：连续 3 轮相同 → switch_strategy', () => {
    const config = { singleIterationWarnThreshold: 5, consecutiveDuplicateRounds: 3, windowRounds: 5, windowHitThreshold: 10, crossAgentDuplicateThreshold: 2 };
    const history = [
      { fingerprint: 'fp1', toolName: 'read', iteration: 3, countInIteration: 1, recordedAt: Date.now() },
      { fingerprint: 'fp1', toolName: 'read', iteration: 4, countInIteration: 1, recordedAt: Date.now() },
      { fingerprint: 'fp1', toolName: 'read', iteration: 5, countInIteration: 1, recordedAt: Date.now() },
    ];
    const action = detectFingerprintAction('fp1', 5, history, config);
    expect(action.type).toBe('switch_strategy');
  });

  it('recordFingerprint 累加 countInIteration', () => {
    const existing: import('../../Src/Services/LoopControl/loopState.js').FingerprintRecord[] = [];
    const r1 = recordFingerprint('read', { path: '/a' }, 1, existing);
    expect(r1.countInIteration).toBe(1);
    existing.push(r1);
    const r2 = recordFingerprint('read', { path: '/a' }, 1, existing);
    expect(r2.countInIteration).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════
// 5. StrategyLedger
// ═══════════════════════════════════════════════════════

describe('S6 · StrategyLedger', () => {
  beforeEach(() => clearLedger());

  it('记录策略', () => {
    const result = recordStrategy('loop-1', { iteration: 1, strategy: '修复 bug', expectedOutcome: '测试通过' });
    expect(result.ok).toBe(true);
    expect(getStrategies('loop-1')).toHaveLength(1);
  });

  it('策略超 30 字 → 拒绝', () => {
    const result = recordStrategy('loop-1', { iteration: 1, strategy: '这是一个非常非常长的策略描述超过了三十字限制的测试用例字符串额外', expectedOutcome: '完成' });
    expect(result.ok).toBe(false);
  });

  it('回填结果', () => {
    recordStrategy('loop-1', { iteration: 1, strategy: '修复', expectedOutcome: '通过' });
    backfillStrategyResult('loop-1', 1, '失败', '编译错误');
    const failed = getFailedStrategies('loop-1');
    expect(failed).toContain('修复');
  });

  it('换策略：排除已失败策略', () => {
    recordStrategy('loop-1', { iteration: 1, strategy: '方案A', expectedOutcome: '通过' });
    backfillStrategyResult('loop-1', 1, '失败', '错误');
    const next = selectNextStrategy('loop-1', ['方案A', '方案B', '方案C']);
    expect(next.strategy).toBe('方案B');
    expect(next.escalated).toBe(false);
  });

  it('换策略：无可用策略 → escalate_human', () => {
    recordStrategy('loop-1', { iteration: 1, strategy: '方案A', expectedOutcome: '通过' });
    backfillStrategyResult('loop-1', 1, '失败', '错误');
    const next = selectNextStrategy('loop-1', ['方案A']);
    expect(next.escalated).toBe(true);
    expect(next.strategy).toBe('escalate_human');
  });
});

// ═══════════════════════════════════════════════════════
// 6. FailureFeedback（P5 可行动的失败信息）
// ═══════════════════════════════════════════════════════

describe('S6 · FailureFeedback', () => {
  it('构建失败反馈：必须包含 evidence', () => {
    const result = buildFailureFeedback({
      iteration: 1,
      category: 'logic',
      errorMessage: 'TypeError: undefined is not a function',
      triedStrategies: ['修复 import'],
      remainingBudget: { tokens: 50000, iterations: 10, seconds: 300 },
    }, {
      evidenceExcerptMaxChars: 500,
      strategyTextMaxChars: 30,
      sameDefectCategoryEscalateRounds: 3,
      noImprovementAbortRounds: 2,
      improvementMinRatio: 0.05,
      unreasonableGoalEscalateCount: 5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.evidence.length).toBeGreaterThan(0);
      expect(result.value.triedStrategies).toContain('修复 import');
      expect(result.value.remainingBudget.tokens).toBe(50000);
      expect(result.value.recommendedNextAction).toBeDefined();
    }
  });

  it('空 evidence → 拒绝', () => {
    const result = buildFailureFeedback({
      iteration: 1,
      category: 'logic',
      triedStrategies: [],
      remainingBudget: { tokens: 50000, iterations: 10, seconds: 300 },
    }, {
      evidenceExcerptMaxChars: 500,
      strategyTextMaxChars: 30,
      sameDefectCategoryEscalateRounds: 3,
      noImprovementAbortRounds: 2,
      improvementMinRatio: 0.05,
      unreasonableGoalEscalateCount: 5,
    });
    expect(result.ok).toBe(false);
  });

  it('feedbackToToolResult 格式正确', () => {
    const feedback = buildFailureFeedback({
      iteration: 3,
      category: 'schema',
      errorMessage: 'Missing field',
      triedStrategies: [],
      remainingBudget: { tokens: 10000, iterations: 5, seconds: 60 },
    }, {
      evidenceExcerptMaxChars: 500, strategyTextMaxChars: 30,
      sameDefectCategoryEscalateRounds: 3, noImprovementAbortRounds: 2,
      improvementMinRatio: 0.05, unreasonableGoalEscalateCount: 5,
    });
    if (feedback.ok) {
      const toolResult = feedbackToToolResult(feedback.value) as any;
      expect(toolResult.role).toBe('tool');
      expect(toolResult.status).toBe('error');
      expect(toolResult.recoverable).toBe(true);
      expect(toolResult.tool_call_id).toBe('verify-3');
    }
  });

  it('预算耗尽 → 推荐 abort', () => {
    const result = buildFailureFeedback({
      iteration: 1,
      category: 'logic',
      errorMessage: 'fail',
      triedStrategies: ['a'],
      remainingBudget: { tokens: 0, iterations: 0, seconds: 0 },
    }, {
      evidenceExcerptMaxChars: 500, strategyTextMaxChars: 30,
      sameDefectCategoryEscalateRounds: 3, noImprovementAbortRounds: 2,
      improvementMinRatio: 0.05, unreasonableGoalEscalateCount: 5,
    });
    if (result.ok) {
      expect(result.value.recommendedNextAction).toBe('abort');
    }
  });
});

// ═══════════════════════════════════════════════════════
// 7. ApprovalGate（超时默认拒绝）
// ═══════════════════════════════════════════════════════

describe('S6 · ApprovalGate', () => {
  beforeEach(() => clearApprovalQueue());

  it('创建审批请求', () => {
    const result = createApproval({
      loopId: 'loop-1', traceId: 'trace-1', iteration: 1,
      requestedBy: 'agent-1', kind: 'tool_execute',
      payload: { tool: 'shell.exec' }, riskLevel: 'HIGH',
      deciders: [{ role: 'user', weight: 1.0 }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('PENDING');
      expect(result.value.defaultOnTimeout).toBe('reject');
    }
  });

  it('CRITICAL 级 → 强制 unanimous', () => {
    const result = createApproval({
      loopId: 'loop-1', traceId: 'trace-1', iteration: 1,
      requestedBy: 'agent-1', kind: 'irreversible_action',
      payload: {}, riskLevel: 'CRITICAL',
      deciders: [{ role: 'user', weight: 1.0 }, { role: 'prime_director', weight: 1.0 }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.decisionPolicy).toBe('unanimous');
  });

  it('CRITICAL 级需 2 个不同角色 → 同角色拒绝', () => {
    const result = createApproval({
      loopId: 'loop-1', traceId: 'trace-1', iteration: 1,
      requestedBy: 'agent-1', kind: 'irreversible_action',
      payload: {}, riskLevel: 'CRITICAL',
      deciders: [{ role: 'user', weight: 1.0 }, { role: 'user', weight: 1.0 }],
    });
    expect(result.ok).toBe(false);
  });

  it('超时 → 默认拒绝（禁止默认通过）', () => {
    const approval = createApproval({
      loopId: 'loop-1', traceId: 'trace-1', iteration: 1,
      requestedBy: 'agent-1', kind: 'tool_execute',
      payload: {}, riskLevel: 'LOW', timeoutSec: 1,
      deciders: [{ role: 'user', weight: 1.0 }],
    });
    if (approval.ok) {
      registerApproval(approval.value);
      // 模拟超时
      const timedOut = checkTimeoutApprovals(Date.now() + 2000);
      expect(timedOut.length).toBe(1);
      expect(timedOut[0].status).toBe('TIMEOUT');
    }
  });

  it('审批决定：majority 模式', () => {
    const approval = createApproval({
      loopId: 'loop-1', traceId: 'trace-1', iteration: 1,
      requestedBy: 'agent-1', kind: 'tool_execute',
      payload: {}, riskLevel: 'MEDIUM',
      deciders: [{ role: 'user', weight: 1.0 }],
    });
    if (approval.ok) {
      registerApproval(approval.value);
      const result = decideApproval({ approvalId: approval.value.approvalId, decidedBy: 'user-1', approve: true, reason: 'OK' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('APPROVED');
    }
  });
});

// ═══════════════════════════════════════════════════════
// 8. Gate G6 综合验证
// ═══════════════════════════════════════════════════════

describe('S6 · Gate G6 综合验证', () => {
  beforeEach(() => {
    clearLedger();
    clearApprovalQueue();
    clearCheckpointStore();
  });

  it('G6-1: 五类退出各自独立触发', () => {
    const rules = makeRules();
    const state = makeState();

    // 风险
    const r1 = evaluateStopRules(rules, state, makeSnapshot({ riskSignals: ['X'] }));
    expect(r1.shouldStop && r1.reason).toBe('risk');

    // 上限
    const r2 = evaluateStopRules(rules, state, makeSnapshot({ iteration: 30 }));
    expect(r2.shouldStop && r2.reason).toBe('limits');

    // 硬预算
    const r3 = evaluateStopRules(rules, state, makeSnapshot({ budgetUsed: { tokens: 100000, usd: 0 } }));
    expect(r3.shouldStop && r3.reason).toBe('budget_hard');

    // 无进展
    const r4 = evaluateStopRules(rules, state, makeSnapshot({ recentMetrics: [0.5, 0.5, 0.5] }));
    expect(r4.shouldStop && r4.reason).toBe('no_progress');

    // 成功
    const r5 = evaluateStopRules(rules, state, makeSnapshot({ verifierPassed: true }));
    expect(r5.shouldStop && r5.reason).toBe('success');
  });

  it('G6-2: 压缩/摘要修改 goal → 被拒（ADR-0005）', () => {
    const state = makeState();
    const originalHash = hashGoal(state.goal);
    // 模拟压缩尝试修改
    const result = setGoalImmutable(state, {
      originalRequirement: '压缩后的目标',
      successCriteria: [],
      immutableConstraints: [],
    });
    expect(result.ok).toBe(false);
    expect(verifyGoalIntegrity(state, originalHash)).toBe(true);
  });

  it('G6-3: 同 fingerprint 连续 3 次 → switch_strategy', () => {
    const config = { singleIterationWarnThreshold: 5, consecutiveDuplicateRounds: 3, windowRounds: 5, windowHitThreshold: 10, crossAgentDuplicateThreshold: 2 };
    const history = [
      { fingerprint: 'fp1', toolName: 'read', iteration: 3, countInIteration: 1, recordedAt: Date.now() },
      { fingerprint: 'fp1', toolName: 'read', iteration: 4, countInIteration: 1, recordedAt: Date.now() },
      { fingerprint: 'fp1', toolName: 'read', iteration: 5, countInIteration: 1, recordedAt: Date.now() },
    ];
    const action = detectFingerprintAction('fp1', 5, history, config);
    expect(action.type).toBe('switch_strategy');
  });

  it('G6-4: 每次失败产出可行动反馈', () => {
    const feedback = buildFailureFeedback({
      iteration: 5,
      category: 'logic',
      errorMessage: 'AssertionError: expected 42 to equal 43',
      triedStrategies: ['修复边界条件', '更新测试'],
      remainingBudget: { tokens: 30000, iterations: 8, seconds: 120 },
    }, {
      evidenceExcerptMaxChars: 500, strategyTextMaxChars: 30,
      sameDefectCategoryEscalateRounds: 3, noImprovementAbortRounds: 2,
      improvementMinRatio: 0.05, unreasonableGoalEscalateCount: 5,
    });
    expect(feedback.ok).toBe(true);
    if (feedback.ok) {
      const fb = feedback.value;
      expect(fb.evidence.length).toBeGreaterThan(0);
      expect(fb.triedStrategies.length).toBeGreaterThan(0);
      expect(fb.remainingBudget.tokens).toBeGreaterThan(0);
      expect(fb.recommendedNextAction).toBeDefined();
    }
  });

  it('G6-5: 每轮末尾从 LoopState 重建目标（30 轮长任务）', () => {
    const state = makeState();
    // 模拟 30 轮迭代
    for (let i = 0; i < 30; i++) {
      state.iteration = i;
      // 每轮末尾验证 goal 完整性
      const hash = hashGoal(state.goal);
      expect(verifyGoalIntegrity(state, hash)).toBe(true);
      // 模拟干扰（尝试修改 goal）
      const tamperResult = setGoalImmutable(state, {
        originalRequirement: `干扰-${i}`,
        successCriteria: [],
        immutableConstraints: [],
      });
      expect(tamperResult.ok).toBe(false);
    }
    // 30 轮后原始约束仍在
    expect(state.goal.originalRequirement).toBe('实现一个计数器组件');
    expect(state.goal.immutableConstraints).toContain('不允许修改配置文件');
  });
});
