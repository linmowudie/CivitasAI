/**
 * 实验矩阵 · 对抗面-恶意攻击（SEC）脚手架
 *
 * 锚定 Benchmarks/experimentMatrix.json 的 SEC-* cell，断言真实模块的返回契约，
 * 不引用不存在的 EventType（security.json 的 INJECTION_DETECTED 等仅为配置标签）。
 * 用例以 `// @matrix:<ID>` 标签与矩阵关联，由 Scripts/experimentMatrix.cjs 校验覆盖。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';

// ── 安全基座 ────────────────────────────────────────
import {
  initPathGuard, checkPath, onPathAccess, resetPathGuard,
  type PathAccessEvent,
} from '../../../Src/Infra/Security/pathGuard.js';
import {
  initWhitelist, isCommandForbidden, isNetworkAllowed, registerTool, isToolRegistered, clearWhitelist,
} from '../../../Src/Infra/Security/whitelist.js';
import { initTrustLevels, isToolAllowed } from '../../../Src/Infra/Security/trustLevels.js';

// ── Loop 控制：反博弈 / 四级验证 / Maker-Checker / 目标不可变 / 失败反馈 ──
import { checkAntiGaming } from '../../../Src/Services/LoopControl/verifier/antiGaming.js';
import {
  runVerifierPipeline, runLlmJudge,
  type VerifierContext, type LlmJudgeContext,
} from '../../../Src/Services/LoopControl/verifier/index.js';
import {
  createInitialLoopState, setGoalImmutable, hashGoal, verifyGoalIntegrity,
  type LoopState, type VerifierSpec, type VerifierResult,
} from '../../../Src/Services/LoopControl/loopState.js';
import {
  buildFailureFeedback, type FailureFeedbackConfig,
} from '../../../Src/Services/LoopControl/failureFeedback.js';
import {
  createApproval, registerApproval, checkTimeoutApprovals, getApproval, clearApprovalQueue,
} from '../../../Src/Services/LoopControl/approvalGate.js';

// ── 监管行为准则 ────────────────────────────────────
import { initBehaviorCode, checkViolation, resetBehaviorCode } from '../../../Src/Services/Regulation/behaviorCode.js';

// ── 共享记忆写入守卫 ────────────────────────────────
import { interceptWrite, isEligibleForLongTerm } from '../../../Src/Services/SharedMemory/writeGuard.js';
import type { WorkspaceEntry } from '../../../Src/Services/SharedMemory/versionedEntry.js';

// ── 审计冻结 ────────────────────────────────────────
import { freezeAgent, isFrozen, resetFreezeManager } from '../../../Src/Services/Audit/freezeManager.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** 构造合法 WorkspaceEntry 的辅助函数 */
function makeEntry(over: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  const now = Date.now();
  return {
    entryId: over.entryId ?? 'e-1',
    traceId: 'trace-1',
    agentId: 'agent-1',
    key: 'shared/fact',
    content: 'hello',
    contentType: 'fact',
    assertion: 'observed',
    metadata: { timestamp: now, sourceAgentId: 'agent-1', taskAuthority: 0.5 },
    version: 1,
    lastModifiedBy: 'agent-1',
    conflictStrategy: 'arbitrate',
    causalTokens: [],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function l3Spec(model: string): VerifierSpec {
  return { level: 'L3', kind: 'llm_judge', payload: { model, rubric: [], minScore: 0.8, requireEvidence: true } };
}

describe('实验矩阵 · 恶意攻击（SEC）', () => {
  afterEach(() => {
    resetPathGuard();
    clearWhitelist();
    resetBehaviorCode();
    clearApprovalQueue();
    resetFreezeManager();
  });

  // @matrix:SEC-PATH
  it('SEC-PATH 目录遍历与禁止路径被拒并审计', () => {
    const events: PathAccessEvent[] = [];
    initPathGuard({ projectRoot: ROOT, forbiddenPaths: ['Data/Auth/', '~/.ssh/'] });
    onPathAccess(ev => events.push(ev));

    expect(checkPath('../../etc/passwd', 'read').allowed).toBe(false);
    expect(checkPath('Data/Auth/secret.json', 'read').allowed).toBe(false);
    expect(checkPath('~/.ssh/id_rsa', 'read').allowed).toBe(false);
    // 合法路径放行
    expect(checkPath('Src/main.ts', 'read').allowed).toBe(true);
    // 被拒的 3 次访问均产生审计事件
    expect(events.filter(e => !e.allowed).length).toBeGreaterThanOrEqual(3);
  });

  // @matrix:SEC-CMD
  it('SEC-CMD 禁止命令被拦截', () => {
    initWhitelist({ forbiddenCommands: ['rm -rf /', ':(){ :|:& };:'] });
    expect(isCommandForbidden('rm -rf /')).toBe(true);
    expect(isCommandForbidden(':(){ :|:& };:')).toBe(true);
    expect(isCommandForbidden('sudo rm -rf / --no-preserve-root')).toBe(true);
    expect(isCommandForbidden('echo hello')).toBe(false);
  });

  // @matrix:SEC-NET
  it('SEC-NET 空白名单下任意外部域名禁止', () => {
    initWhitelist({ networkWhitelist: [] });
    expect(isNetworkAllowed('evil.example.com')).toBe(false);
    expect(isNetworkAllowed('169.254.169.254')).toBe(false);
    initWhitelist({ networkWhitelist: ['api.trusted.com'] });
    expect(isNetworkAllowed('api.trusted.com')).toBe(true);
    expect(isNetworkAllowed('evil.example.com')).toBe(false);
  });

  // @matrix:SEC-PRIVESC
  it('SEC-PRIVESC 越权工具被拒且 FORBIDDEN 永不注册', () => {
    initTrustLevels({ externalRoles: ['worker'] });
    initWhitelist({});
    // worker → L2，仅可用 SAFE
    expect(isToolAllowed('DANGEROUS', 'L2')).toBe(false);
    expect(isToolAllowed('CONTROLLED', 'L2')).toBe(false);
    expect(isToolAllowed('SAFE', 'L2')).toBe(true);
    // FORBIDDEN 工具永不注册
    expect(registerTool({ name: 'nuke', dangerLevel: 'FORBIDDEN', idempotent: false, reversible: false })).toBe(false);
    expect(isToolRegistered('nuke')).toBe(false);
  });

  // @matrix:SEC-REWHACK
  it('SEC-REWHACK 改测试骗过 primary 被反博弈拦截', () => {
    const primary: VerifierResult = {
      pass: true, level: 'L1', kind: 'test',
      evidence: [{ kind: 'test_output', data: { exitCode: 0 } }], costTokens: 0, durationMs: 0,
    };
    // 反博弈规则："测试文件未被删改" 失败
    const antiGaming: VerifierResult = {
      pass: false, level: 'L2', kind: 'rule',
      evidence: [{ kind: 'rule_violation', data: { deletedTestFiles: 3 } }], costTokens: 0, durationMs: 0,
    };
    const res = checkAntiGaming(primary, [antiGaming], { minRules: 1, maxChangedFiles: 8 });
    expect(res.passed).toBe(false);
    expect(res.violations.length).toBeGreaterThan(0);
  });

  // @matrix:SEC-VERSKIP
  it('SEC-VERSKIP L1 未通过禁止跳级调用 L3（ADR-0003）', async () => {
    const specs: VerifierSpec[] = [
      { level: 'L1', kind: 'numeric', payload: { metric: 'coverage', op: '>=', threshold: 80 } },
      l3Spec('judge-model'),
    ];
    const ctx: VerifierContext = {
      hard: { currentMetrics: { coverage: 5 } }, // L1 失败
      rule: { artifact: '' },
      llm: { artifact: '', producerModel: 'producer-model' },
      human: { loopId: 'loop-1', iteration: 0, requestedAt: Date.now() },
    };
    const res = await runVerifierPipeline(specs, ctx, 2);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.levelsRun).toBe(1);
      expect(res.value.allPassed).toBe(false);
      // L3 从未被执行：结果中不含 L3
      expect(res.value.results.every(r => r.level === 'L1')).toBe(true);
    }
  });

  // @matrix:SEC-COLLUSION
  it('SEC-COLLUSION Judge 模型与产出者相同被拒（ADR-0004）', async () => {
    const sameCtx: LlmJudgeContext = { artifact: 'out', producerModel: 'glm-x' };
    const collusion = await runLlmJudge([l3Spec('glm-x')], sameCtx);
    expect(collusion.ok).toBe(false); // Maker===Checker → err

    const honestCtx: LlmJudgeContext = {
      artifact: 'out', producerModel: 'glm-x',
      callModel: async () => JSON.stringify({ score: 0.95, pass: true, evidence: [] }),
    };
    const honest = await runLlmJudge([l3Spec('other-model')], honestCtx);
    expect(honest.ok).toBe(true);
    if (honest.ok) expect(honest.value[0].pass).toBe(true);
  });

  // @matrix:SEC-GOALTAMP
  it('SEC-GOALTAMP goal 二次修改被拒且完整性可验（ADR-0005）', () => {
    const state = createInitialLoopState({
      loopId: 'loop-1', traceId: 'trace-1',
      goal: { originalRequirement: '原始需求', successCriteria: [], immutableConstraints: ['不得删测试'] },
    });
    // 二次修改被拒
    const again = setGoalImmutable(state, { originalRequirement: '篡改', successCriteria: [], immutableConstraints: [] });
    expect(again.ok).toBe(false);
    // 完整性校验
    const h = hashGoal(state.goal);
    expect(verifyGoalIntegrity(state, h)).toBe(true);
    const tampered: LoopState = { ...state, goal: { ...state.goal, originalRequirement: '篡改' } };
    expect(verifyGoalIntegrity(tampered, h)).toBe(false);
  });

  // @matrix:SEC-REPEAT
  it('SEC-REPEAT 禁止无证据的"再试一次"式反馈', () => {
    const config: FailureFeedbackConfig = {
      evidenceExcerptMaxChars: 200, strategyTextMaxChars: 100,
      sameDefectCategoryEscalateRounds: 3, noImprovementAbortRounds: 3,
      improvementMinRatio: 0.05, unreasonableGoalEscalateCount: 3,
    };
    // 缺证据 → 拒绝
    const empty = buildFailureFeedback({
      iteration: 1, category: 'logic', triedStrategies: ['s1'],
      remainingBudget: { tokens: 100, iterations: 2, seconds: 10 },
    }, config);
    expect(empty.ok).toBe(false);
    // 带证据 → 产出可行动反馈
    const ok = buildFailureFeedback({
      iteration: 1, category: 'logic', triedStrategies: ['s1'],
      remainingBudget: { tokens: 100, iterations: 2, seconds: 10 },
      verifierResult: { pass: false, level: 'L1', kind: 'test', evidence: [{ kind: 'test_output', data: { msg: 'boom' } }], costTokens: 0, durationMs: 0 },
    }, config);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.evidence.length).toBeGreaterThan(0);
      expect(ok.value.triedStrategies.length).toBeGreaterThan(0);
      expect(ok.value.recommendedNextAction).toBeDefined();
    }
  });

  // @matrix:SEC-INJ
  it('SEC-INJ Prompt 注入篡改仲裁/审计判违规', () => {
    initBehaviorCode();
    const v = checkViolation({ agentId: 'worker-1', action: 'prompt_injection' });
    expect(v.violated).toBe(true);
    expect(v.rules.some(r => r.ruleId === 'safety-002')).toBe(true);
  });

  // @matrix:SEC-SPY
  it('SEC-SPY 越权访问他 Agent 私有上下文判违规', () => {
    initBehaviorCode();
    const v = checkViolation({ agentId: 'worker-1', action: 'access_private_context' });
    expect(v.violated).toBe(true);
    expect(v.rules.some(r => r.ruleId === 'safety-001')).toBe(true);
  });

  // @matrix:SEC-CTXPOISON
  it('SEC-CTXPOISON inferred 断言不得进长期记忆', () => {
    expect(isEligibleForLongTerm('observed')).toBe(true);
    expect(isEligibleForLongTerm('inferred')).toBe(false);
    expect(isEligibleForLongTerm('assumed')).toBe(false);
    const res = interceptWrite(makeEntry({ assertion: 'inferred' }), 1, 1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.success).toBe(true);
      expect(res.value.warning).toContain('inferred');
    }
  });

  // @matrix:SEC-CONF
  it('SEC-CONF 版本不匹配的并发覆盖被乐观锁拒绝', () => {
    const res = interceptWrite(makeEntry({ key: 'shared/cfg' }), /* current */ 2, /* expected */ 0);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.success).toBe(false);
      expect(res.value.conflict).toBeDefined();
      expect(res.value.conflict?.key).toBe('shared/cfg');
    }
  });

  // @matrix:SEC-APPROVAL
  it('SEC-APPROVAL 审批超时默认拒绝且 CRITICAL 需双角色', () => {
    // CRITICAL 单角色 → 创建失败
    const bad = createApproval({
      loopId: 'loop-1', traceId: 't1', iteration: 0, requestedBy: 'worker',
      kind: 'irreversible_action', payload: {}, riskLevel: 'CRITICAL',
      deciders: [{ role: 'auditor', weight: 1 }],
    });
    expect(bad.ok).toBe(false);

    // HIGH 审批超时 → 默认拒绝（TIMEOUT），非自动通过
    const created = createApproval({
      loopId: 'loop-1', traceId: 't1', iteration: 0, requestedBy: 'worker',
      kind: 'tool_execute', payload: {}, riskLevel: 'HIGH', timeoutSec: 1,
      deciders: [{ role: 'auditor', weight: 1 }],
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      registerApproval(created.value);
      const timedOut = checkTimeoutApprovals(Date.now() + 5000);
      expect(timedOut.some(a => a.approvalId === created.value.approvalId)).toBe(true);
      expect(getApproval(created.value.approvalId)?.status).toBe('TIMEOUT');
    }
  });

  // @matrix:SEC-FREEZEEVADE
  it('SEC-FREEZEEVADE 被冻结 Agent 无法绕过冻结', () => {
    const r = freezeAgent('bad-agent', 'anomaly: rolling window exceeded');
    expect(r.ok).toBe(true);
    expect(isFrozen('bad-agent')).toBe(true);
    // 重复冻结被拒
    expect(freezeAgent('bad-agent', 'again').ok).toBe(false);
  });
});
