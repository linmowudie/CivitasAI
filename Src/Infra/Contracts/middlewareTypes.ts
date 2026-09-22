/**
 * @module Infra/Contracts/middlewareTypes
 * @description
 * 跨层共享内核契约——中间件类型单一真相源。
 *
 * 依据 Docs/02 §1.1 五层单向依赖红线：Core 可依赖 Services/Tools/Infra，
 * Services 可依赖 Tools/Infra，下层绝对不可引用上层。
 *
 * 中间件引擎实现位于 Core/Middleware（registry / 六钩子执行器），
 * 但类型契约需被 Core 与 Services 双方共同引用。若契约留在 Core，
 * 则 Services 层中间件实现（如 LoopControl/middleware/*）将形成
 * Services → Core 的反向依赖违规。故将纯类型契约下沉至 Infra 共享内核，
 * 使 Core→Infra、Services→Infra 均为合规的向下依赖。
 *
 * 约束：本模块必须保持零 import（自洽纯类型），以满足 Infra
 * 「禁止依赖所有上层」红线。运行时引擎仍在 Core，禁止在此添加任何实现逻辑。
 */

// ── 钩子类型 ──────────────────────────────────────────

/** 六种中间件钩子（Docs/02 §4.1） */
export type MiddlewareHook =
  | 'beforeAgent'
  | 'beforeModel'
  | 'wrapModelCall'
  | 'wrapToolCall'
  | 'afterModel'
  | 'afterAgent';

/** 中间件执行上下文 */
export interface MiddlewareContext {
  /** Agent ID */
  agentId: string;
  /** Agent 角色 */
  agentRole: string;
  /** 会话 ID */
  sessionId: string;
  /** 当前迭代 */
  iteration: number;
  /** 追踪 ID */
  traceId: string;
  /** 自定义数据（中间件间传递） */
  data: Record<string, unknown>;
}

/** 模型调用输入 */
export interface ModelCallInput {
  messages: Array<{ role: string; content: string }>;
  model: string;
  temperature: number;
  stream: boolean;
  [key: string]: unknown;
}

/** 模型调用输出 */
export interface ModelCallOutput {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage?: { inputTokens: number; outputTokens: number };
}

/** 工具调用输入 */
export interface ToolCallInput {
  toolName: string;
  arguments: Record<string, unknown>;
  toolCallId: string;
}

/** 工具调用输出 */
export interface ToolCallOutput {
  status: string;
  content: string;
  recoverable: boolean;
}

/** 钩子函数类型 */
export type BeforeAgentHook = (ctx: MiddlewareContext) => Promise<void | { shortCircuit: true; result?: unknown }>;
export type BeforeModelHook = (ctx: MiddlewareContext, messages: ModelCallInput['messages']) => Promise<ModelCallInput['messages'] | { shortCircuit: true; result?: ModelCallOutput }>;
export type WrapModelCallHook = (ctx: MiddlewareContext, input: ModelCallInput, next: (input: ModelCallInput) => Promise<ModelCallOutput>) => Promise<ModelCallOutput>;
export type WrapToolCallHook = (ctx: MiddlewareContext, input: ToolCallInput, next: (input: ToolCallInput) => Promise<ToolCallOutput>) => Promise<ToolCallOutput>;
export type AfterModelHook = (ctx: MiddlewareContext, output: ModelCallOutput) => Promise<ModelCallOutput>;
export type AfterAgentHook = (ctx: MiddlewareContext, result: unknown) => Promise<void>;

export type HookFunction = BeforeAgentHook | BeforeModelHook | WrapModelCallHook | WrapToolCallHook | AfterModelHook | AfterAgentHook;

/** Agent 中间件定义（Docs/02 §4.2） */
export interface AgentMiddleware {
  /** 中间件名称 */
  name: string;
  /** 挂载的钩子 */
  hook: MiddlewareHook;
  /** 同钩子内排序，小的先执行 */
  priority: number;
  /** 是否可短路 */
  canShortCircuit: boolean;
  /** 钩子函数 */
  execute: HookFunction;
}
