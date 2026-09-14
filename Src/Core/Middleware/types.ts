/**
 * @module Middleware/types
 * @description
 * 中间件类型定义——Docs/02 §4。
 * 六钩子 + AgentMiddleware 接口。
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
