/**
 * 工具注册表（Docs/11 §6.1 / Docs/02 §7.1 ⑫）
 *
 * 职责：
 * - 扫描 Builtin/ + Custom/ 注册所有工具
 * - 缺必填字段拒注（启动 FATAL）
 * - 提供工具查找和执行入口
 * - DANGEROUS + IRREVERSIBLE 工具必须声明 L4 HumanGate
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import type { ToolSpec, ToolDefinition, ToolExecutor, ToolExecutionContext, ToolResult } from '../Traits/toolSpec.js';
import { validateToolSpec } from '../Traits/specValidator.js';

// ===== 内部状态 =====

const registry = new Map<string, ToolDefinition>();

// ===== 公开 API =====

/**
 * 注册工具
 *
 * 验证 ToolSpec 完整性，缺字段拒注。
 * FORBIDDEN 级别永不注册。
 */
export function registerTool(definition: ToolDefinition): Result<void> {
  const { spec } = definition;

  // Schema 验证
  const validation = validateToolSpec(spec);
  if (!validation.valid) {
    return err(`工具 ${spec.name} 验证失败: ${validation.errors.join('; ')}`, 'FATAL');
  }

  // 重复注册检查
  if (registry.has(spec.name)) {
    return err(`工具 ${spec.name} 重复注册`, 'FATAL');
  }

  registry.set(spec.name, definition);
  return ok(undefined);
}

/**
 * 批量注册工具
 */
export function registerTools(definitions: ToolDefinition[]): Result<number> {
  let count = 0;
  const errors: string[] = [];

  for (const def of definitions) {
    const result = registerTool(def);
    if (result.ok) {
      count++;
    } else {
      errors.push(result.error);
    }
  }

  if (errors.length > 0 && count === 0) {
    return err(`所有工具注册失败: ${errors.join('; ')}`, 'FATAL');
  }

  return ok(count);
}

/**
 * 查找工具
 */
export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

/**
 * 执行工具
 *
 * 统一入口，带超时控制。
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    return {
      role: 'tool',
      tool_call_id: context.operationId,
      status: 'error',
      recoverable: false,
      error: { code: 'TOOL_NOT_FOUND', message: `工具 ${name} 未注册` },
    };
  }

  // requiredRoles 硬校验：调用者角色必须在工具白名单中
  if (!tool.spec.requiredRoles.includes(context.agentRole)) {
    return {
      role: 'tool',
      tool_call_id: context.operationId,
      status: 'error',
      recoverable: false,
      error: { code: 'ROLE_FORBIDDEN', message: `角色 ${context.agentRole} 无权调用 ${name}` },
    };
  }

  // 超时控制
  const timeoutMs = tool.spec.timeoutMs;
  const timeoutPromise = new Promise<ToolResult>((resolve) => {
    setTimeout(() => {
      resolve({
        role: 'tool',
        tool_call_id: context.operationId,
        status: 'error',
        recoverable: true,
        error: { code: 'TOOL_TIMEOUT', message: `工具 ${name} 执行超时 (${timeoutMs}ms)` },
      });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      tool.execute(input, context),
      timeoutPromise,
    ]);
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      role: 'tool',
      tool_call_id: context.operationId,
      status: 'error',
      recoverable: true,
      error: { code: 'TOOL_EXECUTION_ERROR', message },
    };
  }
}

/**
 * 获取所有已注册工具名
 */
export function getRegisteredToolNames(): string[] {
  return Array.from(registry.keys());
}

/**
 * 获取所有已注册工具的 Spec（供模型使用）
 */
export function getAllToolSpecs(): ToolSpec[] {
  return Array.from(registry.values()).map(d => d.spec);
}

/**
 * 按危险级别过滤工具
 */
export function getToolsByDangerLevel(level: string): ToolSpec[] {
  return getAllToolSpecs().filter(s => s.dangerLevel === level);
}

/**
 * 获取指定工具数量
 */
export function getToolCount(): number {
  return registry.size;
}

/**
 * 清除所有注册（测试用）
 */
export function clearRegistry(): void {
  registry.clear();
}

/**
 * 检查工具是否已注册
 */
export function isToolRegistered(name: string): boolean {
  return registry.has(name);
}
