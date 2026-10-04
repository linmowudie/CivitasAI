/**
 * @module Loop/runIteration
 * @description
 * 十步主循环执行器——Docs/Agent/02 §3 / 审查报告 P0-1。
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


// ── Services 层 ──
import { runPreSupervision } from '../../Services/Supervision/preSupervision.js';
import { runPostSupervision } from '../../Services/Supervision/postSupervision.js';
import { evaluateStopRules, getActiveStopRuleSet, type StopRuleSet, type LoopRuntimeSnapshot, type StopDecision } from '../../Services/LoopControl/stopRules.js';
import type { StoppedReason } from '../../Services/LoopControl/types.js';
import { dispatchHook } from '../../Services/Hook/hookRegistry.js';
import { recordFileWorkSet, type ContextStore } from '../../Services/Context/contextStore.js';
import { getRolePrompt, getSystemMainLoop } from '../../Services/Prompts/promptRegistry.js';
import { getStrategyCandidates } from '../../Services/Prompts/skillsAssets.js';
import { selectNextStrategy } from '../../Services/LoopControl/strategyLedger.js';

// ── Core 层 ──
import { executePrePostHooks, executeWrapHooks, registerMiddleware, unregisterMiddleware } from '../Middleware/middlewareRegistry.js';
import type { MiddlewareContext, ModelCallInput, ModelCallOutput, ToolCallInput, ToolCallOutput } from '../../Infra/Contracts/middlewareTypes.js';
import { callModel, callModelStream, type ChatMessage, type CallResult, type StreamChunk } from '../Model/modelCaller.js';
import { estimateMessageTokens, maybeCompressContext, sameMessageContent } from './contextCompression.js';
import { consolidateLoopKnowledge } from './loopKnowledge.js';
import { recordIterationEconomy } from './loopEconomy.js';

// ── Services 层中间件 ──
import { createToolSafetyGateMiddleware } from '../../Services/LoopControl/middleware/toolSafetyGate.js';

// ── Tools 层 ──
import { dispatchToolCall } from '../../Tools/Registry/toolDispatcher.js';
import { buildToolHeader } from '../../Tools/Registry/toolHeader.js';
import { writeIterationCheckpoint } from '../../Infra/DurableExecution/iterationCheckpoint.js';
import { getUnknownEffects } from '../../Infra/DurableExecution/effectJournal.js';
import type { ToolExecutionContext, ToolResult } from '../../Tools/Traits/toolSpec.js';
import type { UserRole } from '../../Infra/types.js';

// ── Infra 层 ──
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { logger } from '../../Infra/Logging/logger.js';

import type { LoopConfig } from './loopConfig.js';
import { decideIteration, type IterationDecisionInput } from './iterationController.js';
import type { IterationDecision, ExitReason } from './iterationController.js';
import { recordLoopEvent, assertStepOrder } from './loopEngine.js';
import type { LoopState, LoopStep, LoopEvent } from './loopEngine.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 公共类型
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 单次迭代输入 */
/**
 * 系统提示的**静态段**（会话内字节恒定）。
 *
 * 前缀稳定设计（借鉴 MongoTerminalAgent v2.0 §三区分离）：
 *  - 角色段（FE-052 接入）：角色提示词（promptRegistry 装载的 `Prompts/roles/{role}.md`）
 *    ——会话内恒定，置于最前；未装载时为空段，行为与修复前一致；
 *  - 静态段：能力 / 工作流 / 约束 / 响应格式 —— 不随轮次与工具集变化；
 *  - 工具目录：**只有按名称排序后的工具名**（schema 由请求的 `tools` 参数提供，不再逐条内联描述），
 *    因此增删工具只影响目录这一小段，且顺序确定；
 *  - 回合段：动态注入（上下文分区/压缩摘要等）必须**追加在其后**，绝不能插到前面。
 */
const STATIC_SYSTEM_PROMPT = `You are Civitas-AI, an autonomous agent system.

## Capabilities
- Read, write and edit files; run shell commands; search code and files.
- Plan multi-step work with the todo tools, then execute step by step.
- Call tools when needed; continue after receiving tool results.

## Workflow
Follow Thought → Action → Observation: analyze the request, call the right tool,
inspect the result, repeat until done, then summarize concisely.

## Constraints
- Never run destructive commands; ask before irreversible operations.
- Read a file before modifying it.
- Keep answers concise and actionable.

## Response format
- Markdown; fenced code blocks with language tags.`;

