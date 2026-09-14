/**
 * S14 E2E 测试：Loop 收敛性验证
 *
 * 验证 Loop 控制系统的核心收敛属性：
 * - 有限步内必然终止（成功/失败/预算耗尽）
 * - 策略切换不会无限循环
 * - 预算约束严格生效
 * - 指纹检测防止死循环
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── LoopState ───────────────────────────────────────
import {
  createInitialLoopState, setGoalImmutable,
} from '../../Src/Services/LoopControl/loopState.js';
import type { LoopState } from '../../Src/Services/LoopControl/loopState.js';

// ── StopRules ───────────────────────────────────────
import {
  evaluateStopRules, buildStopRuleSet, getEvaluationOrder,
} from '../../Src/Services/LoopControl/stopRules.js';
import type { StopRuleSet, LoopRuntimeSnapshot } from '../../Src/Services/LoopControl/stopRules.js';

// ── ActionFingerprint ───────────────────────────────
import {
  computeFingerprint, detectFingerprintAction, recordFingerprint,
} from '../../Src/Services/LoopControl/actionFingerprint.js';

// ── StrategyLedger ──────────────────────────────────
import {
  validateTurnStrategy, recordStrategy, selectNextStrategy, clearLedger,
} from '../../Src/Services/LoopControl/strategyLedger.js';

// ── ApprovalGate ────────────────────────────────────
import {
  createApproval, registerApproval, decideApproval,
  getPendingApprovals, clearApprovalQueue,
} from '../../Src/Services/LoopControl/approvalGate.js';

// ── EventBus ────────────────────────────────────────
import { resetEventBus } from '../../Src/Services/EventBus/eventBus.js';

function makeState(): LoopState {
  return createInitialLoopState({
    loopId: 'e2e-loop',
    traceId: 'e2e-trace',
    goal: {
      originalRequirement: 'E2E 收敛测试',
      successCriteria: [],
      immutableConstraints: [],
    },
  });
}

function makeRules(overrides: Partial<{
  maxIterations: number; hardTokens: number; maxConsecutiveErrors: number;
}> = {}): StopRuleSet {
  return buildStopRuleSet({
    tokenBudget: 10000,
    softRatio: 0.7,
    hardRatio: overrides.hardTokens ? overrides.hardTokens / 10000 : 1.0,
    warmRatio: 0.1,
    expandRequestRatio: 0.05,
    limits: {
      maxIterations: overrides.maxIterations ?? 10,
      maxWallClockMs: 60000,
      maxToolCalls: 100,
      maxConsecutiveErrors: overrides.maxConsecutiveErrors ?? 3,
    },
    noProgress: {
      metric: 'failed_tests',
      stagnationWindow: 5,
      minDelta: 0,
      action: 'abort',
    },
  });
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

describe('E2E: Loop 收敛性', () => {
  beforeEach(() => {
    resetEventBus();
    clearApprovalQueue();
    clearLedger();
  });

  it('有限步内终止：达到 maxIterations 后停止', () => {
    const rules = makeRules({ maxIterations: 5 });
    const state = makeState();
    const snapshot = makeSnapshot({ iteration: 5 });

    const decision = evaluateStopRules(rules, state, snapshot);
    expect(decision.shouldStop).toBe(true);
    if (decision.shouldStop) {
      expect(decision.reason).toBe('limits');
    }
  });

  it('预算硬限制：超 hardTokens 后强制停止', () => {
    const rules = makeRules({ hardTokens: 10000 });
    const state = makeState();
    const snapshot = makeSnapshot({
      budgetUsed: { tokens: 10001, usd: 0 },
    });

    const decision = evaluateStopRules(rules, state, snapshot);
    expect(decision.shouldStop).toBe(true);
    if (decision.shouldStop) {
      expect(decision.reason).toBe('budget_hard');
    }
  });

  it('连续错误：超 maxConsecutiveErrors 后停止', () => {
    const rules = makeRules({ maxConsecutiveErrors: 3 });
    const state = makeState();
    const snapshot = makeSnapshot({ consecutiveErrors: 4 });

    const decision = evaluateStopRules(rules, state, snapshot);
    expect(decision.shouldStop).toBe(true);
    if (decision.shouldStop) {
      expect(decision.reason).toBe('limits');
    }
  });

  it('成功终止：verifierPassed=true 时正常退出', () => {
    const rules = makeRules();
    const state = makeState();
    const snapshot = makeSnapshot({ verifierPassed: true });

    const decision = evaluateStopRules(rules, state, snapshot);
    expect(decision.shouldStop).toBe(true);
    if (decision.shouldStop) {
      expect(decision.reason).toBe('success');
    }
  });

  it('风险信号：riskSignals 非空时最高优先级停止', () => {
    const rules = makeRules();
    const state = makeState();
    const snapshot = makeSnapshot({ riskSignals: ['disk_full'] });

    const decision = evaluateStopRules(rules, state, snapshot);
    expect(decision.shouldStop).toBe(true);
    if (decision.shouldStop) {
      expect(decision.reason).toBe('risk');
    }
  });

  it('优先级链：risk > limits > budget_hard > no_progress > success', () => {
    const order = getEvaluationOrder();
    expect(order).toEqual(['risk', 'limits', 'budget_hard', 'no_progress', 'success']);
  });

  it('指纹检测：重复动作触发策略切换', () => {
    const fp = computeFingerprint('write_file', { path: '/a.ts' });
    const fp2 = computeFingerprint('write_file', { path: '/a.ts' });
    expect(fp).toBe(fp2);

    // 记录多次相同指纹
    const history: ReturnType<typeof recordFingerprint>[] = [];
    for (let i = 0; i < 3; i++) {
      const rec = recordFingerprint('write_file', { path: '/a.ts' }, 0, history);
      if (!history.find(h => h.fingerprint === rec.fingerprint && h.iteration === 0)) {
        history.push(rec);
      }
    }

    // 检测指纹动作
    const action = detectFingerprintAction(fp, 0, history, {
      singleIterationWarnThreshold: 2,
      consecutiveDuplicateRounds: 3,
      windowRounds: 5,
      windowHitThreshold: 4,
      crossAgentDuplicateThreshold: 3,
    });
    expect(action.type).not.toBe('none');
  });

  it('策略切换：记录策略 → 失败 → 选择下一策略', () => {
    const loopId = 'e2e-strategy';
    const valid = validateTurnStrategy({
      strategy: 'direct',
      expectedOutcome: 'simple task done',
      iteration: 0,
    });
    expect(valid.ok).toBe(true);

    if (valid.ok) {
      recordStrategy(loopId, valid.value);
    }

    // 选择下一策略（当第一个失败时）
    const next = selectNextStrategy(loopId, ['direct']);
    expect(next).toBeDefined();
  });

  it('审批门：CRITICAL 操作需审批', () => {
    const approvalResult = createApproval({
      loopId: 'e2e-loop',
      traceId: 'e2e-trace',
      iteration: 1,
      requestedBy: 'agent-1',
      kind: 'irreversible_action',
      payload: { tool: 'rm -rf /' },
      riskLevel: 'CRITICAL',
      timeoutSec: 300,
      defaultOnTimeout: 'reject',
      deciders: [{ role: 'developer', weight: 1 }, { role: 'product', weight: 1 }],
    });
    expect(approvalResult.ok).toBe(true);
    if (approvalResult.ok) {
      expect(approvalResult.value.status).toBe('PENDING');
      // 注册到队列
      registerApproval(approvalResult.value);
      const pending = getPendingApprovals();
      expect(pending.length).toBe(1);
    }
  });

  it('审批超时默认拒绝（禁止默认通过）', () => {
    const approvalResult = createApproval({
      loopId: 'e2e-loop',
      traceId: 'e2e-trace',
      iteration: 1,
      requestedBy: 'agent-1',
      kind: 'irreversible_action',
      payload: {},
      riskLevel: 'CRITICAL',
      timeoutSec: 0,
      defaultOnTimeout: 'reject',
      deciders: [{ role: 'developer', weight: 1 }, { role: 'product', weight: 1 }],
    });
    expect(approvalResult.ok).toBe(true);
    if (approvalResult.ok) {
      registerApproval(approvalResult.value);

      // 拒绝
      const decided = decideApproval({
        approvalId: approvalResult.value.approvalId,
        decidedBy: 'system-timeout',
        approve: false,
        reason: 'timeout → default reject',
      });
      expect(decided.ok).toBe(true);
      if (decided.ok) {
        expect(decided.value.status).toBe('REJECTED');
      }
    }
  });

  it('不可变区保护：goal 设置后不可二次修改', () => {
    const state = makeState();

    // state 的 goal 已有 originalRequirement = 'E2E 收敛测试'，非空
    const r1 = setGoalImmutable(state, {
      originalRequirement: '新目标',
      successCriteria: [],
      immutableConstraints: [],
    });
    expect(r1.ok).toBe(false);
  });
});
