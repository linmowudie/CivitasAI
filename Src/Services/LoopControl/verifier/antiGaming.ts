/**
 * @module LoopControl/verifier/antiGaming
 * @description
 * Reward Hacking 防御——Docs/12 §3.4。
 * 每个 VerifierSpec 声明时必须同时声明 anti-gaming 补充信号。
 * Goodhart 定律：当度量变成目标，它就不再是好的度量。
 */

import type { VerifierSpec, VerifierResult } from '../loopState.js';

/** 带反博弈的验证规范 */
export interface VerifierSpecWithAntiGaming {
  primary: VerifierSpec;
  antiGaming: VerifierSpec[];
}

/** 反博弈配置 */
export interface AntiGamingConfig {
  minRules: number;
  maxChangedFiles: number;
}

/**
 * 验证反博弈规则是否满足最低要求
 */
export function validateAntiGaming(
  spec: VerifierSpecWithAntiGaming,
  config: AntiGamingConfig,
): { valid: boolean; error?: string } {
  if (spec.antiGaming.length < config.minRules) {
    return {
      valid: false,
      error: `反博弈规则数 (${spec.antiGaming.length}) < 最低要求 (${config.minRules})`,
    };
  }
  return { valid: true };
}

/**
 * 执行反博弈检查
 *
 * 典型反博弈规则示例：
 * - primary = "所有测试通过" → antiGaming = "测试文件未被修改/删除" + "变更文件数 ≤ 8"
 */
export function checkAntiGaming(
  primaryResult: VerifierResult,
  antiGamingResults: VerifierResult[],
  config: AntiGamingConfig,
): { passed: boolean; violations: string[] } {
  const violations: string[] = [];

  // 如果主验证失败，不需要反博弈检查
  if (!primaryResult.pass) {
    return { passed: false, violations: ['primary verification failed'] };
  }

  // 检查所有反博弈规则是否通过
  for (const agResult of antiGamingResults) {
    if (!agResult.pass) {
      const desc = agResult.evidence.map(e => JSON.stringify(e.data)).join('; ');
      violations.push(`反博弈违规 (${agResult.kind}): ${desc}`);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