/**
 * 缓存已渲染的系统提示（按"角色可见工具集"哈希）。
 *
 * 作用：保证同一会话/同一工具集下**返回完全相同的字符串**（字节级一致），
 * 为提供商前缀缓存提供稳定前缀；也避免每轮重复拼接。
 */
const systemPromptCache = new Map<string, string>();

/** 构造前缀稳定的系统提示（角色段 + 静态段 + [系统资产段] + 排序后的工具目录） */
export function buildStableSystemPrompt(toolNames: string[], rolePrompt?: string, cache = true): string {
  const sorted = [...toolNames].sort();
  const roleSegment = rolePrompt?.trim() ? `${rolePrompt.trim()}\n\n---\n\n` : '';
  // FE-069：Prompts/system/mainLoop.md 资产段（未装载 → 空段，行为与修复前一致）
  const systemAsset = getSystemMainLoop();
  const assetSegment = systemAsset ? `\n\n---\n\n${systemAsset}` : '';
  // 缓存键含角色段与资产段：相同工具集下的不同角色（或资产变更）不得命中同一缓存
  const cacheKey = `${roleSegment}\u0000${assetSegment}\u0000${sorted.join('\u0000')}`;
  if (cache) {
    const hit = systemPromptCache.get(cacheKey);
    if (hit !== undefined) return hit;
  }
  const catalog = sorted.length > 0
    ? `\n\n## Available tools\n${sorted.map(n => `- ${n}`).join('\n')}\n(Tool schemas are provided through the API \`tools\` parameter.)`
    : '';
  const prompt = `${roleSegment}${STATIC_SYSTEM_PROMPT}${assetSegment}${catalog}`;
  if (cache) {
    // 上限保护：工具集组合有限，但避免异常情况下无界增长
    if (systemPromptCache.size > 64) systemPromptCache.clear();
    systemPromptCache.set(cacheKey, prompt);
  }
  return prompt;
}

/** 测试/诊断用：清空系统提示缓存 */
export function resetSystemPromptCache(): void {
  systemPromptCache.clear();
}

