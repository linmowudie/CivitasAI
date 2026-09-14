/**
 * @module LoopControl/verifier/ruleVerifier
 * @description
 * L2 规则验证器——Docs/12 §3.1。
 * 规则/参考答案：清单覆盖 / 关键词 / 结构约束。
 */

import type { VerifierSpec, VerifierResult } from '../loopState.js';
import type { Result } from '../../../Infra/types.js';
import { ok } from '../../../Infra/types.js';

export interface RuleVerifyContext {
  /** 待验证的产物内容 */
  artifact: string | object;
  /** 参考答案（golden 类型用） */
  referenceArtifact?: string;
  /** 当前指标 */
  currentMetrics?: Record<string, number>;
}

/**
 * L2 规则验证——逐条执行 VerifierSpec（level=L2）
 */
export async function runRuleVerification(
  specs: VerifierSpec[],
  ctx: RuleVerifyContext,
): Promise<Result<VerifierResult[]>> {
  const results: VerifierResult[] = [];
  const l2Specs = specs.filter(s => s.level === 'L2');

  for (const spec of l2Specs) {
    const start = Date.now();
    const result = await executeL2(spec, ctx);
    results.push({ ...result, durationMs: Date.now() - start });
  }

  return ok(results);
}

async function executeL2(
  spec: VerifierSpec,
  ctx: RuleVerifyContext,
): Promise<VerifierResult> {
  switch (spec.kind) {
    case 'rule': {
      // 简化 CEL/JsonLogic 表达式求值
      const expression = spec.payload.expression;
      const passed = evaluateSimpleRule(expression, ctx);
      return {
        pass: passed,
        level: 'L2',
        kind: 'rule',
        evidence: [{ kind: 'rule_violation', data: { expression, artifact: typeof ctx.artifact === 'string' ? ctx.artifact.slice(0, 200) : 'object' } }],
        defectCategory: passed ? undefined : 'logic_error',
        costTokens: 0,
        durationMs: 0,
      };
    }

    case 'golden': {
      const { referenceArtifactId, tolerance } = spec.payload;
      const reference = ctx.referenceArtifact ?? '';
      const actual = typeof ctx.artifact === 'string' ? ctx.artifact : JSON.stringify(ctx.artifact);
      const similarity = computeSimilarity(reference, actual);
      const passed = similarity >= (1 - tolerance);
      return {
        pass: passed,
        level: 'L2',
        kind: 'golden',
        evidence: [{ kind: 'diff_from_expected', data: { referenceId: referenceArtifactId, similarity, tolerance } }],
        defectCategory: passed ? undefined : 'quality_low',
        costTokens: 0,
        durationMs: 0,
      };
    }

    default:
      return {
        pass: false, level: 'L2', kind: (spec as VerifierSpec).kind,
        evidence: [{ kind: 'error_stack', data: { message: `未知 L2 kind` } }],
        defectCategory: 'logic_error', costTokens: 0, durationMs: 0,
      };
  }
}

/** 简化规则求值（支持 contains / startsWith / endsWith / length） */
function evaluateSimpleRule(expression: string, ctx: RuleVerifyContext): boolean {
  const artifact = typeof ctx.artifact === 'string' ? ctx.artifact : JSON.stringify(ctx.artifact);
  // 支持: contains("xxx"), startsWith("xxx"), length > N
  const containsMatch = expression.match(/contains\("(.+?)"\)/);
  if (containsMatch) return artifact.includes(containsMatch[1]);
  const startsMatch = expression.match(/startsWith\("(.+?)"\)/);
  if (startsMatch) return artifact.startsWith(startsMatch[1]);
  const lengthMatch = expression.match(/length\s*(>=?)\s*(\d+)/);
  if (lengthMatch) {
    const op = lengthMatch[1];
    const n = parseInt(lengthMatch[2]);
    return op === '>=' ? artifact.length >= n : artifact.length > n;
  }
  return false;
}

/** 简单相似度计算（Jaccard on character bigrams） */
function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;
  const bigramsA = new Set<string>();
  const bigramsB = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));
  let intersection = 0;
  for (const bg of bigramsA) if (bigramsB.has(bg)) intersection++;
  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
