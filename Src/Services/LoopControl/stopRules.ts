/**
 * @module LoopControl/stopRules
 * @description
 * 五类独立退出条件——Docs/Agent/11 §2。
 * 判定优先级：⑤风险 → ②上限 → ③预算 → ④无进展 → ①成功 → 继续下一轮。
 * 成功判定必须放在所有失败判定之后。
 */

import type { LoopState, VerifierSpec } from './loopState.js';
import type { StoppedReason } from './types.js';

// ── StopRuleSet（Docs/Agent/11 §2.1）─────────────────────────────────────

export interface StopLimits {
  maxIterations: number;
  maxWallClockMs: number;
  maxToolCalls: number;
  maxConsecutiveErrors: number;
}

export interface StopBudget {
  softTokens: number;
  hardTokens: number;
  warmTokens: number;
  expandRequestTokens: number;
  softUsd?: number;
  hardUsd?: number;
}

export interface StopNoProgress {
  metric: 'failed_tests' | 'validation_score' | 'goal_distance' | 'custom';
  stagnationWindow: number;
  minDelta: number;
  action: 'switch_strategy' | 'escalate_human' | 'abort';
}

export interface RiskTrigger {
  condition: string;
  action: 'pause_and_request_approval' | 'abort' | 'rollback_and_abort';
}

export interface StopRuleSet {
  successCriteria: VerifierSpec[];
  limits: StopLimits;
  budget: StopBudget;
  noProgress: StopNoProgress;
  riskTriggers: RiskTrigger[];
}

// ── 退出判定结果 ────────────────────────────────────────────────────

export type StopDecision =
  | { shouldStop: true; reason: StoppedReason; detail: string }
  | { shouldStop: false };

// ── 运行时状态快照（供判定用）─────────────────────────────────────

export interface LoopRuntimeSnapshot {
  iteration: number;
  startedAt: number;
  toolCallCount: number;
  consecutiveErrors: number;
  budgetUsed: { tokens: number; usd: number };
  recentMetrics: number[];
  riskSignals: string[];
  verifierPassed: boolean;
}

// ── 判定优先级（Docs/Agent/11 §2.2）───────────────────────────────────────

const EVALUATION_ORDER: StoppedReason[] = [
  'risk', 'limits', 'budget_hard', 'no_progress', 'success',
];

/**
 * 评估是否应停止（每轮迭代末尾调用）
 *
 * 优先级：⑤风险 → ②上限 → ③硬预算 → ④无进展 → ①成功 → 继续
 */
export function evaluateStopRules(
  rules: StopRuleSet,
  _state: LoopState,
  snapshot: LoopRuntimeSnapshot,
): StopDecision {
  // ⑤ 风险退出
  const riskResult = checkRisk(rules, snapshot);
  if (riskResult) return riskResult;

  // ② 上限退出
  const limitResult = checkLimits(rules, snapshot);
  if (limitResult) return limitResult;

  // ③ 硬预算退出
  const budgetResult = checkHardBudget(rules, snapshot);
  if (budgetResult) return budgetResult;

  // ④ 无进展退出
  const noProgressResult = checkNoProgress(rules, snapshot);
  if (noProgressResult) return noProgressResult;

  // ① 成功退出（必须在所有失败判定之后）
  if (snapshot.verifierPassed) {
    return { shouldStop: true, reason: 'success', detail: 'Verifier 通过' };
  }

  return { shouldStop: false };
}

// ── 各子检查 ────────────────────────────────────────────────────────

function checkRisk(rules: StopRuleSet, snapshot: LoopRuntimeSnapshot): StopDecision | null {
  if (snapshot.riskSignals.length === 0) {
    return null;
  }

  // FE-070：有触发器声明时按触发器处置（condition 可被真实评估：`signal == "值"` / 关键词）；
  // 此前“任何信号→停”前置短路使配置的 riskTriggers 成为**死分支**。
  if (rules.riskTriggers.length > 0) {
    let coveredByPause = false;
    let abortTrigger: string | null = null;
    for (const trigger of rules.riskTriggers) {
      if (!evaluateRiskCondition(trigger.condition, snapshot)) continue;
      if (trigger.action === 'abort' || trigger.action === 'rollback_and_abort') {
        abortTrigger = trigger.condition;
        break;
      }
      // pause_and_request_approval：本层不中止（审批动作由 approvalGate 承担）
      coveredByPause = true;
    }
    if (abortTrigger !== null) {
      return {
        shouldStop: true,
        reason: 'risk',
        detail: `风险触发器命中: ${abortTrigger}`,
      };
    }
    if (coveredByPause) {
      // 全部命中项均为 pause 类 → 放行（已交审批语义）
      return null;
    }
    // 信号未被任何触发器覆盖 → 保守退出（fail-safe，与无触发器时语义一致）
  }

  return {
    shouldStop: true,
    reason: 'risk',
    detail: `风险信号: ${snapshot.riskSignals.join(', ')}`,
  };
}

