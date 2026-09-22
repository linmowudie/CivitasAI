/**
 * @module Loop/runIteration
 * @description
 * 十步主循环执行器——Docs/02 §3 / 审查报告 P0-1。
 *
 * 将散落的子系统（监管 / 中间件 / 上下文装配 / 模型调用 / 工具执行 / 迭代判定）
 * 组合为严格的十步序列，每步发布 LoopEvent 供 assertStepOrder 校验。
 *
 * 十步序列：
 *   ① InputReceived → ② PreSupervision → ③ Middleware(beforeAgent/beforeModel)
 *   → ④ ContextAssembly → ⑤ LazySupervision → ⑥ ModelCall(wrapModelCall)
 *   → ⑦ OutputParse → ⑧ ToolExecute(wrapToolCall) → ⑨ PostSupervision
 *   → ⑩ IterationDecision
 */

import type { LoopState, LoopStep, LoopEvent } from './loopEngine.js';
import { recordLoopEvent, assertStepOrder } from './loopEngine.js';
import type { IterationDecision } from './iterationController.js';
import { decideIteration, type IterationDecisionInput } from './iterationController.js';
import type { LoopConfig } from './loopConfig.js';

// ── Services 层 ──
import { runPreSupervision } from '../../Services/Supervision/preSupervision.js';
import { runPostSupervision } from '../../Services/Supervision/postSupervision.js';
import { evaluateStopRules, type StopRuleSet, type LoopRuntimeSnapshot, type StopDecision } from '../../Services/LoopControl/stopRules.js';
import { dispatchHook } from '../../Services/Hook/hookRegistry.js';

// ── Core 层 ──
import { executePrePostHooks, executeWrapHooks, registerMiddleware, unregisterMiddleware } from '../Middleware/middlewareRegistry.js';
import type { MiddlewareContext, ModelCallInput, ModelCallOutput, ToolCallInput, ToolCallOutput } from '../../Infra/Contracts/middlewareTypes.js';
import { callModel, callModelStream, type ChatMessage, type CallResult, type StreamChunk } from '../Model/modelCaller.js';

// ── Services 层中间件 ──
import { createToolSafetyGateMiddleware } from '../../Services/LoopControl/middleware/toolSafetyGate.js';

// ── Tools 层 ──
import { executeTool } from '../../Tools/Registry/toolRegistry.js';
import { getVisibleToolsForRole } from '../../Tools/Factory/toolFactory.js';
import type { ToolExecutionContext, ToolResult } from '../../Tools/Traits/toolSpec.js';
import type { UserRole } from '../../Infra/types.js';

// ── Infra 层 ──
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { logger } from '../../Infra/Logging/logger.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 公共类型
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 单次迭代输入 */
export interface IterationContext {
  /** 用户原始输入 */
  userInput: string;
  /** 会话 ID */
  sessionId: string;
  /** Agent ID */
  agentId: string;
  /** Agent 角色 */
  agentRole: string;
  /** Loop 配置 */
  config: LoopConfig;
  /** 当前迭代序号（从 1 开始） */
  currentIteration: number;
  /** 累计已消耗 Token */
  totalTokensConsumed: number;
  /** 对话历史 */
  chatMessages: ChatMessage[];
  /** 最近调用时间戳（供频率限制） */
  recentCallTimestamps: number[];
  /** AbortSignal */
  signal?: AbortSignal;
  /** 流式 chunk 回调（可选） */
  onStreamChunk?: (chunk: StreamChunk) => void;
  /** LoopControl 运行时快照（供 StopRules 判定） */
  loopControlSnapshot?: Partial<LoopRuntimeSnapshot>;
}

