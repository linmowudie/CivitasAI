/**
 * @module LoopControl/verifier/llmJudge
 * @description
 * L3 独立 LLM 评分器——Docs/12 §3.1。
 * 必须使用与产出者不同的模型（ADR-0004 / P2 Maker ≠ Checker）。
 * L3 输出必须结构化：{pass, evidence[], defectCategory}。
 */

import type { VerifierSpec, VerifierResult } from '../loopState.js';
import type { Result } from '../../../Infra/types.js';
import { ok, err } from '../../../Infra/types.js';

export interface LlmJudgeContext {
  /** 待评分的产物 */
  artifact: string;
  /** 产出者模型 ID（必须 ≠ judge 模型） */
  producerModel: string;
  /** LLM 调用函数 */
  callModel?: (model: string, prompt: string) => Promise<string>;
}

/**
 * L3 LLM Judge 验证——逐条执行 VerifierSpec（level=L3）
 *
 * 关键约束：
 * - spec.payload.model 必须 ≠ producerModel（运行期校验）
 * - 输出必须结构化（禁止返回自然语言评分）
 */
export async function runLlmJudge(
  specs: VerifierSpec[],
  ctx: LlmJudgeContext,
): Promise<Result<VerifierResult[]>> {
  const results: VerifierResult[] = [];
  const l3Specs = specs.filter(s => s.level === 'L3');

  for (const spec of l3Specs) {
    const start = Date.now();

    // ADR-0004: Maker ≠ Checker
    if (spec.payload.model === ctx.producerModel) {
      return err(
        `L3 Judge 模型 (${spec.payload.model}) 与产出者模型相同，违反 ADR-0004`,
      );
    }

    if (!ctx.callModel) {
      results.push({
        pass: false, level: 'L3', kind: 'llm_judge',
        evidence: [{ kind: 'error_stack', data: { message: 'callModel 未提供' } }],
        defectCategory: 'external', costTokens: 0, durationMs: Date.now() - start,
      });
      continue;
    }

    try {
      const result = await executeL3(spec, ctx);
      results.push({ ...result, durationMs: Date.now() - start });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      results.push({
        pass: false, level: 'L3', kind: 'llm_judge',
        evidence: [{ kind: 'judge_rubric', data: { message } }],
        defectCategory: 'external', costTokens: 0, durationMs: Date.now() - start,
      });
    }
  }

  return ok(results);
}

async function executeL3(
  spec: VerifierSpec,
  ctx: LlmJudgeContext,
): Promise<VerifierResult> {
  const { model, rubric, minScore } = spec.payload;

  const prompt = buildJudgePrompt(ctx.artifact, rubric, minScore);
  const response = await ctx.callModel!(model, prompt);

  // 解析结构化输出
  const parsed = parseJudgeResponse(response, minScore);

  return {
    pass: parsed.pass,
    level: 'L3',
    kind: 'llm_judge',
    evidence: parsed.evidence,
    defectCategory: parsed.pass ? undefined : parsed.defectCategory,
    costTokens: estimateTokens(prompt + response),
    durationMs: 0,
  };
}

function buildJudgePrompt(artifact: string, rubric: unknown[], minScore: number): string {
  return [
    'You are an independent quality judge. Evaluate the following artifact.',
    `Minimum acceptable score: ${minScore} (0.0-1.0 scale)`,
    `Rubric criteria: ${JSON.stringify(rubric)}`,
    '',
    '--- ARTIFACT ---',
    artifact.slice(0, 4000),
    '',
    'Respond in JSON: {"score": number, "pass": boolean, "evidence": [...], "defectCategory": string}',
  ].join('\n');
}

function parseJudgeResponse(
  response: string,
  minScore: number,
): { pass: boolean; evidence: Array<{ kind: string; data: unknown }>; defectCategory: 'quality_low' | 'logic_error' | 'spec_missing' | 'risk_violation' } {
  try {
    const json = JSON.parse(response);
    return {
      pass: Boolean(json.pass) && (json.score ?? 0) >= minScore,
      evidence: [{ kind: 'judge_rubric', data: json }],
      defectCategory: json.defectCategory ?? 'quality_low',
    };
  } catch {
    return {
      pass: false,
      evidence: [{ kind: 'judge_rubric', data: { raw: response.slice(0, 500) } }],
      defectCategory: 'quality_low',
    };
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
