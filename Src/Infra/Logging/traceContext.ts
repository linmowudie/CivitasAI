/**
 * Trace 上下文管理（Docs/02 §3.2 / Docs/09 §6.1 / Docs/15 §6）
 *
 * 职责：
 * - 基于 AsyncLocalStorage 实现异步链路追踪上下文传递
 * - 管理三级 ID：trace_id → span → operation_id
 * - trace_id：一次 Agent 运行会话（跨 Agent 复用，T6 场景下 Director/Worker 共享）
 * - span：每次 LLM 调用、工具执行
 * - operation_id：具体操作（{timestamp_ms}-{4位hex}）
 *
 * 设计约束：
 * - trace_id 跨 Agent 不可变（Docs/01 §ID 语义）
 * - 禁止用 trace_id 做用户维度聚合（Docs/15 §6）
 * - 禁止混用 session_key / trace_id / operation_id
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// ===== 类型定义 =====

/** Span 类型（Docs/09 §6.1） */
export type SpanType = 'llm_call' | 'tool_exec' | 'agent_run' | 'middleware' | 'custom';

/** Trace 上下文结构 */
export interface TraceContext {
  /** 全链路追踪 ID（UUID v4），跨 Agent 复用 */
  readonly traceId: string;
  /** 父 Agent ID（T6 场景下 Worker 记录 Director 的 agent_id） */
  readonly parentAgentId?: string;
  /** 当前 Agent ID */
  readonly agentId?: string;
  /** 当前 span ID */
  readonly spanId?: string;
  /** 当前 span 类型 */
  readonly spanType?: SpanType;
  /** 当前操作 ID（{timestamp_ms}-{4位hex}） */
  readonly operationId?: string;
  /** 上下文创建时间（epoch ms） */
  readonly createdAt: number;
}

/** 创建 trace 上下文的选项 */
export interface CreateTraceOptions {
  /** 指定 trace_id，不传则自动生成 UUID v4 */
  traceId?: string;
  /** 父 Agent ID（T6 Worker 场景） */
  parentAgentId?: string;
  /** 当前 Agent ID */
  agentId?: string;
}

/** 创建 span 的选项 */
export interface CreateSpanOptions {
  /** span 类型 */
  type: SpanType;
  /** 可选的 span ID，不传则自动生成 */
  spanId?: string;
}

// ===== 内部状态 =====

/** 异步上下文存储 */
const storage = new AsyncLocalStorage<TraceContext>();

// ===== 公开 API =====

/**
 * 创建新的 trace 上下文并在回调作用域内激活
 *
 * 回调函数在 trace 上下文内运行，所有子调用均可通过 currentContext() 获取。
 *
 * @example
 * ```ts
 * const result = await runInTrace({ agentId: 'agent-001' }, async (ctx) => {
 *   // ctx.traceId 已设置，子调用自动继承
 *   return await doWork();
 * });
 * ```
 */
export async function runInTrace<T>(
  options: CreateTraceOptions,
  fn: (ctx: TraceContext) => Promise<T>,
): Promise<T> {
  const ctx: TraceContext = {
    traceId: options.traceId ?? randomUUID(),
    parentAgentId: options.parentAgentId,
    agentId: options.agentId,
    createdAt: Date.now(),
  };
  return storage.run(ctx, () => fn(ctx));
}

/**
 * 在当前 trace 内创建一个 span
 *
 * span 会继承 trace_id，并设置新的 span_id 和 span_type。
 * 回调函数在 span 上下文内运行。
 *
 * @example
 * ```ts
 * const result = await runInSpan({ type: 'llm_call' }, async (ctx) => {
 *   // ctx.spanId 已设置，ctx.traceId 不变
 *   return await callModel();
 * });
 * ```
 */
export async function runInSpan<T>(
  options: CreateSpanOptions,
  fn: (ctx: TraceContext) => Promise<T>,
): Promise<T> {
  const current = storage.getStore();
  if (!current) {
    // 没有活跃 trace，直接在无 span 上下文下执行
    return fn({ traceId: '', createdAt: Date.now() });
  }

  const spanCtx: TraceContext = {
    ...current,
    spanId: options.spanId ?? generateSpanId(),
    spanType: options.type,
    operationId: undefined, // span 内可再设 operation
  };
  return storage.run(spanCtx, () => fn(spanCtx));
}

/**
 * 在当前 span 内设置 operation_id
 *
 * operation_id 格式：{timestamp_ms}-{4位hex}
 * 用于关联具体操作（工具调用、文件操作等）。
 */
export async function runWithOperation<T>(
  fn: (ctx: TraceContext) => Promise<T>,
): Promise<T> {
  const current = storage.getStore();
  if (!current) {
    return fn({ traceId: '', createdAt: Date.now() });
  }

  const opCtx: TraceContext = {
    ...current,
    operationId: generateOperationId(),
  };
  return storage.run(opCtx, () => fn(opCtx));
}

/**
 * 获取当前异步链路中的 trace 上下文
 *
 * 未激活时返回 undefined（调用方应优雅处理，不报错）。
 */
export function currentContext(): TraceContext | undefined {
  return storage.getStore();
}

/**
 * 获取当前 trace_id（快捷方法）
 *
 * 未激活时返回 'no-trace'。
 */
export function currentTraceId(): string {
  return storage.getStore()?.traceId ?? 'no-trace';
}

/**
 * 获取当前 span_id（快捷方法）
 */
export function currentSpanId(): string | undefined {
  return storage.getStore()?.spanId;
}

/**
 * 获取当前 operation_id（快捷方法）
 */
export function currentOperationId(): string | undefined {
  return storage.getStore()?.operationId;
}

// ===== 内部辅助 =====

/** 生成 span_id（8位hex） */
function generateSpanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/** 生成 operation_id：{timestamp_ms}-{4位hex}（Docs/15 §6） */
function generateOperationId(): string {
  const ts = Date.now().toString(36);
  const hex = randomUUID().replace(/-/g, '').slice(0, 4);
  return `${ts}-${hex}`;
}
