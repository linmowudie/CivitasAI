/**
 * 工具规格定义（Docs/11 §6.1）
 *
 * 所有工具注册时必须提供完整的 ToolSpec。
 * v2 新增三必填字段：idempotency / reversibility / sideEffectScope。
 * 缺一字段则 Registry 拒注（CI 也拦截）。
 */

import type { DangerLevel } from '../../Infra/Security/trustLevels.js';

// ===== 类型定义 =====

/** JSON Schema 简化类型 */
export interface JsonSchema {
  readonly type: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly description?: string;
  readonly enum?: string[];
}

/** 幂等性声明（Docs/11 §6.1 / Docs/13 §7） */
export type Idempotency = 'YES' | 'NO' | 'CONDITIONAL';

/** 可逆性声明（Docs/11 §6.1） */
export type Reversibility = 'REVERSIBLE' | 'PARTIAL' | 'IRREVERSIBLE';

/** 副作用范围 */
export type SideEffectScope = 'none' | 'workspace' | 'filesystem' | 'network' | 'process' | 'external';

/** 沙箱模式 */
export type SandboxMode = 'strict' | 'standard' | 'none';

/** 用户角色（v2.2：统一引用 Infra 层 UserRole） */
export type { UserRole } from '../../Infra/types.js';
import type { UserRole } from '../../Infra/types.js';

/** 限流配置 */
export interface RateLimit {
  readonly max: number;
  readonly windowMs: number;
}

/**
 * 工具规格（Docs/11 §6.1）
 *
 * 所有字段均为必填（除 idempotencyKeyFields 和 rateLimitPerAgent）。
 * 缺失任何必填字段 → Registry 拒注。
 */
export interface ToolSpec {
  /** 工具名称（全局唯一），如 'file.read' */
  readonly name: string;
  /** 语义化版本 */
  readonly version: string;
  /** 展示给模型的描述（单一职责） */
  readonly description: string;
  /** 输入 Schema（严格，禁止 additionalProperties:true） */
  readonly inputSchema: JsonSchema;
  /** 输出 Schema（必须包含 status + recoverable） */
  readonly outputSchema: JsonSchema;

  /** 危险分级（Docs/11 §3.3） */
  readonly dangerLevel: DangerLevel;

  // v2 新增三项必填
  /** 幂等性声明 */
  readonly idempotency: Idempotency;
  /** 幂等键字段（idempotency != 'NO' 时必填） */
  readonly idempotencyKeyFields?: string[];
  /** 可逆性声明 */
  readonly reversibility: Reversibility;
  /** 副作用范围 */
  readonly sideEffectScope: SideEffectScope;

  // 安全执行参数
  /** 需要的最低角色 */
  readonly requiredRoles: UserRole[];
  /** 沙箱模式 */
  readonly sandboxMode: SandboxMode;
  /** 执行超时（ms），默认 30_000 */
  readonly timeoutMs: number;
  /** 每 Agent 限流 */
  readonly rateLimitPerAgent?: RateLimit;
}

/**
 * 工具执行上下文
 *
 * wrapToolCall 包裹时传入。
 */
export interface ToolExecutionContext {
  /** 操作 ID（用于 tool_call_id） */
  readonly operationId: string;
  /** 调用者 Agent ID */
  readonly agentId: string;
  /** 调用者角色 */
  readonly agentRole: UserRole;
  /** Loop ID（用于 EffectJournal） */
  readonly loopId?: string;
  /** trace_id */
  readonly traceId?: string;
  /** AbortSignal */
  readonly signal?: AbortSignal;
}

/**
 * 工具统一返回格式（Docs/11 §6.2）
 */
export interface ToolResult {
  readonly role: 'tool';
  readonly tool_call_id: string;
  readonly status: 'success' | 'error';
  readonly recoverable: boolean;
  readonly content?: unknown;
  readonly effects?: string[];
  readonly artifacts?: ArtifactEntry[];
  readonly error?: ToolError;
}

/** 产物条目 */
export interface ArtifactEntry {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

/** 工具错误 */
export interface ToolError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

// ===== 辅助构造函数 =====

/** 创建成功结果 */
export function toolSuccess(
  toolCallId: string,
  content: unknown,
  extras?: { effects?: string[]; artifacts?: ArtifactEntry[] },
): ToolResult {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    status: 'success',
    recoverable: false,
    content,
    effects: extras?.effects,
    artifacts: extras?.artifacts,
  };
}

/** 创建错误结果 */
export function toolError(
  toolCallId: string,
  code: string,
  message: string,
  recoverable = true,
  details?: Record<string, unknown>,
): ToolResult {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    status: 'error',
    recoverable,
    error: { code, message, details },
  };
}

/**
 * 工具执行函数类型
 *
 * 每个工具实现必须提供此签名的 execute 函数。
 */
export type ToolExecutor = (
  input: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

/**
 * 完整工具定义（Spec + Executor）
 */
export interface ToolDefinition {
  readonly spec: ToolSpec;
  readonly execute: ToolExecutor;
}
