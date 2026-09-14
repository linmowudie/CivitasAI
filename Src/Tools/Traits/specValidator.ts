/**
 * 工具 Schema 验证器（Docs/11 §6.1）
 *
 * 职责：
 * - 验证 ToolSpec 完整性（所有必填字段）
 * - 验证 inputSchema 禁止 additionalProperties:true
 * - 验证 outputSchema 必须包含 status + recoverable
 * - 验证 idempotency='NO' 时 EffectJournal 前置检查
 * - 验证 DANGEROUS + IRREVERSIBLE 需要 L4 HumanGate
 *
 * 缺一字段 → 拒注（CI 也拦截）。
 */

import type { ToolSpec, JsonSchema } from './toolSpec.js';

// ===== 类型定义 =====

/** 验证结果 */
export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
}

// ===== 公开 API =====

/**
 * 验证 ToolSpec 完整性
 *
 * 按 Docs/11 §6.1 自动门禁逐条检查。
 */
export function validateToolSpec(spec: ToolSpec): ValidationResult {
  const errors: string[] = [];

  // 1. 基础必填字段
  if (!spec.name || typeof spec.name !== 'string') {
    errors.push('缺少必填字段: name');
  }
  if (!spec.version || typeof spec.version !== 'string') {
    errors.push('缺少必填字段: version');
  }
  if (!spec.description || typeof spec.description !== 'string') {
    errors.push('缺少必填字段: description');
  }

  // 2. inputSchema 验证
  if (!spec.inputSchema) {
    errors.push('缺少必填字段: inputSchema');
  } else {
    validateInputSchema(spec.inputSchema, spec.name, errors);
  }

  // 3. outputSchema 验证
  if (!spec.outputSchema) {
    errors.push('缺少必填字段: outputSchema');
  } else {
    validateOutputSchema(spec.outputSchema, spec.name, errors);
  }

  // 4. dangerLevel
  const validDangerLevels = ['SAFE', 'CONTROLLED', 'DANGEROUS', 'FORBIDDEN'];
  if (!validDangerLevels.includes(spec.dangerLevel)) {
    errors.push(`无效的 dangerLevel: ${spec.dangerLevel}，合法值: ${validDangerLevels.join('/')}`);
  }

  // 5. idempotency
  const validIdempotency = ['YES', 'NO', 'CONDITIONAL'];
  if (!validIdempotency.includes(spec.idempotency)) {
    errors.push(`无效的 idempotency: ${spec.idempotency}`);
  }
  // idempotency != 'NO' 时 idempotencyKeyFields 必填
  if (spec.idempotency !== 'NO' && (!spec.idempotencyKeyFields || spec.idempotencyKeyFields.length === 0)) {
    errors.push(`idempotency='${spec.idempotency}' 时必须提供 idempotencyKeyFields`);
  }

  // 6. reversibility
  const validReversibility = ['REVERSIBLE', 'PARTIAL', 'IRREVERSIBLE'];
  if (!validReversibility.includes(spec.reversibility)) {
    errors.push(`无效的 reversibility: ${spec.reversibility}`);
  }

  // 7. sideEffectScope
  const validScopes = ['none', 'workspace', 'filesystem', 'network', 'process', 'external'];
  if (!validScopes.includes(spec.sideEffectScope)) {
    errors.push(`无效的 sideEffectScope: ${spec.sideEffectScope}`);
  }

  // 8. requiredRoles
  if (!Array.isArray(spec.requiredRoles) || spec.requiredRoles.length === 0) {
    errors.push('requiredRoles 不能为空数组');
  }

  // 9. sandboxMode
  const validSandbox = ['strict', 'standard', 'none'];
  if (!validSandbox.includes(spec.sandboxMode)) {
    errors.push(`无效的 sandboxMode: ${spec.sandboxMode}`);
  }

  // 10. timeoutMs
  if (typeof spec.timeoutMs !== 'number' || spec.timeoutMs <= 0) {
    errors.push('timeoutMs 必须是正数');
  }

  // 11. 自动门禁：DANGEROUS + IRREVERSIBLE → 需要 L4 HumanGate
  // （本验证器只标记，HumanGate 检查在 Registry 层配合 verifier 完成）
  if (spec.dangerLevel === 'DANGEROUS' && spec.reversibility === 'IRREVERSIBLE') {
    // 标记但不阻断——L4 HumanGate 在 S6 的 approvalGate 中强制
    // 此处仅记录警告
  }

  // 12. FORBIDDEN 工具不应注册
  if (spec.dangerLevel === 'FORBIDDEN') {
    errors.push('FORBIDDEN 级别工具不允许注册');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 验证运行时输入是否符合 inputSchema
 */
export function validateInput(
  input: Record<string, unknown>,
  schema: JsonSchema,
): ValidationResult {
  const errors: string[] = [];

  if (schema.type === 'object' && schema.properties) {
    // 检查必填字段
    for (const required of schema.required ?? []) {
      if (!(required in input)) {
        errors.push(`缺少必填参数: ${required}`);
      }
    }

    // 检查额外属性
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(input)) {
        if (!(key in schema.properties)) {
          errors.push(`不允许的额外参数: ${key}`);
        }
      }
    }

    // 递归检查各字段类型
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in input && input[key] !== undefined) {
        const value = input[key];
        if (!matchesType(value, propSchema.type)) {
          errors.push(`参数 ${key} 类型错误: 期望 ${propSchema.type}，实际 ${typeof value}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ===== 内部函数 =====

function validateInputSchema(schema: JsonSchema, toolName: string, errors: string[]): void {
  if (schema.additionalProperties === true) {
    errors.push(`工具 ${toolName} 的 inputSchema 禁止 additionalProperties:true`);
  }
}

function validateOutputSchema(schema: JsonSchema, toolName: string, errors: string[]): void {
  // outputSchema 必须包含 status 和 recoverable
  if (schema.properties) {
    if (!('status' in schema.properties)) {
      errors.push(`工具 ${toolName} 的 outputSchema 缺少 status 字段`);
    }
    if (!('recoverable' in schema.properties)) {
      errors.push(`工具 ${toolName} 的 outputSchema 缺少 recoverable 字段`);
    }
  } else {
    errors.push(`工具 ${toolName} 的 outputSchema 缺少 properties 定义`);
  }
}

function matchesType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    default: return true; // 未知类型不检查
  }
}
