/**
 * 工具注册表（Docs/Agent/10 §6.1 / Docs/Agent/02 §7.1 ⑫）
 *
 * 职责：
 * - 扫描 Builtin/ + Custom/ 注册所有工具
 * - 缺必填字段拒注（启动 FATAL）
 * - 提供工具查找和执行入口
 * - DANGEROUS + IRREVERSIBLE 工具必须声明 L4 HumanGate
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import { toCanonicalToolName } from "../../Infra/Llm/Provider/toolNameWireCompat.js";
import type {
  ToolSpec,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "../Traits/toolSpec.js";
import { validateToolSpec } from "../Traits/specValidator.js";
import { logger } from "../../Infra/Logging/logger.js";
import { consumeToolRate } from "./toolRateLimiter.js";
import { getToolServicePorts } from "./toolServicePorts.js";
import { createDefaultSandboxGate } from "./sandboxGate.js";

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
    return err(
      `工具 ${spec.name} 验证失败: ${validation.errors.join("; ")}`,
      "FATAL",
    );
  }

  // 重复注册检查
  if (registry.has(spec.name)) {
    return err(`工具 ${spec.name} 重复注册`, "FATAL");
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
    return err(`所有工具注册失败: ${errors.join("; ")}`, "FATAL");
  }

  return ok(count);
}

/**
 * 查找工具
 *
 * 兼容遗留名：改名（`FileRead` ⇒ `FileRead`）之前的历史/外部调用仍可用旧名查找。
 */
export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name) ?? registry.get(toCanonicalToolName(name));
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
  const tool = registry.get(name) ?? registry.get(toCanonicalToolName(name));
  if (!tool) {
    return {
      role: "tool",
      tool_call_id: context.operationId,
      status: "error",
      recoverable: false,
      error: { code: "TOOL_NOT_FOUND", message: `工具 ${name} 未注册` },
    };
  }

  // requiredRoles 硬校验：调用者角色必须在工具白名单中
  if (!tool.spec.requiredRoles.includes(context.agentRole)) {
    return {
      role: "tool",
      tool_call_id: context.operationId,
      status: "error",
      recoverable: false,
      error: {
        code: "ROLE_FORBIDDEN",
        message: `角色 ${context.agentRole} 无权调用 ${name}`,
      },
    };
  }

  // ── 沙箱承载门（TOOL-SEC-SANDBOX，设计 §3.1）──
  // `sandboxMode` 是安全边界：声明 strict/standard 的工具，必须先确认该等级承载可用，
  // 不可用 → **fail-closed** 拒绝（不降级为普通执行）。
  // 宿主未注入端口时采用**运行时能力声明**（桌面运行时自带工作区隔离）；
  // 受限环境应显式注入 `isAvailable: () => false` 让沙箱工具整体 fail-closed。
  // 位置在角色门之后：越权调用仍优先按 ROLE_FORBIDDEN 拒绝（错误分类语义不变）。
  if (tool.spec.sandboxMode !== "none") {
    const sandboxGate =
      getToolServicePorts().sandboxGate ?? createDefaultSandboxGate();
    const allowed = sandboxGate.isAvailable(tool.spec.sandboxMode) === true;
    if (!allowed) {
      logger.warn("沙箱承载不可用，拒绝执行（fail-closed）", {
        source: "toolRegistry/executeTool",
        toolName: name,
        sandboxMode: tool.spec.sandboxMode,
        agentId: context.agentId,
      });
      return {
        role: "tool",
        tool_call_id: context.operationId,
        status: "error",
        recoverable: true,
        error: {
          code: "SANDBOX_UNAVAILABLE",
          message: `沙箱承载不可用（${tool.spec.sandboxMode}），已 fail-closed 拒绝执行工具 ${name}`,
        },
      };
    }
  }

  // ── agent 级工具白名单（SUB-SEC-TOOLPERM，设计 §3.6）──
  // `allowed_tools` 此前只落库、执行侧零消费 → 权限形同虚设。
  // 上下文提供白名单时，清单外工具一律拒绝（fail-closed）。
  if (
    context.allowedTools !== undefined &&
    !context.allowedTools.includes(name)
  ) {
    logger.warn("工具调用被 agent 白名单拒绝", {
      source: "toolRegistry/executeTool",
      toolName: name,
      agentId: context.agentId,
      allowedCount: context.allowedTools.length,
    });
    return {
      role: "tool",
      tool_call_id: context.operationId,
      status: "error",
      recoverable: false,
      error: {
        code: "TOOL_NOT_ALLOWED",
        message: `工具 ${name} 不在 Agent ${context.agentId} 的白名单内（allowed_tools 强制生效）`,
      },
    };
  }

  // 限流执行方（矩阵 cell TOOL-SEC-RATE）：
  // `rateLimitPerAgent` 此前只是声明字段、零消费方 —— 这里在**派发前**按 agentId+toolName
  // 做滑动窗口计数，超限即拒并留痕（不是"能调、事后统计"）。
  if (tool.spec.rateLimitPerAgent) {
    const gate = consumeToolRate(
      context.agentId,
      name,
      tool.spec.rateLimitPerAgent,
    );
    if (!gate.ok) {
      logger.warn("工具调用被限流拒绝", {
        source: "toolRegistry/executeTool",
        toolName: name,
        agentId: context.agentId,
        used: gate.used,
        max: gate.max,
        retryAfterMs: gate.retryAfterMs,
      });
      return {
        role: "tool",
        tool_call_id: context.operationId,
        status: "error",
        recoverable: true,
        error: {
          code: "TOOL_RATE_LIMITED",
          message: `工具 ${name} 触发限流（${gate.max} 次/窗口），请 ${gate.retryAfterMs ?? 0}ms 后重试`,
        },
      };
    }
  }

  // 超时控制
  const timeoutMs = tool.spec.timeoutMs;
  const timeoutPromise = new Promise<ToolResult>((resolve) => {
    setTimeout(() => {
      resolve({
        role: "tool",
        tool_call_id: context.operationId,
        status: "error",
        recoverable: true,
        error: {
          code: "TOOL_TIMEOUT",
          message: `工具 ${name} 执行超时 (${timeoutMs}ms)`,
        },
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
      role: "tool",
      tool_call_id: context.operationId,
      status: "error",
      recoverable: true,
      error: { code: "TOOL_EXECUTION_ERROR", message },
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
  return Array.from(registry.values()).map((d) => d.spec);
}

/**
 * 按危险级别过滤工具
 */
export function getToolsByDangerLevel(level: string): ToolSpec[] {
  return getAllToolSpecs().filter((s) => s.dangerLevel === level);
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
