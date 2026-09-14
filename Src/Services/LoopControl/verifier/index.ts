/**
 * @module LoopControl/verifier/index
 * @description
 * 四级验证器统一入口 + 编排器。
 * L1→L2→L3→L4 不可跨越（ADR-0003）：L1 未通过禁止跳到 L3。
 */

export { runHardVerification } from './hardVerifier.js';
export type { HardVerifyContext } from './hardVerifier.js';
export { runRuleVerification } from './ruleVerifier.js';
export type { RuleVerifyContext } from './ruleVerifier.js';
export { runLlmJudge } from './llmJudge.js';
export type { LlmJudgeContext } from './llmJudge.js';
export { runHumanGate } from './humanGateCore.js';
export type { HumanGateContext } from './humanGateCore.js';
export { validateAntiGaming, checkAntiGaming } from './antiGaming.js';
export type { VerifierSpecWithAntiGaming, AntiGamingConfig } from './antiGaming.js';

import type { VerifierSpec, VerifierResult } from '../loopState.js';
import type { Result } from '../../../Infra/types.js';
import { ok, err } from '../../../Infra/types.js';
import { runHardVerification, type HardVerifyContext } from './hardVerifier.js';
import { runRuleVerification, type RuleVerifyContext } from './ruleVerifier.js';
import { runLlmJudge, type LlmJudgeContext } from './llmJudge.js';
import { runHumanGate, type HumanGateContext } from './humanGateCore.js';

/** 四级验证器统一上下文 */
export interface VerifierContext {
  hard: HardVerifyContext;
  rule: RuleVerifyContext;
  llm: LlmJudgeContext;
  human: HumanGateContext;
}

/**
 * 按层级顺序执行验证——ADR-0003 强制执行。
 *
 * 规则：
 * - L1 未通过 → 直接返回，不调用 L2/L3/L4
 * - L2 未通过 → 直接返回，不调用 L3/L4
 * - 每层至少需要 minLevelsRequired=2 层参与
 */
export async function runVerifierPipeline(
  specs: VerifierSpec[],
  ctx: VerifierContext,
  minLevelsRequired: number = 2,
): Promise<Result<{ results: VerifierResult[]; levelsRun: number; allPassed: boolean }>> {
  const allResults: VerifierResult[] = [];
  let levelsRun = 0;

  // L1 硬验证
  const l1Result = await runHardVerification(specs, ctx.hard);
  if (!l1Result.ok) return l1Result;
  allResults.push(...l1Result.value);
  levelsRun++;

  const l1Passed = l1Result.value.every(r => r.pass);
  if (!l1Passed) {
    // ADR-0003: L1 未通过禁止跳到 L3
    return ok({ results: allResults, levelsRun, allPassed: false });
  }

  // L2 规则验证
  const l2Result = await runRuleVerification(specs, ctx.rule);
  if (!l2Result.ok) return l2Result;
  if (l2Result.value.length > 0) {
    allResults.push(...l2Result.value);
    levelsRun++;
    const l2Passed = l2Result.value.every(r => r.pass);
    if (!l2Passed) {
      return ok({ results: allResults, levelsRun, allPassed: false });
    }
  }

  // L3 LLM Judge
  const l3Result = await runLlmJudge(specs, ctx.llm);
  if (!l3Result.ok) return l3Result;
  if (l3Result.value.length > 0) {
    allResults.push(...l3Result.value);
    levelsRun++;
    const l3Passed = l3Result.value.every(r => r.pass);
    if (!l3Passed) {
      return ok({ results: allResults, levelsRun, allPassed: false });
    }
  }

  // L4 人类审批门
  const l4Result = await runHumanGate(specs, ctx.human);
  if (!l4Result.ok) return l4Result;
  if (l4Result.value.length > 0) {
    allResults.push(...l4Result.value);
    levelsRun++;
  }

  // 检查最低层数要求
  if (levelsRun < minLevelsRequired) {
    return err(
      `验证层数不足: 运行了 ${levelsRun} 层，要求至少 ${minLevelsRequired} 层（禁止只用 L3）`,
    );
  }

  return ok({ results: allResults, levelsRun, allPassed: true });
}