/** 解析出的工具调用 */
export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 单次迭代结果 */
export interface IterationResult {
  /** 模型输出文本 */
  outputText: string;
  /** 解析出的工具调用 */
  toolCalls: ParsedToolCall[];
  /** 工具执行结果 */
  toolResults: ToolResult[];
  /** 本轮消耗 Token */
  tokensConsumed: number;
  /** 迭代决策 */
  decision: IterationDecision;
  /** StopRules 决策（如有） */
  stopDecision?: StopDecision;
  /** 已执行的步骤 */
  steps: LoopStep[];
  /** 事件日志 */
  events: LoopEvent[];
  /** 是否被短路（中间件拦截） */
  shortCircuited: boolean;
  /** 短路原因 */
  shortCircuitReason?: string;
}

/** 主循环执行结果 */
export interface LoopExecutionResult {
  iterations: IterationResult[];
  totalTokensConsumed: number;
  totalToolCalls: number;
  exitReason?: string;
  exitMessage?: string;
  totalMs: number;
  allEvents: LoopEvent[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ⑦ 输出解析
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 从模型输出中解析工具调用。
 *
 * 优先读取 CallResult 中的原生 tool_calls 字段；
 * 若无，则尝试从文本中匹配 ```tool_call JSON 块。
 */
export function parseModelOutput(
  output: string,
  callResult?: CallResult,
): { text: string; toolCalls: ParsedToolCall[] } {
  // 原生 tool_calls（OpenAI 兼容格式，从 CallResult 扩展字段读取）
  const ext = callResult as unknown as Record<string, unknown> | undefined;
  const nativeToolCalls = ext?.tool_calls;
  if (Array.isArray(nativeToolCalls) && nativeToolCalls.length > 0) {
    const toolCalls: ParsedToolCall[] = nativeToolCalls
      .filter((tc: unknown) => tc && typeof tc === 'object' && (tc as Record<string, unknown>).function)
      .map((tc: unknown) => {
        const rec = tc as Record<string, unknown>;
        const fn = rec.function as Record<string, unknown>;
        let args: Record<string, unknown> = {};
        try {
          args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments as Record<string, unknown>) ?? {};
        } catch { /* 忽略解析错误 */ }
        return {
          id: (rec.id as string) ?? `tc-${Date.now()}`,
          name: (fn.name as string) ?? '',
          arguments: args,
        };
      });
    return { text: output, toolCalls };
  }

  // 文本内嵌 tool_call 块
  const toolCalls: ParsedToolCall[] = [];
  const toolCallRegex = /```tool_call\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = toolCallRegex.exec(output)) !== null) {
    try {
      const parsed = JSON.parse(match[1] ?? '{}');
      if (parsed.name) {
        toolCalls.push({
          id: parsed.id ?? `tc-${Date.now()}-${toolCalls.length}`,
          name: parsed.name,
          arguments: parsed.arguments ?? {},
        });
      }
    } catch { /* 非 JSON 块，跳过 */ }
  }
  return { text: output, toolCalls };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 单轮迭代执行器
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 执行一次完整十步迭代。
 *
 * 每步发布 LoopEvent，末尾校验步骤顺序。
 * 返回 IterationResult 含迭代决策。
 */
