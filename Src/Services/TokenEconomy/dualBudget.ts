/**
 * @module TokenEconomy/dualBudget
 * @description
 * 双预算机制——Docs/04 §5.2.1 / Docs/12 §2.3。
 * 四档预算控制：normal → warm → soft → expand_request → hard。
 * 比例数值统一由 loopConfig.stopRules.budget.*Ratio 提供。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 预算阶段 ────────────────────────────────────────────────────────

export type BudgetPhase = 'normal' | 'warm' | 'soft' | 'expand_request' | 'hard';

export interface DualBudgetConfig {
  tokenBudget: number;
  warmRatio: number;
  softRatio: number;
  expandRequestRatio: number;
  hardRatio: number;
}

export interface BudgetStatus {
  phase: BudgetPhase;
  tokensUsed: number;
  tokenBudget: number;
  warmThreshold: number;
  softThreshold: number;
  expandThreshold: number;
  hardThreshold: number;
  remaining: number;
  usageRatio: number;
}

// ── 内部状态 ────────────────────────────────────────────────────────

const traceUsage: Map<string, number> = new Map();
let currentConfig: DualBudgetConfig | null = null;

// ── 初始化 ──────────────────────────────────────────────────────────

export function initDualBudget(config: DualBudgetConfig): void {
  currentConfig = { ...config };
}

// ── 阶段检测 ────────────────────────────────────────────────────────

/**
 * 检测当前预算阶段
 */
export function detectPhase(tokensUsed: number, config: DualBudgetConfig): BudgetPhase {
  const hard = config.tokenBudget * config.hardRatio;
  const expand = config.tokenBudget * config.expandRequestRatio;
  const soft = config.tokenBudget * config.softRatio;
  const warm = config.tokenBudget * config.warmRatio;

  if (tokensUsed >= hard) return 'hard';
  if (tokensUsed >= expand) return 'expand_request';
  if (tokensUsed >= soft) return 'soft';
  if (tokensUsed >= warm) return 'warm';
  return 'normal';
}

/**
 * 获取 trace 的预算状态
 */
export function getBudgetStatus(traceId: string): Result<BudgetStatus> {
  if (!currentConfig) return err('双预算未初始化');

  const tokensUsed = traceUsage.get(traceId) ?? 0;
  const phase = detectPhase(tokensUsed, currentConfig);

  return ok({
    phase,
    tokensUsed,
    tokenBudget: currentConfig.tokenBudget,
    warmThreshold: currentConfig.tokenBudget * currentConfig.warmRatio,
    softThreshold: currentConfig.tokenBudget * currentConfig.softRatio,
    expandThreshold: currentConfig.tokenBudget * currentConfig.expandRequestRatio,
    hardThreshold: currentConfig.tokenBudget * currentConfig.hardRatio,
    remaining: currentConfig.tokenBudget - tokensUsed,
    usageRatio: currentConfig.tokenBudget > 0 ? tokensUsed / currentConfig.tokenBudget : 0,
  });
}

// ── 预算记录 ────────────────────────────────────────────────────────

/**
 * 记录 Token 使用
 */
export function recordUsage(traceId: string, tokens: number): void {
  const current = traceUsage.get(traceId) ?? 0;
  traceUsage.set(traceId, current + tokens);
}

/**
 * 检查单次调用是否超限
 */
export function checkSingleCallLimit(tokens: number): Result<boolean> {
  // 从配置读取单次上限（默认 5000）
  const singleCallMax = 5000;
  if (tokens > singleCallMax) {
    return err(`单次调用 Token (${tokens}) 超过上限 (${singleCallMax})`);
  }
  return ok(true);
}

/**
 * 检查全局 trace 预算
 */
export function checkTraceBudget(traceId: string, additionalTokens: number): Result<BudgetPhase> {
  if (!currentConfig) return err('双预算未初始化');

  const currentUsage = traceUsage.get(traceId) ?? 0;
  const projectedUsage = currentUsage + additionalTokens;
  const phase = detectPhase(projectedUsage, currentConfig);

  if (phase === 'hard') {
    return err(`Trace ${traceId} 硬预算耗尽 (${projectedUsage}/${currentConfig.tokenBudget})`);
  }

  return ok(phase);
}

// ── 预算事件 ────────────────────────────────────────────────────────

export type BudgetEvent =
  | { type: 'BUDGET_WARMING'; traceId: string; tokensUsed: number; threshold: number }
  | { type: 'BUDGET_SOFT_REACHED'; traceId: string; tokensUsed: number; threshold: number }
  | { type: 'APPROVAL_REQUESTED'; traceId: string; kind: 'budget_expand'; tokensUsed: number }
  | { type: 'APPROVAL_TIMEOUT_REJECTED'; traceId: string }
  | { type: 'BUDGET_HARD_REACHED'; traceId: string; tokensUsed: number; threshold: number };

/**
 * 记录使用并检测是否产生预算事件
 */
export function recordUsageAndDetect(traceId: string, tokens: number): BudgetEvent | null {
  if (!currentConfig) return null;

  const prevUsage = traceUsage.get(traceId) ?? 0;
  recordUsage(traceId, tokens);
  const newUsage = prevUsage + tokens;

  const prevPhase = detectPhase(prevUsage, currentConfig);
  const newPhase = detectPhase(newUsage, currentConfig);

  // 阶段变化时产生事件
  if (newPhase !== prevPhase) {
    switch (newPhase) {
      case 'warm':
        return { type: 'BUDGET_WARMING', traceId, tokensUsed: newUsage, threshold: currentConfig.tokenBudget * currentConfig.warmRatio };
      case 'soft':
        return { type: 'BUDGET_SOFT_REACHED', traceId, tokensUsed: newUsage, threshold: currentConfig.tokenBudget * currentConfig.softRatio };
      case 'expand_request':
        return { type: 'APPROVAL_REQUESTED', traceId, kind: 'budget_expand', tokensUsed: newUsage };
      case 'hard':
        return { type: 'BUDGET_HARD_REACHED', traceId, tokensUsed: newUsage, threshold: currentConfig.tokenBudget * currentConfig.hardRatio };
    }
  }

  return null;
}

// ── 清理 ────────────────────────────────────────────────────────────

export function resetDualBudget(): void {
  traceUsage.clear();
  currentConfig = null;
}

export function getTraceUsage(traceId: string): number {
  return traceUsage.get(traceId) ?? 0;
}
