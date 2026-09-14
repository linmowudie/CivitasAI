/**
 * @module LoopControl/strategyLedger
 * @description
 * 策略账本——Docs/12 §5.3。
 * TurnStrategy：每轮结束时的结构化策略摘要。
 * 存储位置：civitas_main.strategies_ledger 为唯一真源。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── TurnStrategy（Docs/12 §5.3）────────────────────────────────────

export interface TurnStrategy {
  iteration: number;
  strategy: string;          // ≤ 30 字
  expectedOutcome: string;
  actualOutcome?: string;
  failureReason?: string;
}

// ── 策略字数限制 ────────────────────────────────────────────────────

const STRATEGY_MAX_CHARS = 30;

/**
 * 验证 TurnStrategy 合法性
 */
export function validateTurnStrategy(ts: TurnStrategy): Result<TurnStrategy> {
  if (ts.strategy.length > STRATEGY_MAX_CHARS) {
    return err(`策略描述超过 ${STRATEGY_MAX_CHARS} 字限制 (实际 ${ts.strategy.length} 字)`);
  }
  if (ts.iteration < 0) {
    return err(`迭代号不能为负 (${ts.iteration})`);
  }
  if (!ts.expectedOutcome || ts.expectedOutcome.trim() === '') {
    return err('expectedOutcome 不能为空');
  }
  return ok(ts);
}

// ── 内存策略账本（Phase 0 用内存存储，后续接入 DB）─────────────────

const ledger: Map<string, TurnStrategy[]> = new Map();

/**
 * 记录一轮策略
 */
export function recordStrategy(loopId: string, strategy: TurnStrategy): Result<void> {
  const validation = validateTurnStrategy(strategy);
  if (!validation.ok) return validation;

  if (!ledger.has(loopId)) {
    ledger.set(loopId, []);
  }
  ledger.get(loopId)!.push({ ...strategy });
  return ok(undefined);
}

/**
 * 回填上一轮的实际结果和失败原因
 */
export function backfillStrategyResult(
  loopId: string,
  iteration: number,
  actualOutcome: string,
  failureReason?: string,
): Result<void> {
  const entries = ledger.get(loopId);
  if (!entries) return err(`Loop ${loopId} 无策略记录`);

  const entry = entries.find(e => e.iteration === iteration);
  if (!entry) return err(`迭代 ${iteration} 无策略记录`);

  entry.actualOutcome = actualOutcome;
  if (failureReason) entry.failureReason = failureReason;
  return ok(undefined);
}

/**
 * 获取 Loop 的所有策略记录
 */
export function getStrategies(loopId: string): TurnStrategy[] {
  return ledger.get(loopId) ?? [];
}

/**
 * 获取已失败的策略摘要列表（用于排除重复策略）
 */
export function getFailedStrategies(loopId: string): string[] {
  const entries = ledger.get(loopId) ?? [];
  return entries
    .filter(e => e.failureReason !== undefined)
    .map(e => e.strategy);
}

/**
 * 选择替代策略——Docs/12 §5.4
 *
 * 当 noProgress.action = 'switch_strategy' 触发时：
 * 1. 禁止简单重跑
 * 2. 排除已失败策略
 * 3. 若无可用策略 → 自动升级为 escalate_human
 */
export function selectNextStrategy(
  loopId: string,
  candidates: string[],
): { strategy: string; escalated: boolean } {
  const failed = new Set(getFailedStrategies(loopId));
  const available = candidates.filter(c => !failed.has(c));

  if (available.length === 0) {
    return { strategy: 'escalate_human', escalated: true };
  }
  return { strategy: available[0], escalated: false };
}

/**
 * 清空账本（测试用）
 */
export function clearLedger(loopId?: string): void {
  if (loopId) {
    ledger.delete(loopId);
  } else {
    ledger.clear();
  }
}