export async function runIteration(
  loopState: LoopState,
  ctx: IterationContext,
): Promise<Result<IterationResult>> {
  const steps: LoopStep[] = [];
  const events: LoopEvent[] = [];
  let shortCircuited = false;
  let shortCircuitReason: string | undefined;
  let tokensConsumed = 0;
  let outputText = '';
  let toolCalls: ParsedToolCall[] = [];
  let toolResults: ToolResult[] = [];
  let callResult: CallResult | undefined;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars

  const mwCtx: MiddlewareContext = {
    agentId: ctx.agentId,
    agentRole: ctx.agentRole,
    sessionId: ctx.sessionId,
    iteration: ctx.currentIteration,
    traceId: loopState.traceId,
    data: {},
  };

  function recordStep(state: LoopState, step: LoopStep, data: Record<string, unknown> = {}): void {
    steps.push(step);
    events.push(recordLoopEvent(state, step, data));
  }

  try {

    // ── ① 输入接收 ──────────────────────────────────────
    recordStep(loopState, '① InputReceived', {
      userInputLength: ctx.userInput.length,
      iteration: ctx.currentIteration,
    });

    const inputHookResult = await dispatchHook('UserInputReceived', {
      userInput: ctx.userInput,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
    });
    if (inputHookResult.intercepted) {
      shortCircuited = true;
      shortCircuitReason = `Input intercepted: ${inputHookResult.interceptReason}`;
      return ok({
        outputText: '', toolCalls: [], toolResults: [], tokensConsumed: 0,
        decision: { shouldContinue: false, exitReason: 'risk', exitMessage: shortCircuitReason },
        steps, events, shortCircuited: true, shortCircuitReason,
      });
    }

    // ── ② 前置监管 ──────────────────────────────────────
    recordStep(loopState, '② PreSupervision');

    const preSupResult = runPreSupervision({
      userInput: ctx.userInput,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      recentCallTimestamps: ctx.recentCallTimestamps,
    });

    if (preSupResult.ok && !preSupResult.value.passed) {
      return ok({
        outputText: '', toolCalls: [], toolResults: [], tokensConsumed: 0,
        decision: {
          shouldContinue: false,
          exitReason: 'risk' as const,
          exitMessage: `Pre-supervision rejected: ${preSupResult.value.rejectReason}`,
        },
        steps, events, shortCircuited: true,
        shortCircuitReason: `Pre-supervision: ${preSupResult.value.rejectReason}`,
      });
    }

    // ── ③ 中间件管线 ────────────────────────────────────
    recordStep(loopState, '③ Middleware');

    // beforeAgent
    const beforeAgentResult = await executePrePostHooks('beforeAgent', mwCtx);
    if (beforeAgentResult.shortCircuited) {
      return ok({
        outputText: '', toolCalls: [], toolResults: [], tokensConsumed: 0,
        decision: { shouldContinue: false, exitMessage: 'beforeAgent short-circuited' },
        steps, events, shortCircuited: true,
        shortCircuitReason: 'beforeAgent middleware short-circuited',
      });
    }

    // beforeModel
    const beforeModelResult = await executePrePostHooks('beforeModel', mwCtx, mwCtx.data['messages']);
    if (beforeModelResult.shortCircuited) {
      return ok({
        outputText: '', toolCalls: [], toolResults: [], tokensConsumed: 0,
        decision: { shouldContinue: false, exitMessage: 'beforeModel short-circuited' },
        steps, events, shortCircuited: true,
        shortCircuitReason: 'beforeModel middleware short-circuited',
      });
    }

    // ── ④ 上下文组装 ───────────────────────────────────
    recordStep(loopState, '④ ContextAssembly');

    // 将 ToolSpec 转换为 OpenAI 兼容的工具格式（按角色裁剪）
    const toolSpecs = getVisibleToolsForRole(ctx.agentRole as UserRole);
    const tools = toolSpecs.map(spec => ({
      type: 'function' as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: {
          type: 'object',
          properties: spec.inputSchema.properties,
          required: spec.inputSchema.required ?? [],
          additionalProperties: spec.inputSchema.additionalProperties ?? false,
        },
      },
    }));

    // 系统提示：告知模型可以使用工具
    const systemPrompt = `You are Civitas-AI, an autonomous agent system. You have access to the following tools. Use them when appropriate to complete tasks. If you need to use a tool, respond with a tool call. After receiving tool results, continue your response.

Available tools:
${toolSpecs.map(s => `- ${s.name}: ${s.description}`).join('\n')}`;

    // 当前降级：直接使用对话历史（S/L/M/H 全量装配需 PartitionState 初始化后启用）
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...ctx.chatMessages.map(m => ({
        role: m.role as ChatMessage['role'],
        content: m.content,
      })),
    ];

    // TODO: 当 PartitionState 完整初始化后，启用 assembleContext 装配路径

    // ── ⑤ 监管懒监听 ────────────────────────────────────
    recordStep(loopState, '⑤ LazySupervision', {
      contextTokens: messages.reduce((sum, m) => sum + (m.content?.length ?? 0) / 4, 0),
    });
    // 压缩/摘要/推理/循环四监管在上下文达到阈值时按需触发
    // 当前轮次仅记录上下文规模，不主动干预

    // ── ⑥ 模型调用 ──────────────────────────────────────
    recordStep(loopState, '⑥ ModelCall');

    const modelInput: ModelCallInput = {
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      model: ctx.config.model,
      temperature: ctx.config.temperature,
      stream: ctx.config.stream,
    };

    // 工具参数（供模型调用）
    const modelCallOptions = {
      temperature: modelInput.temperature,
      signal: ctx.signal,
      tools: tools.length > 0 ? tools : undefined,
    };

    let modelOutput: ModelCallOutput;

    if (ctx.config.stream && ctx.onStreamChunk) {
      // 流式调用（经 wrapModelCall 中间件包裹）
      const streamResult = await executeWrapHooks<ModelCallInput, Result<CallResult>>(
        'wrapModelCall', mwCtx, modelInput,
        async (input) => {
          return callModelStream(
            input.model,
            input.messages as ChatMessage[],
            ctx.onStreamChunk!,
            modelCallOptions,
          );
        },
      );

      if (streamResult.ok) {
        callResult = streamResult.value;
        outputText = streamResult.value.content;
        tokensConsumed = streamResult.value.usage.total_tokens;
        modelOutput = {
          content: outputText,
          usage: { inputTokens: streamResult.value.usage.prompt_tokens, outputTokens: streamResult.value.usage.completion_tokens },
        };
      } else {
        return ok({
          outputText: '', toolCalls: [], toolResults: [], tokensConsumed: 0,
          decision: { shouldContinue: false, exitReason: 'risk', exitMessage: `Model call failed: ${streamResult.error}` },
          steps, events, shortCircuited: true, shortCircuitReason: streamResult.error,
        });
      }
    } else {
      // 非流式调用（经 wrapModelCall 中间件包裹）
      modelOutput = await executeWrapHooks<ModelCallInput, ModelCallOutput>(
        'wrapModelCall', mwCtx, modelInput,
        async (input) => {
          const result = await callModel(
            input.model,
            input.messages as ChatMessage[],
            modelCallOptions,
          );
          if (result.ok) {
            callResult = result.value;
            return {
              content: result.value.content,
              usage: { inputTokens: result.value.usage.prompt_tokens, outputTokens: result.value.usage.completion_tokens },
            };
          }
          return { content: `ERROR: ${result.error}`, usage: { inputTokens: 0, outputTokens: 0 } };
        },
      );
      outputText = modelOutput.content;
      tokensConsumed = (modelOutput.usage?.inputTokens ?? 0) + (modelOutput.usage?.outputTokens ?? 0);
    }

    recordStep(loopState, '⑥ ModelCall', { tokensConsumed, model: ctx.config.model });

    // afterModel 钩子
    await executePrePostHooks('afterModel', mwCtx, modelOutput);

    // ── ⑦ 输出解析 ──────────────────────────────────────
    recordStep(loopState, '⑦ OutputParse');

    const parsed = parseModelOutput(outputText, callResult);
    outputText = parsed.text;
    toolCalls = parsed.toolCalls;

    recordStep(loopState, '⑦ OutputParse', {
      textLength: outputText.length,
      toolCallCount: toolCalls.length,
    });

    // ── ⑧ 工具执行 ──────────────────────────────────────
    if (toolCalls.length > 0) {
      recordStep(loopState, '⑧ ToolExecute');

      for (const tc of toolCalls) {
        const toolCallInput: ToolCallInput = {
          toolName: tc.name,
          arguments: tc.arguments,
          toolCallId: tc.id,
        };

        // wrapToolCall 中间件包裹
        const toolOutput = await executeWrapHooks<ToolCallInput, ToolCallOutput>(
          'wrapToolCall', mwCtx, toolCallInput,
          async (input) => {
            const toolCtx: ToolExecutionContext = {
              operationId: tc.id,
              agentId: ctx.agentId,
              agentRole: ctx.agentRole as ToolExecutionContext['agentRole'],
              loopId: loopState.loopId,
              traceId: loopState.traceId,
              signal: ctx.signal,
            };
            const result = await executeTool(input.toolName, input.arguments, toolCtx);
            return {
              status: result.status,
              content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
              recoverable: result.recoverable,
            };
          },
        );

        // 工具已在 wrapToolCall 内执行，此处构造结果记录
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          status: toolOutput.status as 'success' | 'error',
          recoverable: toolOutput.recoverable,
          content: toolOutput.content,
        } as ToolResult);
      }

      recordStep(loopState, '⑧ ToolExecute', {
        toolCount: toolCalls.length,
        successCount: toolResults.filter(r => r.status === 'success').length,
        errorCount: toolResults.filter(r => r.status === 'error').length,
      });
    }

    // ── ⑨ 后置监管 ──────────────────────────────────────
    recordStep(loopState, '⑨ PostSupervision');

    const postSupResult = runPostSupervision({
      outputText,
      toolResults: toolResults.map(r => ({
        toolName: r.tool_call_id,
        status: r.status,
        recoverable: r.recoverable,
      })),
      tokensConsumed,
      totalTokensConsumed: ctx.totalTokensConsumed + tokensConsumed,
      tokenBudget: ctx.config.token_budget,
      currentIteration: ctx.currentIteration,
      maxIterations: ctx.config.max_iterations,
    });

    // ── ⑩ 迭代判定 ──────────────────────────────────────
    recordStep(loopState, '⑩ IterationDecision');

    const iterInput: IterationDecisionInput = {
      hadToolCall: toolCalls.length > 0,
      tokensConsumed,
      hasOutput: outputText.length > 0,
      riskDetected: postSupResult.ok && postSupResult.value.anomalies.length > 0,
    };
    const decision = decideIteration(loopState.iteration, iterInput);

    // StopRules 五类独立退出（如提供了运行时快照）
    let stopDecision: StopDecision | undefined;
    if (ctx.loopControlSnapshot) {
      const defaultRules: StopRuleSet = {
        successCriteria: [],
        limits: {
          maxIterations: ctx.config.max_iterations,
          maxWallClockMs: ctx.config.timeout_ms,
          maxToolCalls: 500,
          maxConsecutiveErrors: 5,
        },
        budget: {
          softTokens: Math.floor(ctx.config.token_budget * 0.6),
          hardTokens: ctx.config.token_budget,
          warmTokens: Math.floor(ctx.config.token_budget * 0.36),
          expandRequestTokens: Math.floor(ctx.config.token_budget * 0.8),
        },
        noProgress: {
          metric: 'custom',
          stagnationWindow: 5,
          minDelta: 0.01,
          action: 'switch_strategy',
        },
        riskTriggers: [],
      };
      const snapshot: LoopRuntimeSnapshot = {
        iteration: ctx.currentIteration,
        startedAt: loopState.startedAt,
        toolCallCount: ctx.loopControlSnapshot.toolCallCount ?? 0,
        consecutiveErrors: ctx.loopControlSnapshot.consecutiveErrors ?? 0,
        budgetUsed: { tokens: ctx.totalTokensConsumed + tokensConsumed, usd: 0 },
        recentMetrics: ctx.loopControlSnapshot.recentMetrics ?? [],
        riskSignals: ctx.loopControlSnapshot.riskSignals ?? [],
        verifierPassed: ctx.loopControlSnapshot.verifierPassed ?? false,
      };
      stopDecision = evaluateStopRules(defaultRules, {} as any, snapshot);
      if (stopDecision.shouldStop && !decision.shouldContinue) {
        // 两者一致，无需额外处理
      } else if (stopDecision.shouldStop) {
        decision.shouldContinue = false;
        decision.exitReason = 'risk';
        decision.exitMessage = stopDecision.detail;
      }
    }

    // 步骤顺序校验
    if (!assertStepOrder(steps)) {
      logger.warn('十步序列顺序异常', { source: 'runIteration', steps });
    }

    return ok({
      outputText, toolCalls, toolResults, tokensConsumed,
      decision, stopDecision, steps, events,
      shortCircuited, shortCircuitReason,
    });

  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    logger.error('迭代执行异常', { source: 'runIteration', error: errorMsg });
    return err(`Iteration failed: ${errorMsg}`);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 主循环（多轮迭代）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 执行完整主循环——多轮迭代直到退出条件满足。
 *
 * wsHandler 应调用本函数替代裸调 callModelStream。
 */
