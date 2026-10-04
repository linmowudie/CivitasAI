/**
 * @module Tools/Registry/toolDispatcher
 * @description 工具**统一派发器**（单一收口 + 审计埋点 + 结果归一）。
 *
 * 借鉴 MongoTerminalAgent v2.0 `Core/MainLoop/Agent._execute_tool`（"统一工具执行入口（审计埋点）"）：
 *  - **单一收口**：所有工具调用都经此一处（避免调用方绕过角色门/超时/审计）；
 *  - **审计埋点**：派发开始/结束/失败都留痕（含耗时），失败路径同样被记录（v2.0 的 TOOL_ERROR 语义）；
 *  - **结果归一**：`string | object | null | undefined` 统一成可推送文本，避免各调用方各自处理；
 *  - **遥测**：返回 `durationMs` 与 `errorClass`，供事件 payload 与界面展示（CivitasAI 此前无工具耗时）。
 *
 * 职责边界（不重复实现）：
 *  - 危险级 / 审批 / 幂等 / EffectJournal 仍由 `toolSafetyGate` 中间件负责（它包裹在本派发器外层）；
 *  - 本模块只做"角色门 + 执行 + 超时（复用 executeTool）+ 归一 + 埋点"。
 */

import type { ToolResult, ToolExecutionContext } from '../Traits/toolSpec.js';
import { executeTool, getTool } from './toolRegistry.js';
import { logger } from '../../Infra/Logging/logger.js';
import { getToolServicePorts } from './toolServicePorts.js';

/** 派发结果（归一后的文本 + 遥测） */
export interface DispatchOutcome {
  /** 原始 ToolResult（保持既有契约不变） */
  result: ToolResult;
  /** 归一后的可推送文本（string/object/null 统一处理） */
  text: string;
  /** 执行耗时（ms）；角色门/未注册等派发级拒绝也会给一个小值 */
  durationMs: number;
  /** 错误分类（成功为 undefined）：DISPATCH_REJECTED / EXECUTION_ERROR / TOOL_TIMEOUT … */
  errorClass?: string;
}

/** 结果归一：把任意 content 转成文本（对象 → JSON，null/undefined → 空串） */
export function normalizeToolContent(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** 从错误码推断分类（便于统计"派发级拒绝"与"执行期失败"） */
function classifyError(code?: string): string {
  if (!code) return 'EXECUTION_ERROR';
  if (code === 'TOOL_NOT_FOUND' || code === 'ROLE_FORBIDDEN' || code === 'INVALID_INPUT') return 'DISPATCH_REJECTED';
  if (code === 'TOOL_TIMEOUT') return 'TOOL_TIMEOUT';
  return 'EXECUTION_ERROR';
}

/**
 * 统一派发一次工具调用。
 *
 * @param input.toolName 工具名
 * @param input.arguments 工具入参
 * @param input.context 执行上下文（含 operationId / agentId / agentRole / sessionId …）
 * @param input.iteration 当前迭代轮次（仅用于埋点）
 */
export async function dispatchToolCall(input: {
  toolName: string;
  arguments: Record<string, unknown>;
  context: ToolExecutionContext;
  iteration?: number;
}): Promise<DispatchOutcome> {
  const startedAt = Date.now();
  const ports = getToolServicePorts();

  // FE-064：幂等 SAFE 工具的结果缓存（命中 → 跳过执行；键含属主，缓存结果不含副作用）
  //   端口由组合根注入（main.ts ⑫.6）；未注入 → 缓存增强不启用（静默跳过，不伪造命中）
  const cache = ports.toolResultCache;
  const toolDef = getTool(input.toolName);
  const cacheable = !!toolDef
    && toolDef.spec.dangerLevel === 'SAFE'
    && toolDef.spec.idempotency === 'YES';
  if (cacheable && cache) {
    const cached = cache.get(input.toolName, input.arguments);
    if (cached !== null && cached.ok) {
      const durationMs = Date.now() - startedAt;
      logger.info('工具结果缓存命中，跳过执行', {
        source: 'toolDispatcher/dispatchToolCall',
        toolName: input.toolName,
        durationMs,
      });
      return {
        result: {
          role: 'tool',
          tool_call_id: input.context.operationId,
          status: 'success',
          recoverable: false,
          content: cached.value,
        },
        text: normalizeToolContent(cached.value),
        durationMs,
      };
    }
  }

  logger.info('派发工具调用', {
    source: 'toolDispatcher/dispatchToolCall',
    toolName: input.toolName,
    agentId: input.context.agentId,
    agentRole: input.context.agentRole,
    iteration: input.iteration,
    operationId: input.context.operationId,
  });

  // FE-066：Hook 触发点（统一收口层——覆盖工具头部调用与 tool.execute 借壳路径）
  //   端口由组合根注入（main.ts ⑫.6）；未注入 → 跳过（审计增强不启用）
  await ports.dispatchHook?.('PreToolExecute', {
    toolName: input.toolName,
    agentId: input.context.agentId,
    traceId: input.context.traceId,
    arguments: input.arguments,
  });

  const result = await executeTool(input.toolName, input.arguments, input.context);
  const durationMs = Date.now() - startedAt;
  const text = normalizeToolContent(result.content);

  // FE-066：执行后 Hook（成功/失败均触发——审计/指标消费）
  await ports.dispatchHook?.('PostToolExecute', {
    toolName: input.toolName,
    agentId: input.context.agentId,
    traceId: input.context.traceId,
    status: result.status,
    durationMs,
  });

  if (result.status === 'error') {
    const errorClass = classifyError(result.error?.code);
    logger.warn('工具派发失败', {
      source: 'toolDispatcher/dispatchToolCall',
      toolName: input.toolName,
      durationMs,
      errorClass,
      code: result.error?.code,
      message: result.error?.message,
    });
    return { result, text, durationMs, errorClass };
  }

  // FE-064：成功结果写缓存；有副作用工具执行成功后**保守清空**读缓存（防止脏读：如 shell 改动了文件）
  if (cache) {
    if (cacheable) {
      cache.put(input.toolName, input.arguments, result.content);
    } else if (toolDef && toolDef.spec.dangerLevel !== 'SAFE') {
      cache.clear();
    }
  }

  logger.info('工具派发完成', {
    source: 'toolDispatcher/dispatchToolCall',
    toolName: input.toolName,
    durationMs,
    resultLength: text.length,
  });
  return { result, text, durationMs };
}