function checkLimits(rules: StopRuleSet, snapshot: LoopRuntimeSnapshot): StopDecision | null {
  if (snapshot.iteration >= rules.limits.maxIterations) {
    return {
      shouldStop: true,
      reason: 'limits',
      detail: `达到最大迭代数 ${rules.limits.maxIterations}`,
    };
  }
  const elapsed = Date.now() - snapshot.startedAt;
  if (elapsed >= rules.limits.maxWallClockMs) {
    return {
      shouldStop: true,
      reason: 'limits',
      detail: `达到最大墙钟时间 ${rules.limits.maxWallClockMs}ms`,
    };
  }
  if (snapshot.toolCallCount >= rules.limits.maxToolCalls) {
    return {
      shouldStop: true,
      reason: 'limits',
      detail: `达到最大工具调用数 ${rules.limits.maxToolCalls}`,
    };
  }
  if (snapshot.consecutiveErrors >= rules.limits.maxConsecutiveErrors) {
    return {
      shouldStop: true,
      reason: 'limits',
      detail: `连续错误数 ${snapshot.consecutiveErrors} >= ${rules.limits.maxConsecutiveErrors}`,
    };
  }
  return null;
}

function checkHardBudget(rules: StopRuleSet, snapshot: LoopRuntimeSnapshot): StopDecision | null {
  if (snapshot.budgetUsed.tokens >= rules.budget.hardTokens) {
    return {
      shouldStop: true,
      reason: 'budget_hard',
      detail: `Token 硬预算耗尽 (${snapshot.budgetUsed.tokens}/${rules.budget.hardTokens})`,
    };
  }
  if (rules.budget.hardUsd !== undefined && snapshot.budgetUsed.usd >= rules.budget.hardUsd) {
    return {
      shouldStop: true,
      reason: 'budget_hard',
      detail: `USD 硬预算耗尽 (${snapshot.budgetUsed.usd}/${rules.budget.hardUsd})`,
    };
  }
  return null;
}

function checkNoProgress(rules: StopRuleSet, snapshot: LoopRuntimeSnapshot): StopDecision | null {
  const { recentMetrics } = snapshot;
  if (recentMetrics.length < rules.noProgress.stagnationWindow) return null;

  const window = recentMetrics.slice(-rules.noProgress.stagnationWindow);
  const first = window[0];
  const last = window[window.length - 1];
  if (first === undefined || last === undefined) return null;
  const delta = first === 0 ? (last > 0 ? 1.0 : 0.0) : (last - first) / Math.abs(first);

  if (delta < rules.noProgress.minDelta) {
    return {
      shouldStop: true,
      reason: 'no_progress',
      detail: `连续 ${rules.noProgress.stagnationWindow} 轮无进展 (delta=${delta.toFixed(4)} < ${rules.noProgress.minDelta})`,
    };
  }
  return null;
}

// ── 预算阶段检测（软预算 / 预热 / 扩展审批）────────────────────────

export type BudgetPhase = 'warm' | 'soft' | 'expand_request' | 'hard' | 'normal';

export function detectBudgetPhase(
  rules: StopRuleSet,
  tokensUsed: number,
): BudgetPhase {
  if (tokensUsed >= rules.budget.hardTokens) return 'hard';
  if (tokensUsed >= rules.budget.expandRequestTokens) return 'expand_request';
  if (tokensUsed >= rules.budget.softTokens) return 'soft';
  if (tokensUsed >= rules.budget.warmTokens) return 'warm';
  return 'normal';
}

// ── 风险条件简单解析器（DSL 仅支持 == + 字符串枚举）────────────────

/**
 * 风险条件求值（FE-070 增强）：
 *  - v1 可执行语法：`signal == "值"`（精确匹配 riskSignals 成员）；
 *  - 保留关键词包含匹配（历史兼容；完整 DSL 仍属后续）。
 */
function evaluateRiskCondition(condition: string, snapshot: LoopRuntimeSnapshot): boolean {
  const trimmed = condition.trim();
  const exact = /^signal\s*==\s*"([^"]+)"\s*$/.exec(trimmed);
  if (exact) {
    return snapshot.riskSignals.includes(exact[1]!);
  }
  const normalized = trimmed.toLowerCase();
  return snapshot.riskSignals.some(s => normalized.includes(s.toLowerCase()));
}

// ── 从配置构建 StopRuleSet ──────────────────────────────────────────

export function buildStopRuleSet(config: {
  tokenBudget: number;
  softRatio: number;
  hardRatio: number;
  warmRatio: number;
  expandRequestRatio: number;
  limits: StopLimits;
  noProgress: StopNoProgress;
  successCriteria?: VerifierSpec[];
  riskTriggers?: RiskTrigger[];
}): StopRuleSet {
  return {
    successCriteria: config.successCriteria ?? [],
    limits: config.limits,
    budget: {
      softTokens: Math.floor(config.tokenBudget * config.softRatio),
      hardTokens: Math.floor(config.tokenBudget * config.hardRatio),
      warmTokens: Math.floor(config.tokenBudget * config.warmRatio),
      expandRequestTokens: Math.floor(config.tokenBudget * config.expandRequestRatio),
    },
    noProgress: config.noProgress,
    riskTriggers: config.riskTriggers ?? [],
  };
}

/** 获取评估顺序（供测试验证） */
export function getEvaluationOrder(): StoppedReason[] {
  return [...EVALUATION_ORDER];
}

// ── 全局 StopRuleSet 存储（供 runIteration 读取，消除硬重建）──────────

let _activeStopRuleSet: StopRuleSet | null = null;

/**
 * 设置当前生效的 StopRuleSet（由 main.ts 启动时从配置构建后调用）。
 * runIteration 通过 getActiveStopRuleSet() 读取，而非每次迭代硬重建默认规则。
 */
export function setActiveStopRuleSet(rules: StopRuleSet): void {
  _activeStopRuleSet = rules;
}

/** 获取当前生效的 StopRuleSet（未设置则返回 null）。 */
export function getActiveStopRuleSet(): StopRuleSet | null {
  return _activeStopRuleSet;
}
