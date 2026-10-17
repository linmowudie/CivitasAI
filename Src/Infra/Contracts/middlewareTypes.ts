/**
 * @module Infra/Contracts/middlewareTypes
 * @description
 * 跨层共享内核契约——中间件类型单一真相源。
 *
 * 依据 Docs/Agent/02 §1.1 五层单向依赖红线：Core 可依赖 Services/Tools/Infra，
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

/** 六种中间件钩子（Docs/Agent/02 §4.1） */
export type MiddlewareHook =
  | "beforeAgent"
  | "beforeModel"
  | "wrapModelCall"
  | "wrapToolCall"
  | "afterModel"
  | "afterAgent";

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
  /**
   * 所属 Loop ID（P0-2 修复：回路作用域）。
   *
   * 为什么必须有：中间件注册表是**进程级**的，而 ToolSafetyGate 这类安全执行器是
   * **Loop 实例级**的。没有 loopId 时，会话 A 的循环结束会按名注销掉全局唯一的安全门，
   * 仍在运行的会话 B 随即失去 FORBIDDEN 硬拒 / 审批门 / EffectJournal 全套管控；
   * 反向地，B 的轮次也可能被 A 的安全门拦截（归属错位，审计链污染）。
   * 执行器据此只运行「全局中间件 + ownerId 与本 loopId 相同」的中间件。
   */
  loopId?: string;
  /** 自定义数据（中间件间传递） */
  data: Record<string, unknown>;
}

/**
 * 模型发起的工具调用（与 `Infra/Llm/Provider/providerBase` 的 `ToolCallSpec` 同构）。
 *
 * 本文件是零 import 的共享内核（`Services`/`Core` 双方共引），故就地声明结构而非引用 Provider 层。
 */
export interface ModelCallToolCall {
  readonly id: string;
  readonly type: string;
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

/** 模型调用输入 */
export interface ModelCallInput {
  /**
   * 消息必须原样携带工具关联字段（REV-341）：`role:'tool'` 靠 `tool_call_id` 认领调用，
   * 其前一条助手消息靠 `tool_calls` 声明发起过调用。只取 `{role, content}` 会让
   * 多轮工具循环的第二轮起被供应商判非法请求（400 Invalid messages）。
   */
  messages: Array<{
    role: string;
    content: string;
    tool_call_id?: string;
    tool_calls?: ModelCallToolCall[];
  }>;
  model: string;
  temperature: number;
  stream: boolean;
  [key: string]: unknown;
}

/** 模型调用输出 */
export interface ModelCallOutput {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * 短路类中间件（如 `BudgetSentinel`）声明**显式退出类别**（P1-4）。
   *
   * 修复背景：终止类中间件此前返回一条"看起来完全成功"的伪正文，主循环解析后无 `tool_calls`，
   * 于是被判定为 `success`——把"预算耗尽"记成"Agent 给出最终答复，圆满完成"。
   * 现在经 `beforeModel` 的短路通道返回，并在此携带真实类别（取值见 `Core/Loop/iterationController` 的 `ExitReason`）。
   */
  exitReason?: string;
  /** 短路原因（诊断 / 事件载荷） */
  reason?: string;
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
  /**
   * 工具失败时的结构化错误（设计 §3.1：错误码是接口的一部分，不得只留人话正文）。
   *
   * 背景（TOOL-ENV-TIMEOUT 实验复现）：执行链只把 `status/content/recoverable` 透传出去，
   * 真实的 `TOOL_TIMEOUT` 等错误码在中间件边界被丢弃 —— 循环的 `IterationResult.toolResults`
   * 因此永远观测不到错误码，观测层与判定层都只能靠正文猜。
   */
  error?: { code: string; message: string };
}

/** 钩子函数类型 */
export type BeforeAgentHook = (
  ctx: MiddlewareContext,
) => Promise<void | { shortCircuit: true; result?: unknown }>;
export type BeforeModelHook = (
  ctx: MiddlewareContext,
  messages: ModelCallInput["messages"],
) => Promise<
  ModelCallInput["messages"] | { shortCircuit: true; result?: ModelCallOutput }
>;
export type WrapModelCallHook = (
  ctx: MiddlewareContext,
  input: ModelCallInput,
  next: (input: ModelCallInput) => Promise<ModelCallOutput>,
) => Promise<ModelCallOutput>;
export type WrapToolCallHook = (
  ctx: MiddlewareContext,
  input: ToolCallInput,
  next: (input: ToolCallInput) => Promise<ToolCallOutput>,
) => Promise<ToolCallOutput>;
export type AfterModelHook = (
  ctx: MiddlewareContext,
  output: ModelCallOutput,
) => Promise<ModelCallOutput>;
export type AfterAgentHook = (
  ctx: MiddlewareContext,
  result: unknown,
) => Promise<void>;

export type HookFunction =
  | BeforeAgentHook
  | BeforeModelHook
  | WrapModelCallHook
  | WrapToolCallHook
  | AfterModelHook
  | AfterAgentHook;

/** Agent 中间件定义（Docs/Agent/02 §4.2） */
export interface AgentMiddleware {
  /** 中间件名称 */
  name: string;
  /** 挂载的钩子 */
  hook: MiddlewareHook;
  /** 同钩子内排序，小的先执行 */
  priority: number;
  /** 是否可短路 */
  canShortCircuit: boolean;
  /**
   * 归属者 ID（P0-2）。缺省 = **全局**中间件（由组合根 `main.ts` 注册，所有 Loop 都跑）；
   * 给定值（惯例 = `loopState.loopId`）= **回路作用域**中间件，只在该 Loop 的轮次执行。
   */
  ownerId?: string;
  /** 钩子函数 */
  execute: HookFunction;
}