export async function executeLoop(
  loopState: LoopState,
  initialCtx: Omit<IterationContext, 'currentIteration' | 'totalTokensConsumed'>,
): Promise<Result<LoopExecutionResult>> {
  const { startLoop, terminateLoop, failLoop } = await import('./loopEngine.js');

  const startResult = startLoop(loopState);
  if (!startResult.ok) return startResult;

  // 注册 toolSafetyGate 中间件（Loop 实例级）
  const safetyGate = createToolSafetyGateMiddleware(
    () => loopState.loopId,
    () => loopState.iteration.current,
    () => loopState.traceId,
  );
  registerMiddleware(safetyGate);

  try {

  const allIterations: IterationResult[] = [];
  const allEvents: LoopEvent[] = [];
  let totalTokens = 0;
  let totalToolCalls = 0;
  const t0 = Date.now();

  logger.info('主循环启动', {
    source: 'runIteration/executeLoop',
    loopId: loopState.loopId,
    maxIterations: loopState.iteration.max,
    tokenBudget: loopState.iteration.tokenBudget,
  });

  for (let iter = 1; iter <= loopState.iteration.max; iter++) {
    // 检查 abort
    if (initialCtx.signal?.aborted) {
      terminateLoop(loopState, 'User aborted');
      break;
    }

    const iterCtx: IterationContext = {
      ...initialCtx,
      currentIteration: iter,
      totalTokensConsumed: totalTokens,
    };

    const result = await runIteration(loopState, iterCtx);

    if (!result.ok) {
      failLoop(loopState, result.error);
      return err(result.error);
    }

    const iterResult = result.value;
    allIterations.push(iterResult);
    allEvents.push(...iterResult.events);
    totalTokens += iterResult.tokensConsumed;
    totalToolCalls += iterResult.toolCalls.length;

    // 更新对话历史（追加助手输出 + 工具结果，供下一轮使用）
    if (iterResult.outputText) {
      initialCtx.chatMessages.push({ role: 'assistant', content: iterResult.outputText });
    }
    for (const tr of iterResult.toolResults) {
      initialCtx.chatMessages.push({
        role: 'tool',
        content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
      });
    }

    if (!iterResult.decision.shouldContinue) {
      terminateLoop(loopState, iterResult.decision.exitMessage ?? 'Loop ended');
      break;
    }
  }

  const finalIteration = allIterations[allIterations.length - 1];

  logger.info('主循环结束', {
    source: 'runIteration/executeLoop',
    loopId: loopState.loopId,
    iterations: allIterations.length,
    totalTokens,
    totalToolCalls,
    totalMs: Date.now() - t0,
    exitReason: finalIteration?.decision.exitReason,
  });

  return ok({
    iterations: allIterations,
    totalTokensConsumed: totalTokens,
    totalToolCalls,
    exitReason: finalIteration?.decision.exitReason,
    exitMessage: finalIteration?.decision.exitMessage,
    totalMs: Date.now() - t0,
    allEvents,
  });

  } finally {
    // 无论成功/失败/异常，始终注销 toolSafetyGate 中间件
    unregisterMiddleware('ToolSafetyGate');
  }
}