export interface IterationContext {
  /** 用户原始输入 */
  userInput: string;
  /** 会话 ID */
  sessionId: string;
  /**
   * 任务工作目录（会话绑定，来自 chat_sessions.work_dir）。
   * 供路径型工具与 shell.exec 收敛路径；缺省则不启用任务级约束。
   */
  workDir?: string;
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
  /**
   * 工具开始执行前的回调（在模型决定调用、工具函数真正执行之前触发）。
   * 供上层**即时**推送事件，使前端能在正确位置预创建工具组件。
   */
  onToolCallStart?: (info: {
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    iteration: number;
  }) => void;
  /** 工具执行结束的回调（含被中间件短路/审批门拦截等未真正执行的情况） */
  onToolCallResult?: (info: {
    toolCallId: string;
    toolName: string;
    status: 'success' | 'error';
    content?: unknown;
    recoverable?: boolean;
    iteration: number;
    /** 本次工具执行耗时（ms），由统一派发器产出（T1） */
    durationMs?: number;
  }) => void;
  /** 流式 chunk 回调（可选） */
  onStreamChunk?: (chunk: StreamChunk) => void;
  /**
   * 模型**正在生成**某个工具调用的首个增量时触发（每个工具调用只触发一次）。
   *
   * 修复背景（2026-10-03）：工具要等整段响应结束才会执行，而生成一次写文件调用可能耗时数十秒；
   * 若不在此时告知前端，界面在这段时间完全没有反馈（用户看到"等全部生成完才冒出来"）。
   * 前端据此**预创建**工具块并显示"生成中/准备写入"。
   */
  onToolCallPending?: (info: {
    /** 工具调用 ID（增量首包通常已给出；缺失时由 index 兜底） */
    toolCallId: string;
    /** 同一响应内的序号（id 缺失时用于关联） */
    index: number;
    /** 已解析到的工具名（可能为空，后续 onToolCallStart 会给出完整名） */
    toolName?: string;
    iteration: number;
  }) => void;
  /**
   * 单轮迭代**即时**完成的回调（每轮结束立刻触发）。
   *
   * 修复背景：此前 `agent:iteration_complete` 是在 `executeLoop` 返回后循环批量发布，
   * 导致所有轮的完成事件都堆在最后（基于它渲染的内容必然延迟到运行结束）。
   */
  onIterationComplete?: (info: {
    iteration: number;
    totalIterations: number;
    outputText: string;
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolResults: Array<{ tool_call_id: string; status: string; content?: string; error?: { code: string; message: string } }>;
    /** 本轮消耗 Token（前端轮次统计用） */
    tokensConsumed: number;
    /** 本轮决策（退出原因） */
    decision: string;
  }) => void;
  /** LoopControl 运行时快照（供 StopRules 判定） */
  loopControlSnapshot?: Partial<LoopRuntimeSnapshot>;
  /** 追加式上下文集合（T4：同键同内容→跳过；同键不同内容→原位替换；新键→追加末尾） */
  contextStore?: ContextStore;
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
// StoppedReason → ExitReason 映射（Docs/Agent/11 §2.2 三套枚举收敛的过渡方案）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 将 StopRules 的 StoppedReason（7 值）映射到运行期 ExitReason（5 值）。
 * 完整枚举收敛（StoppedReason 单一源 + 其余再导出）列为后续待办；
 * 此处先消除"硬编码 'risk' 覆盖真实类别"的错误，保留语义上最近的类别。
 */
export function mapStoppedReasonToExitReason(reason: StoppedReason): ExitReason {
  switch (reason) {
    case 'success': return 'success';
    case 'limits': return 'max_iterations';
    case 'budget_soft':
    case 'budget_hard': return 'budget_exhausted';
    case 'no_progress': return 'no_progress';
    case 'risk':
    case 'human_abort': return 'risk';
  }
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
  const toolResults: ToolResult[] = [];
  let callResult: CallResult | undefined;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars

  const mwCtx: MiddlewareContext = {
    agentId: ctx.agentId,
    agentRole: ctx.agentRole,
    sessionId: ctx.sessionId,
    iteration: ctx.currentIteration,
    traceId: loopState.traceId,
    // FE-053：注入数据通道（此前恒 `{}`——BudgetSentinel 等依赖 data 的内置中间件永不触发）
    data: {
      tokenBudget: ctx.config.token_budget,
      tokensConsumed: ctx.totalTokensConsumed,
    },
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

    // beforeModel（FE-053 契约修复：入参 = 装配素材（对话历史副本）；钩子返回的 messages
    // 按 BeforeModelHook 契约回接下方 ④ 装配——此前入参恒 `undefined`（mwCtx.data 为空）
    // 且返回值被丢弃，GoalReanchor 等“消息改写”型钩子在数据/契约两层都不可达）
    const beforeModelResult = await executePrePostHooks('beforeModel', mwCtx, [...ctx.chatMessages]);
    if (beforeModelResult.shortCircuited) {
      return ok({
        outputText: '', toolCalls: [], toolResults: [], tokensConsumed: 0,
        decision: { shouldContinue: false, exitMessage: 'beforeModel short-circuited' },
        steps, events, shortCircuited: true,
        shortCircuitReason: 'beforeModel middleware short-circuited',
      });
    }
    // 回接：钩子返回新 messages 数组时以之为装配素材（否则用原始历史）
    const assemblySource: ChatMessage[] = Array.isArray(beforeModelResult.result)
      ? (beforeModelResult.result as ChatMessage[])
      : ctx.chatMessages;

    // ── ④ 上下文组装 ───────────────────────────────────
    recordStep(loopState, '④ ContextAssembly');

    // 将 ToolSpec 转换为 OpenAI 兼容的工具格式
    // ★ 头部冻结（2026-10-03）：OpenAI 兼容接口把 `tools` 放在**所有 messages 之前**，
    //   因此头部一旦变化，从该点起的前缀缓存全部失效；且"一开始注入全部工具"会让头部
    //   随工具增长而膨胀。这里只放**热工具 + 元工具**（默认约 10 个，会话内字节恒定）：
    //   其余工具由 Agent 通过 `tool.search` 探索（schema 作为工具结果追加到消息尾部，不破坏前缀），
    //   再用 `tool.execute` 统一派发执行（派发器按名字执行任意已注册工具，不要求它在头部）。
    const toolSpecs = buildToolHeader(ctx.agentRole as UserRole);
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
    // 工具数组按名称**确定性排序**（buildToolHeader 已排序，此处再保证一次），
    // 避免任何来源的顺序抖动影响前缀。
    })).sort((a, b) => a.function.name.localeCompare(b.function.name));

    // ── 系统提示：三区分离（静态段 / 工具目录 / 回合段）──
    //  借鉴 MongoTerminalAgent v2.0 `PromptBuilder`：**每轮变化的内容必须排在最后**，
    //  静态段在会话内保持字节恒定，才能命中提供商前缀缓存（其设计实测前缀稳定 >90%）。
    //  修复前：系统提示里逐条内联"工具名 + 描述"，工具集一变（增删工具/换角色）
    //  系统提示整段改变，前缀缓存从 system 消息起就失效。
    // FE-052：角色段 = promptRegistry 按 agentRole 装载的 Prompts/roles/{role}.md
    const systemPrompt = buildStableSystemPrompt(
      toolSpecs.map(s => s.name),
      getRolePrompt(ctx.agentRole),
    );

    // 追加式上下文（同键同内容→跳过；同键不同内容→原位替换；新键→追加末尾）；
    // FE-054：写侧 = ⑧ 步工具结果入 store（文件工作集），传递侧 = ipcBridge 创建会话级实例；
    // 四层分区装配见 Services/Context/assembler.ts（后续）
    const appended = ctx.contextStore ? ctx.contextStore.toAppendMessages() : [];
    let messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...assemblySource.map(m => ({
        role: m.role as ChatMessage['role'],
        content: m.content,
      })),
      ...appended.map(m => ({ role: 'system' as const, content: m.content })),
    ];

    // ── ⑤ 监管懒监听 ────────────────────────────────────
    const contextTokensBefore = estimateMessageTokens(messages);
    recordStep(loopState, '⑤ LazySupervision', {
      contextTokens: contextTokensBefore,
    });

    // FE-055：上下文压缩——超阈值时把历史旧段压缩为摘要（保留最近 keepRecentMessages 条），
    // 摘要后注入 GoalReanchor 重锚消息（“压缩后必须重锚目标”，Docs/Agent/02 §4.4），
    // 压缩成功后回写共享历史（内容等价时）使跨轮生效；fail-soft，绝不阻断迭代。
    if (assemblySource.length > 0) {
      const compression = await maybeCompressContext({
        messages: assemblySource,
        loopModel: ctx.config.model,
        goal: ctx.userInput,
        traceId: loopState.traceId,
        loopId: loopState.loopId,
      });
      if (compression.compressed) {
        // 重建本轮发送给模型的消息（系统提示 + 压缩后历史 + 追加区）
        messages = [
          { role: 'system', content: systemPrompt },
          ...compression.messages,
          ...appended.map(m => ({ role: 'system' as const, content: m.content })),
        ];
        // 跨轮生效：装配素材与共享历史内容等价（无钩子改写）时原位替换
        if (sameMessageContent(assemblySource, ctx.chatMessages)) {
          ctx.chatMessages.splice(0, ctx.chatMessages.length, ...compression.messages);
        }
        recordStep(loopState, '⑤ LazySupervision', {
          compressed: true,
          tokensBefore: Math.round(compression.tokensBefore),
          tokensAfter: Math.round(compression.tokensAfter),
        });
        logger.info('上下文压缩完成', {
          source: 'runIteration/⑤LazySupervision',
          tokensBefore: Math.round(compression.tokensBefore),
          tokensAfter: Math.round(compression.tokensAfter),
        });
      }
    }

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
      // 工具调用"生成中"去重集合：每个工具调用只在首个增量时通知一次
      // 按 index 去重（同一响应内序号稳定；id/name 可能分片到达）
      const pendingNotified = new Set<number>();
      const streamChunkHandler = (chunk: StreamChunk) => {
        // ① 转发给上层（文本/思考增量）
        ctx.onStreamChunk!(chunk);
        // ② 工具调用增量 → 通知"正在生成"，让前端立刻预创建工具块（显示"生成中/准备写入"）
        if (chunk.tool_call_delta?.length && ctx.onToolCallPending) {
          for (const d of chunk.tool_call_delta) {
            // 去重键用 **index**（同一响应内的稳定序号）：id/name 可能分片到达，
            // 用 id 做键会导致同一次调用被通知多次（实测出现两行"生成中"）。
            if (pendingNotified.has(d.index)) continue;
            // 等到拿到 id 或函数名再上报，避免先冒出一行无名工具
            if (!d.id && !d.name) continue;
            pendingNotified.add(d.index);
            ctx.onToolCallPending({
              toolCallId: d.id ?? '',
              index: d.index,
              ...(d.name ? { toolName: d.name } : {}),
              iteration: ctx.currentIteration,
            });
          }
        }
      };

      // 流式调用（经 wrapModelCall 中间件包裹）
      const streamResult = await executeWrapHooks<ModelCallInput, Result<CallResult>>(
        'wrapModelCall', mwCtx, modelInput,
        async (input) => {
          return callModelStream(
            input.model,
            input.messages as ChatMessage[],
            streamChunkHandler,
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

    // FE-065：Token 经济记账（消耗明细+扣费+税+双预算档位；fail-soft 不阻断循环）
    //   修复背景：recordConsumption / dualBudget 此前 0 生产调用——钱包余额恒定、档位永不产生。
    recordIterationEconomy({
      traceId: loopState.traceId,
      agentId: ctx.agentId,
      iteration: ctx.currentIteration,
      model: ctx.config.model,
      promptTokens: callResult?.usage.prompt_tokens ?? 0,
      completionTokens: callResult?.usage.completion_tokens ?? 0,
    });

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

        // 工具开始执行前先上报：前端据此**即时预创建**工具组件，
        // 保证流式内容与工具块的先后顺序与真实发生顺序一致
        // （若等整轮结束的 AGENT_ITERATION_COMPLETE 才上报，工具块会落到已流出的正文之后）。
        ctx.onToolCallStart?.({
          toolCallId: tc.id,
          toolName: tc.name,
          arguments: tc.arguments,
          iteration: ctx.currentIteration,
        });

        // wrapToolCall 中间件包裹
        // T1：所有工具调用统一经派发器（审计/耗时/归一口径一致）
        let lastToolDurationMs = 0;
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
              // 会话归属：需要按会话落库的工具（如 todo.write 计划清单）用它确定归属
              sessionId: ctx.sessionId,
              // 任务工作目录：路径型工具据此收敛（会话未绑定则为 undefined，退化为全局 pathGuard）
              workDir: ctx.workDir,
            };
            const outcome = await dispatchToolCall({
              toolName: input.toolName,
              arguments: input.arguments,
              context: toolCtx,
              iteration: ctx.currentIteration,
            });
            // 记录本轮耗时，供事件 payload 与界面展示（T2）
            lastToolDurationMs = outcome.durationMs;
            return {
              status: outcome.result.status,
              content: outcome.text,
              recoverable: outcome.result.recoverable,
            };
          },
        );

        // 工具执行结束（含被中间件短路/审批门拦截的情况）上报结果
        ctx.onToolCallResult?.({
          toolCallId: tc.id,
          toolName: tc.name,
          status: toolOutput.status === 'success' ? 'success' : 'error',
          content: toolOutput.content,
          recoverable: toolOutput.recoverable,
          iteration: ctx.currentIteration,
          durationMs: lastToolDurationMs,
        });

        // FE-054：文件类工具的成功结果写入追加区（写侧接线；键 = file:<path>，同文件原位替换）
        if (toolOutput.status === 'success') {
          recordFileWorkSet(ctx.contextStore, tc.name, tc.arguments, toolOutput.content);
        }

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

    // StopRules 五类独立退出（读取全局已登记的 StopRuleSet，而非每轮硬重建）
    let stopDecision: StopDecision | undefined;
    if (ctx.loopControlSnapshot) {
      const rules = getActiveStopRuleSet();
      const snapshot: LoopRuntimeSnapshot = {
        iteration: ctx.currentIteration,
        startedAt: loopState.startedAt,
        toolCallCount: ctx.loopControlSnapshot.toolCallCount ?? 0,
        consecutiveErrors: ctx.loopControlSnapshot.consecutiveErrors ?? 0,
        budgetUsed: { tokens: ctx.totalTokensConsumed + tokensConsumed, usd: 0 },
        recentMetrics: ctx.loopControlSnapshot.recentMetrics ?? [],
        // FE-070：子监管异常信号进入风险快照（此前 riskSignals 恒空——配置的 riskTriggers 永不可能触发）
        riskSignals: [
          ...(ctx.loopControlSnapshot.riskSignals ?? []),
          ...(postSupResult.ok ? postSupResult.value.anomalies : []),
        ],
        verifierPassed: ctx.loopControlSnapshot.verifierPassed ?? false,
      };

      if (rules) {
        stopDecision = evaluateStopRules(rules, {} as any, snapshot);
      } else {
        // 未登记全局 StopRuleSet（如测试场景）：按 LoopConfig 构建临时规则作为兜底
        const fallbackRules: StopRuleSet = {
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
        stopDecision = evaluateStopRules(fallbackRules, {} as any, snapshot);
      }

      if (stopDecision.shouldStop && !decision.shouldContinue) {
        // 两者一致，无需额外处理
      } else if (stopDecision.shouldStop) {
        decision.shouldContinue = false;
        // 保留真实退出类别（不再统一改写为 'risk'），映射到 ExitReason，见 Docs/Agent/11 §2.1
        decision.exitReason = mapStoppedReasonToExitReason(stopDecision.reason);
        decision.exitMessage = stopDecision.detail;
      }

      // FE-071：no-progress 退出时附加替代策略建议（Skills/strategies 候选集消费；
      // 候选耗尽 → 自动升级人工。策略轮换“继续执行”属 Loop 控制流后续改造，当前仅进退出详情/审计）
      if (stopDecision.shouldStop && stopDecision.reason === 'no_progress') {
        try {
          const candidates = getStrategyCandidates().map(c => c.strategy);
          if (candidates.length > 0) {
            const pick = selectNextStrategy(loopState.loopId, candidates);
            stopDecision = {
              shouldStop: true,
              reason: stopDecision.reason,
              detail: `${stopDecision.detail}；建议替代策略: ${pick.strategy}${pick.escalated ? '（候选耗尽→需人工介入）' : ''}`,
            };
          }
        } catch { /* fail-soft：策略建议不影响退出判定 */ }
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
 * ipcBridge 应调用本函数替代裸调 callModelStream。
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

    // 本轮**即时**上报（修复：此前所有轮次的完成事件都堆到 executeLoop 返回后才批量发布，
    // 使前端的工具块/轮次统计延迟到运行结束才出现）
    initialCtx.onIterationComplete?.({
      iteration: allIterations.length,
      totalIterations: allIterations.length, // 运行中未知总数，先给当前值（后续轮次会自然增大）
      outputText: iterResult.outputText,
      toolCalls: iterResult.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
      toolResults: iterResult.toolResults.map((tr) => ({
        tool_call_id: tr.tool_call_id,
        status: tr.status,
        ...(tr.content !== undefined ? { content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content) } : {}),
        ...(tr.error ? { error: tr.error } : {}),
      })),
      tokensConsumed: iterResult.tokensConsumed,
      decision: iterResult.decision?.exitReason ?? 'unknown',
    });

    // ★ 迭代边界写快照（2026-10-04 新增，修复"运行期无 checkpoint"）
    //   此前 `checkpointStore.createCheckpoint` 无任何运行期调用方 → 崩溃恢复链路形同虚设
    //   （`recoveryScanner.loadLatestCheckpoint` 永远读不到东西）。这里在每轮末尾原子写入。
    writeIterationCheckpoint({
      loopId: loopState.loopId,
      iteration: allIterations.length,
      decision: iterResult.decision?.exitReason ?? 'unknown',
      completedSteps: allIterations.length,
      failedAttempts: allIterations.filter(it => it.decision?.exitReason === 'risk').length,
      toolNames: iterResult.toolCalls.map(tc => tc.name),
      pendingEffects: (() => {
        const unknown = getUnknownEffects(loopState.loopId);
        return unknown.ok ? unknown.value.map(e => ({ effectId: e.effectId })) : [];
      })(),
      nextStepHint: iterResult.decision?.shouldContinue
        ? `继续第 ${allIterations.length + 1} 轮`
        : '任务已结束，无需续跑',
    });

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

  // FE-059：Loop 成功退出 → 知识沉淀（观察入共享工作区 → 提炼长期记忆；fail-soft）
  //   修复背景：此前 Loop 出口无任何沉淀调用（“接线尚未落地”），且 GlobalWorkspace
  //   运行期无写方——本调用同时解决两者。
  consolidateLoopKnowledge({
    loopId: loopState.loopId,
    traceId: loopState.traceId,
    agentId: loopState.agentId,
    exitReason: finalIteration?.decision.exitReason,
    outputText: finalIteration?.outputText,
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
