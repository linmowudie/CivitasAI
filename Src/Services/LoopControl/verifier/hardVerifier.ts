/**
 * @module LoopControl/verifier/hardVerifier
 * @description
 * L1 硬验证器——Docs/12 §3.1。
 * 确定性验证：编译 / 单测 / Schema / 数值阈值 / HTTP 状态码 / 文件存在。
 * Deterministic-First 原则（P1）：优先使用硬约束。
 */

import type { VerifierSpec, VerifierResult } from '../loopState.js';
import type { Result } from '../../../Infra/types.js';
import { ok } from '../../../Infra/types.js';

export interface HardVerifyContext {
  /** 执行命令的函数（test 类型用） */
  execCommand?: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** 检查文件是否存在的函数 */
  fileExists?: (pathPattern: string) => Promise<{ exists: boolean; sizeBytes?: number }>;
  /** HTTP 请求函数 */
  httpCheck?: (url: string) => Promise<{ status: number }>;
  /** 当前指标值（numeric 类型用） */
  currentMetrics?: Record<string, number>;
  /** 待验证的数据（schema 类型用） */
  dataToValidate?: unknown;
}

/**
 * L1 硬验证——逐条执行 VerifierSpec（level=L1）
 */
export async function runHardVerification(
  specs: VerifierSpec[],
  ctx: HardVerifyContext,
): Promise<Result<VerifierResult[]>> {
  const results: VerifierResult[] = [];
  const l1Specs = specs.filter(s => s.level === 'L1');

  for (const spec of l1Specs) {
    const start = Date.now();
    try {
      const result = await executeL1(spec, ctx);
      results.push({
        ...result,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      results.push({
        pass: false,
        level: 'L1',
        kind: spec.kind,
        evidence: [{ kind: 'error_stack', data: { message } }],
        costTokens: 0,
        durationMs: Date.now() - start,
      });
    }
  }

  return ok(results);
}

async function executeL1(
  spec: VerifierSpec,
  ctx: HardVerifyContext,
): Promise<VerifierResult> {
  switch (spec.kind) {
    case 'test': {
      if (!ctx.execCommand) {
        return failResult('L1', 'test', 'execCommand 未提供', 'logic_error');
      }
      const { payload } = spec;
      const result = await ctx.execCommand(payload.command);
      const passed = result.exitCode === payload.expectExit;
      return {
        pass: passed,
        level: 'L1',
        kind: 'test',
        evidence: [{
          kind: 'test_output',
          data: { exitCode: result.exitCode, expected: payload.expectExit, stdout: result.stdout.slice(0, 500) },
        }],
        defectCategory: passed ? undefined : 'logic_error',
        costTokens: 0,
        durationMs: 0,
      };
    }

    case 'schema': {
      // 简化 JSON Schema 验证（检查基本结构）
      const data = ctx.dataToValidate;
      const schema = spec.payload.jsonSchema as Record<string, unknown>;
      const valid = validateBasicSchema(data, schema);
      return {
        pass: valid,
        level: 'L1',
        kind: 'schema',
        evidence: [{ kind: 'diff_from_expected', data: { schema, actual: data } }],
        defectCategory: valid ? undefined : 'spec_missing',
        costTokens: 0,
        durationMs: 0,
      };
    }

    case 'numeric': {
      const { metric, op, threshold } = spec.payload;
      const value = ctx.currentMetrics?.[metric];
      if (value === undefined) {
        return failResult('L1', 'numeric', `指标 ${metric} 不存在`, 'spec_missing');
      }
      let passed = false;
      switch (op) {
        case '<=': passed = value <= threshold; break;
        case '>=': passed = value >= threshold; break;
        case '==': passed = value === threshold; break;
      }
      return {
        pass: passed,
        level: 'L1',
        kind: 'numeric',
        evidence: [{ kind: 'diff_from_expected', data: { metric, op, threshold, actual: value } }],
        defectCategory: passed ? undefined : 'logic_error',
        costTokens: 0,
        durationMs: 0,
      };
    }

    case 'http': {
      if (!ctx.httpCheck) {
        return failResult('L1', 'http', 'httpCheck 未提供', 'external');
      }
      const result = await ctx.httpCheck(spec.payload.url);
      const passed = result.status === spec.payload.expectStatus;
      return {
        pass: passed,
        level: 'L1',
        kind: 'http',
        evidence: [{ kind: 'tool_error', data: { url: spec.payload.url, status: result.status, expected: spec.payload.expectStatus } }],
        defectCategory: passed ? undefined : 'external',
        costTokens: 0,
        durationMs: 0,
      };
    }

    case 'file_exists': {
      if (!ctx.fileExists) {
        return failResult('L1', 'file_exists', 'fileExists 未提供', 'external');
      }
      const result = await ctx.fileExists(spec.payload.pathGlob);
      const sizeOk = spec.payload.minSize !== undefined
        ? ((result.sizeBytes ?? 0) >= spec.payload.minSize)
        : true;
      const passed = result.exists && sizeOk;
      return {
        pass: passed,
        level: 'L1',
        kind: 'file_exists',
        evidence: [{ kind: 'diff_from_expected', data: { path: spec.payload.pathGlob, ...result } }],
        defectCategory: passed ? undefined : 'spec_missing',
        costTokens: 0,
        durationMs: 0,
      };
    }

    default:
      return failResult('L1', (spec as VerifierSpec).kind, `未知 L1 kind`, 'logic_error');
  }
}

function failResult(level: 'L1', kind: string, message: string, defect: 'logic_error' | 'spec_missing' | 'external'): VerifierResult {
  return {
    pass: false,
    level,
    kind,
    evidence: [{ kind: 'error_stack', data: { message } }],
    defectCategory: defect,
    costTokens: 0,
    durationMs: 0,
  };
}

function validateBasicSchema(data: unknown, schema: Record<string, unknown>): boolean {
  if (schema['type'] === 'object' && typeof data !== 'object') return false;
  if (schema['type'] === 'array' && !Array.isArray(data)) return false;
  if (schema['type'] === 'string' && typeof data !== 'string') return false;
  if (schema['type'] === 'number' && typeof data !== 'number') return false;
  // 检查 required 字段
  const required = schema['required'] as string[] | undefined;
  if (required && typeof data === 'object' && data !== null) {
    for (const key of required) {
      if (!(key in data)) return false;
    }
  }
  return true;
}
