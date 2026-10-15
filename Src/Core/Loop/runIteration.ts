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
import {
  runPreSupervision,
  collectUntrustedSegments,
} from "../../Services/Supervision/preSupervision.js";
import {
  runPostSupervision,
  accumulateConsecutiveErrors,
} from "../../Services/Supervision/postSupervision.js";
import {
  evaluateStopRules,
  getActiveStopRuleSet,
  type StopRuleSet,
  type LoopRuntimeSnapshot,
  type StopDecision,
} from "../../Services/LoopControl/stopRules.js";
import type { StoppedReason } from "../../Services/LoopControl/types.js";
import { dispatchHook } from "../../Services/Hook/hookRegistry.js";
import {
  recordFileWorkSet,
  buildWorkspaceSection,
  type ContextStore,
} from "../../Services/Context/contextStore.js";
import {
  getRolePrompt,
  getSystemMainLoop,
} from "../../Services/Prompts/promptRegistry.js";
import { getStrategyCandidates } from "../../Services/Prompts/skillsAssets.js";
import { selectNextStrategy } from "../../Services/LoopControl/strategyLedger.js";

// ── Core 层 ──
import {
  executePrePostHooks,
  executeWrapHooks,
  registerMiddleware,
  unregisterMiddleware,
} from "../Middleware/middlewareRegistry.js";
import type {
  MiddlewareContext,
  ModelCallInput,
  ModelCallOutput,
  ToolCallInput,
  ToolCallOutput,
} from "../../Infra/Contracts/middlewareTypes.js";
import {
  callModel,
  callModelStream,
  type ChatMessage,
  type CallResult,
  type StreamChunk,
} from "../Model/modelCaller.js";
import {
  estimateMessageTokens,
  maybeCompressContext,
  sameMessageContent,
} from "./contextCompression.js";
import { consolidateLoopKnowledge } from "./loopKnowledge.js";
import { recordIterationEconomy } from "./loopEconomy.js";

// ── Services 层中间件 ──
import { createToolSafetyGateMiddleware } from "../../Services/LoopControl/middleware/toolSafetyGate.js";

// ── Tools 层 ──
import { dispatchToolCall } from "../../Tools/Registry/toolDispatcher.js";
import { buildToolHeader } from "../../Tools/Registry/toolHeader.js";
import { writeIterationCheckpoint } from "../../Infra/DurableExecution/iterationCheckpoint.js";
import { getUnknownEffects } from "../../Infra/DurableExecution/effectJournal.js";
import type {
  ToolExecutionContext,
  ToolResult,
} from "../../Tools/Traits/toolSpec.js";
import type { UserRole } from "../../Infra/types.js";

// ── Infra 层 ──
import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import { logger } from "../../Infra/Logging/logger.js";
import { recordControlTrigger } from "../../Infra/Logging/controlTriggers.js";
import { computeFingerprint } from "../../Services/LoopControl/actionFingerprint.js";

import type { LoopConfig } from "./loopConfig.js";
import {
  decideIteration,
  EXIT_REASONS,
  type IterationDecisionInput,
} from "./iterationController.js";
import type { IterationDecision, ExitReason } from "./iterationController.js";
import {
  recordLoopEvent,
  assertStepOrder,
  detectRepetitiveFingerprint,
} from "./loopEngine.js";
import type { LoopState, LoopStep, LoopEvent } from "./loopEngine.js";

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

/** 系统提示缓存上限（超出后按 **LRU 逐出**，不再全量清空） */
const SYSTEM_PROMPT_CACHE_MAX = 64;

/** 构造前缀稳定的系统提示（角色段 + 静态段 + [系统资产段] + 排序后的工具目录） */
export function buildStableSystemPrompt(
  toolNames: string[],
  rolePrompt?: string,
  cache = true,
): string {
  const sorted = [...toolNames].sort();
  const roleSegment = rolePrompt?.trim()
    ? `${rolePrompt.trim()}\n\n---\n\n`
    : "";
  // FE-069：Prompts/system/mainLoop.md 资产段（未装载 → 空段，行为与修复前一致）
  const systemAsset = getSystemMainLoop();
  const assetSegment = systemAsset ? `\n\n---\n\n${systemAsset}` : "";
  // 缓存键含角色段与资产段：相同工具集下的不同角色（或资产变更）不得命中同一缓存
  const cacheKey = `${roleSegment}\u0000${assetSegment}\u0000${sorted.join("\u0000")}`;
  if (cache) {
    const hit = systemPromptCache.get(cacheKey);
    if (hit !== undefined) {
      // LRU：命中即刷新插入序（Map 保持插入顺序，重新 set 移到末尾）
      systemPromptCache.delete(cacheKey);
      systemPromptCache.set(cacheKey, hit);
      return hit;
    }
  }
  const catalog =
    sorted.length > 0
      ? `\n\n## Available tools\n${sorted.map((n) => `- ${n}`).join("\n")}\n(Tool schemas are provided through the API \`tools\` parameter.)`
      : "";
  const prompt = `${roleSegment}${STATIC_SYSTEM_PROMPT}${assetSegment}${catalog}`;
  if (cache) {
    // P2-16 修复（控制论审查）：原实现在 size > 64 时 `clear()` **全量清空**，
    // 一次性打掉整个会话的前缀缓存命中（与本项目"前缀稳定 >90%"的目标直接冲突）。
    // 改为 LRU 逐出最旧一条：缓存退化为一条，而不是全部失效。
    while (systemPromptCache.size >= SYSTEM_PROMPT_CACHE_MAX) {
      const oldest = systemPromptCache.keys().next();
      if (oldest.done) break;
      systemPromptCache.delete(oldest.value);
    }
    systemPromptCache.set(cacheKey, prompt);
  }
  return prompt;
}

/** 当前系统提示缓存条目数（诊断 / 测试用） */
export function getSystemPromptCacheSize(): number {
  return systemPromptCache.size;
}

/** 测试/诊断用：清空系统提示缓存 */
export function resetSystemPromptCache(): void {
  systemPromptCache.clear();
}

/** ⑷ 装配期检索的默认召回条数（上层入口，见 IterationContext.memorySearchPort） */
const RETRIEVAL_ASSEMBLY_TOP_K = 5;

import { retrieveForContextAssembly } from "./memoryRetrievalEntry.js";

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
    status: "success" | "error";
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
    toolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }>;
    toolResults: Array<{
      tool_call_id: string;
      status: string;
      content?: string;
      error?: { code: string; message: string };
    }>;
    /** 本轮消耗 Token（前端轮次统计用） */
    tokensConsumed: number;
    /** 本轮决策（退出原因） */
    decision: string;
  }) => void;
  /**
   * 本轮开始前已连续发生的工具错误数（由 `executeLoop` 跨轮维护）。
   * 缺省 0。用于把"连续 N 次工具失败才终止"落到判定里（`maxConsecutiveErrors`）。
   */
  consecutiveErrorCount?: number;
  /** 追加式上下文集合（T4：同键同内容→跳过；同键不同内容→原位替换；新键→追加末尾） */
  contextStore?: ContextStore;
  /**
   * 检索的**上层入口**（裁定 (a)，2026-10-14 项目负责人）。
   *
   * 记忆检索属 Services 层；此前产品里只有 Tools 层的 `vector.search` 能到达它，
   * **Core 没有检索调用点**（见 AG-SEC-POISON「检索器未接入 prompt」）。
   * 本端口由组合根注入，供 ⑷ ContextAssembly 经 Core 驱动检索 —— 即"调被测层之上的接口"。
   *
   * 未注入时该分支不执行，行为与改动前完全一致。
   * @param query 检索查询（取本轮最后一条 user 消息）
   * @param limit 返回条数上限
   */
  memorySearchPort?: (
    query: string,
    limit: number,
  ) => Promise<Array<{ key: string; content: string }>>;
}

/**
 * LoopControl 视图（**必填内部通道**，P0-1 修复）。
 *
 * 为什么把它做成 `runIteration` 的**独立必填参数**，而不是 `IterationContext` 上的可选字段：
 * 此前 `ctx.loopControlSnapshot?` 是"调用方可以顺手传、也可以不传"的透传字段，而两个生产
 * 调用点（`ipcBridge` / `agentExecutor`）**都没传** → 整段 `evaluateStopRules()` 不可达，
 * `limits`（墙钟 / 工具数）、`budget_hard`、`no_progress`、`risk` 四类判据在生产路径上从未生效。
 * 现在契约是：视图由 `executeLoop` 每轮边界用**本地已有量**构造，类型层面不允许外部不传。
 */
export interface LoopControlView {
  /** 本轮开始前的工具调用累计数 */
  toolCallCount: number;
  /** 本轮开始前的连续工具错误数 */
  consecutiveErrors: number;
  /** 近轮进展度量（禁止用"有无输出"冒充，见 P1-5） */
  recentMetrics: number[];
  /** 跨轮累积的风险信号（如 `repetitive_output`） */
  riskSignals: string[];
  /** 真验证器是否通过（未接验证器时为 false） */
  verifierPassed: boolean;
}

/**
 * 构造 LoopControl 视图（`executeLoop` 与测试共用）。
 * 缺省即"全零视图"——不满足任何判据，语义上等价于"回路尚未观察到任何信号"。
 */
export function createLoopControlView(
  partial: Partial<LoopControlView> = {},
): LoopControlView {
  return {
    toolCallCount: 0,
    consecutiveErrors: 0,
    recentMetrics: [],
    riskSignals: [],
    verifierPassed: false,
    ...partial,
  };
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
/**
 * `StoppedReason` → `ExitReason` 的**唯一映射表**。
 *
 * 收敛方案的落地（Docs/Agent/11 §2.2；控制论审查第 4 条后半句
 * "以 `StoppedReason` 为单一事实源，其余再导出"）：
 * 表类型写成 `Record<StoppedReason, ExitReason>` 是为了拿到**编译期强制**——
 * `StoppedReason` 一旦新增取值，这张表立刻报缺项，迫使实现同步决定它的退出类别。
 * 因此"单一事实源"从注释承诺变成可验证约束；`iterationController` 的 `ExitReason`
 * 只是它的**下游投影**（再导出），不再各自维护。
 */
const STOPPED_REASON_TO_EXIT_REASON: Record<StoppedReason, ExitReason> = {
  success: "success",
  limits: "max_iterations",
  budget_soft: "budget_exhausted",
  budget_hard: "budget_exhausted",
  no_progress: "no_progress",
  risk: "risk",
  // `human_abort` 不再折进 `'risk'`（P1-4：观测通道信息量不得丢失）——
  // 归入 `intercepted`（外部干预导致的终止），与"风险触发"可区分。
  human_abort: "intercepted",
};

/** 将 StopRules 的 `StoppedReason` 投影为运行期 `ExitReason`（多对一，见上表） */
export function mapStoppedReasonToExitReason(
  reason: StoppedReason,
): ExitReason {
  return STOPPED_REASON_TO_EXIT_REASON[reason];
}

/**
 * 校验并归一短路类中间件声明的退出类别（P1-4）。
 * 只接受 `ExitReason` 白名单内的值；非法/缺失一律回落到 `'intercepted'`
 * （"被中间件拦截"是唯一无争议的语义），绝不回落到 `'success'`。
 */
export function mapShortCircuitExitReason(raw: string | undefined): ExitReason {
  if (raw && (EXIT_REASONS as readonly string[]).includes(raw)) {
    return raw as ExitReason;
  }
  return "intercepted";
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
      .filter(
        (tc: unknown) =>
          tc &&
          typeof tc === "object" &&
          (tc as Record<string, unknown>).function,
      )
      .map((tc: unknown) => {
        const rec = tc as Record<string, unknown>;
        const fn = rec.function as Record<string, unknown>;
        let args: Record<string, unknown> = {};
        try {
          args =
            typeof fn.arguments === "string"
              ? JSON.parse(fn.arguments)
              : ((fn.arguments as Record<string, unknown>) ?? {});
        } catch {
          /* 忽略解析错误 */
        }
        return {
          id: (rec.id as string) ?? `tc-${Date.now()}`,
          name: (fn.name as string) ?? "",
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
      const parsed = JSON.parse(match[1] ?? "{}");
      if (parsed.name) {
        toolCalls.push({
          id: parsed.id ?? `tc-${Date.now()}-${toolCalls.length}`,
          name: parsed.name,
          arguments: parsed.arguments ?? {},
        });
      }
    } catch {
      /* 非 JSON 块，跳过 */
    }
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
  control: LoopControlView,
): Promise<Result<IterationResult>> {
  const steps: LoopStep[] = [];
  const events: LoopEvent[] = [];
  let shortCircuited = false;
  let shortCircuitReason: string | undefined;
  let tokensConsumed = 0;
  let outputText = "";
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
    // P0-2：回路作用域标识——执行器据此只跑「全局 + 本 Loop」的中间件，
    // 避免并发会话互相执行对方的安全门（归属错位 / 管控消失）
    loopId: loopState.loopId,
    // FE-053：注入数据通道（此前恒 `{}`——BudgetSentinel 等依赖 data 的内置中间件永不触发）
    data: {
      tokenBudget: ctx.config.token_budget,
      // P0-3：账本唯一事实源 = `loopState.iteration.totalTokensConsumed`（由 ⑩ decideIteration 累加）。
      // `tokensConsumed` 是本轮**开始前**的累计值——单独用它会让哨兵滞后一整轮。
      tokensConsumed: loopState.iteration.totalTokensConsumed,
      // 半轮内的前瞻：本轮将发给模型的对话历史规模估算（哨兵据此把滞后缩到半轮以内）
      estimatedPromptTokens: estimateMessageTokens(ctx.chatMessages),
      // ── P1-5 / P1-7 / P2-11：把 LoopState 的控制面注入中间件数据通道 ──
      // `loopState` 本体供 GoalReanchorControl 等控制器读取真实运行态
      // （P2-11 合并后它与 `ControlLoopStateView` 同构，可直接消费）；
      // 内置中间件走下面的扁平副本，避免它们依赖 LoopState 具体类型。
      loopState,
      currentGoal: loopState.goal.originalRequirement || ctx.userInput,
      // 上一轮 ⑤ 压缩置位的重锚请求（跨轮生效：⑤ 在 beforeModel 之后，故只能下一轮消费）
      needsGoalReanchor: loopState.needsGoalReanchor,
      // 指纹历史**按引用**注入：内置 FingerprintDetector 的 push 因此跨轮持久
      // （修复前它写在本轮新建的 `ctx.data` 上，数组长度恒 ≤1 → 振荡检测结构上不可能命中）
      fingerprintHistory: loopState.fingerprintHistory,
    },
  };

  function recordStep(
    state: LoopState,
    step: LoopStep,
    data: Record<string, unknown> = {},
  ): void {
    steps.push(step);
    events.push(recordLoopEvent(state, step, data));
  }

  try {
    // ── ① 输入接收 ──────────────────────────────────────
    recordStep(loopState, "① InputReceived", {
      userInputLength: ctx.userInput.length,
      iteration: ctx.currentIteration,
    });

    const inputHookResult = await dispatchHook("UserInputReceived", {
      userInput: ctx.userInput,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
    });
    if (inputHookResult.intercepted) {
      shortCircuited = true;
      shortCircuitReason = `Input intercepted: ${inputHookResult.interceptReason}`;
      return ok({
        outputText: "",
        toolCalls: [],
        toolResults: [],
        tokensConsumed: 0,
        decision: {
          shouldContinue: false,
          exitReason: "intercepted",
          exitMessage: shortCircuitReason,
        },
        steps,
        events,
        shortCircuited: true,
        shortCircuitReason,
      });
    }

    // ── ② 前置监管 ──────────────────────────────────────
    recordStep(loopState, "② PreSupervision");

    const preSupResult = runPreSupervision({
      userInput: ctx.userInput,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      recentCallTimestamps: ctx.recentCallTimestamps,
      // P2-14：把"最后一条 user 消息之后新出现的工具结果 / 模型产出"作为不可信内容送检——
      // 修复前只检测 `ctx.userInput`（与 Hook 入参同源、永远是同一条原始输入），
      // 工具返回值里的间接注入这条真实攻击面完全无覆盖。
      untrustedSegments: collectUntrustedSegments(ctx.chatMessages),
    });

    if (preSupResult.ok && !preSupResult.value.passed) {
      return ok({
        outputText: "",
        toolCalls: [],
        toolResults: [],
        tokensConsumed: 0,
        decision: {
          shouldContinue: false,
          exitReason: "pre_supervision" as const,
          exitMessage: `Pre-supervision rejected: ${preSupResult.value.rejectReason}`,
        },
        steps,
        events,
        shortCircuited: true,
        shortCircuitReason: `Pre-supervision: ${preSupResult.value.rejectReason}`,
      });
    }

    // ── ③ 中间件管线 ────────────────────────────────────
    recordStep(loopState, "③ Middleware");

    // beforeAgent
    const beforeAgentResult = await executePrePostHooks("beforeAgent", mwCtx);
    if (beforeAgentResult.shortCircuited) {
      return ok({
        outputText: "",
        toolCalls: [],
        toolResults: [],
        tokensConsumed: 0,
        // P1-4：退出类别不再坍缩为 'risk'——"被中间件拦截"是独立类别
        decision: {
          shouldContinue: false,
          exitReason: "intercepted",
          exitMessage: "beforeAgent short-circuited",
        },
        steps,
        events,
        shortCircuited: true,
        shortCircuitReason: "beforeAgent middleware short-circuited",
      });
    }

    // beforeModel（FE-053 契约修复：入参 = 装配素材（对话历史副本）；钩子返回的 messages
    // 按 BeforeModelHook 契约回接下方 ④ 装配——此前入参恒 `undefined`（mwCtx.data 为空）
    // 且返回值被丢弃，GoalReanchor 等“消息改写”型钩子在数据/契约两层都不可达）
    const beforeModelResult = await executePrePostHooks("beforeModel", mwCtx, [
      ...ctx.chatMessages,
    ]);
    if (beforeModelResult.shortCircuited) {
      // P1-4：终止类中间件（如 BudgetSentinel）经**短路通道**退出，并可携带**显式退出类别**。
      // 修复前它是返回一条"看起来完全成功"的伪正文 → ⑦ 解析无 tool_calls → ⑩ 判 success，
      // 把"预算耗尽"记成"任务圆满完成"。
      const scResult = beforeModelResult.result as
        { exitReason?: string; reason?: string } | undefined;
      const scExitReason = mapShortCircuitExitReason(scResult?.exitReason);
      return ok({
        outputText: "",
        toolCalls: [],
        toolResults: [],
        tokensConsumed: 0,
        decision: {
          shouldContinue: false,
          exitReason: scExitReason,
          exitMessage: `beforeModel 短路退出${scResult?.reason ? `（${scResult.reason}）` : ""}`,
        },
        steps,
        events,
        shortCircuited: true,
        shortCircuitReason: `beforeModel middleware short-circuited${scExitReason ? `: ${scExitReason}` : ""}`,
      });
    }
    // 回接：钩子返回新 messages 数组时以之为装配素材（否则用原始历史）
    const assemblySource: ChatMessage[] = Array.isArray(
      beforeModelResult.result,
    )
      ? (beforeModelResult.result as ChatMessage[])
      : ctx.chatMessages;

    // ── ④ 上下文组装 ───────────────────────────────────
    recordStep(loopState, "④ ContextAssembly");

    // 将 ToolSpec 转换为 OpenAI 兼容的工具格式
    // ★ 头部冻结（2026-10-03）：OpenAI 兼容接口把 `tools` 放在**所有 messages 之前**，
    //   因此头部一旦变化，从该点起的前缀缓存全部失效；且"一开始注入全部工具"会让头部
    //   随工具增长而膨胀。这里只放**热工具 + 元工具**（默认约 10 个，会话内字节恒定）：
    //   其余工具由 Agent 通过 `tool.search` 探索（schema 作为工具结果追加到消息尾部，不破坏前缀），
    //   再用 `tool.execute` 统一派发执行（派发器按名字执行任意已注册工具，不要求它在头部）。
    const toolSpecs = buildToolHeader(ctx.agentRole as UserRole);
    const tools = toolSpecs
      .map((spec) => ({
        type: "function" as const,
        function: {
          name: spec.name,
          description: spec.description,
          parameters: {
            type: "object",
            properties: spec.inputSchema.properties,
            required: spec.inputSchema.required ?? [],
            additionalProperties:
              spec.inputSchema.additionalProperties ?? false,
          },
        },
        // 工具数组按名称**确定性排序**（buildToolHeader 已排序，此处再保证一次），
        // 避免任何来源的顺序抖动影响前缀。
      }))
      .sort((a, b) => a.function.name.localeCompare(b.function.name));

    // ── 系统提示：三区分离（静态段 / 工具目录 / 回合段）──
    //  借鉴 MongoTerminalAgent v2.0 `PromptBuilder`：**每轮变化的内容必须排在最后**，
    //  静态段在会话内保持字节恒定，才能命中提供商前缀缓存（其设计实测前缀稳定 >90%）。
    //  修复前：系统提示里逐条内联"工具名 + 描述"，工具集一变（增删工具/换角色）
    //  系统提示整段改变，前缀缓存从 system 消息起就失效。
    // FE-052：角色段 = promptRegistry 按 agentRole 装载的 Prompts/roles/{role}.md
    const systemPrompt = buildStableSystemPrompt(
      toolSpecs.map((s) => s.name),
      getRolePrompt(ctx.agentRole),
    );

    // 追加式上下文（同键同内容→跳过；同键不同内容→原位替换；新键→追加末尾）；
    // FE-054：写侧 = ⑧ 步工具结果入 store（文件工作集），传递侧 = ipcBridge 创建会话级实例；
    // 四层分区装配见 Services/Context/assembler.ts（后续）
    // 会话工作目录：`workDir` 若只进工具上下文，模型就不知道自己在哪个目录，只能猜 `.`/`/`
    // 并触发 PATH_DENIED → 空转或一失败即退。写进追加区（消息尾部）让模型可见且不破坏前缀缓存。
    const workspaceSection = buildWorkspaceSection(ctx.workDir);
    if (workspaceSection && ctx.contextStore) {
      ctx.contextStore.put(workspaceSection);
    }
    // ⑷ 检索的**上层入口**（裁定 (a)）：经 Core 层入口函数检索，结果进追加式上下文。
    //   与 Benchmark 实验台**共用同一入口**（Src/Core/Loop/memoryRetrievalEntry.ts），
    //   故"经上层驱动"是真的。端口未注入 / 无命中时不改动上下文（行为与改动前一致）。
    if (ctx.memorySearchPort && ctx.contextStore) {
      const query =
        [...assemblySource].reverse().find((m) => m.role === "user")?.content ??
        "";
      const section = await retrieveForContextAssembly(
        ctx.memorySearchPort,
        query,
        RETRIEVAL_ASSEMBLY_TOP_K,
      );
      if (section) ctx.contextStore.put(section);
    }

    const appended = ctx.contextStore
      ? ctx.contextStore.toAppendMessages()
      : [];
    let messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      // 工具关联字段随历史一起搬（REV-341）：这里只取 {role, content} 的话，
      // ⑥ 步再怎么保留也已无从可留——调用与结果的配对在此就断了。
      ...assemblySource.map((m) => ({
        role: m.role as ChatMessage["role"],
        content: m.content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_calls && m.tool_calls.length > 0
          ? { tool_calls: m.tool_calls }
          : {}),
      })),
      ...appended.map((m) => ({ role: "system" as const, content: m.content })),
    ];

    // ── ⑤ 监管懒监听 ────────────────────────────────────
    const contextTokensBefore = estimateMessageTokens(messages);
    recordStep(loopState, "⑤ LazySupervision", {
      contextTokens: contextTokensBefore,
    });

    // FE-055：上下文压缩——超阈值时把历史旧段压缩为摘要（保留最近 keepRecentMessages 条），
    // 摘要后注入 GoalReanchor 重锚消息（“压缩后必须重锚目标”，Docs/Agent/02 §4.4），
    // 压缩成功后回写共享历史（内容等价时）使跨轮生效；fail-soft，绝不阻断迭代。
    if (assemblySource.length > 0) {
      // 《一些思考3》落实：把「难度旁路信号 + 工具膨胀信号」交给压缩编排入口，
      // 由它按水位线/难度档/成本模型选层级，再由多台管理策略机执行。
      const toolCallCount = assemblySource.filter(
        (m) => (m.tool_calls?.length ?? 0) > 0,
      ).length;
      const toolOutputTokens = assemblySource.reduce(
        (max, m) =>
          m.role === "tool"
            ? Math.max(max, Math.ceil((m.content?.length ?? 0) / 4))
            : max,
        0,
      );
      const compression = await maybeCompressContext({
        messages: assemblySource,
        loopModel: ctx.config.model,
        goal: ctx.userInput,
        traceId: loopState.traceId,
        loopId: loopState.loopId,
        complexityHints: { messageCount: assemblySource.length, toolCallCount },
        toolOutputTokens,
      });
      if (compression.compressed) {
        // 重建本轮发送给模型的消息（系统提示 + 压缩后历史 + 追加区）
        messages = [
          { role: "system", content: systemPrompt },
          ...compression.messages,
          ...appended.map((m) => ({
            role: "system" as const,
            content: m.content,
          })),
        ];
        // 跨轮生效：装配素材与共享历史内容等价（无钩子改写）时原位替换
        if (sameMessageContent(assemblySource, ctx.chatMessages)) {
          ctx.chatMessages.splice(
            0,
            ctx.chatMessages.length,
            ...compression.messages,
          );
        }
        recordStep(loopState, "⑤ LazySupervision", {
          compressed: true,
          tokensBefore: Math.round(compression.tokensBefore),
          tokensAfter: Math.round(compression.tokensAfter),
        });
        logger.info("上下文压缩完成", {
          source: "runIteration/⑤LazySupervision",
          tokensBefore: Math.round(compression.tokensBefore),
          tokensAfter: Math.round(compression.tokensAfter),
        });

        // ── P1-7：压缩后**置位重锚请求** ──
        // "压缩后必须重锚目标"（Docs/Agent/02 §4.4）此前只有消费者、没有置位方：
        // 真实压缩发生在这里，而这里从不写标记 → 重锚链路整体不可达。
        // 现在同时置位在 LoopState（P2-11 后的共享控制面）与中间件数据通道（本轮即时生效）。
        loopState.needsGoalReanchor = true;
        mwCtx.data["needsGoalReanchor"] = true;
      }
    }

    // ── ⑥ 模型调用 ──────────────────────────────────────
    recordStep(loopState, "⑥ ModelCall");

    const modelInput: ModelCallInput = {
      // 工具关联字段必须随行（REV-341）：只取 {role, content} 会让第二轮起的
      // `role:'tool'` 结果无人认领，供应商直接判请求非法。
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_calls && m.tool_calls.length > 0
          ? { tool_calls: m.tool_calls }
          : {}),
      })),
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
              toolCallId: d.id ?? "",
              index: d.index,
              ...(d.name ? { toolName: d.name } : {}),
              iteration: ctx.currentIteration,
            });
          }
        }
      };

      // 流式调用（经 wrapModelCall 中间件包裹）
      const streamResult = await executeWrapHooks<
        ModelCallInput,
        Result<CallResult>
      >("wrapModelCall", mwCtx, modelInput, async (input) => {
        return callModelStream(
          input.model,
          input.messages as ChatMessage[],
          streamChunkHandler,
          modelCallOptions,
        );
      });

      if (streamResult.ok) {
        callResult = streamResult.value;
        outputText = streamResult.value.content;
        tokensConsumed = streamResult.value.usage.total_tokens;
        modelOutput = {
          content: outputText,
          usage: {
            inputTokens: streamResult.value.usage.prompt_tokens,
            outputTokens: streamResult.value.usage.completion_tokens,
          },
        };
      } else {
        return ok({
          outputText: "",
          toolCalls: [],
          toolResults: [],
          tokensConsumed: 0,
          decision: {
            shouldContinue: false,
            exitReason: "model_error",
            exitMessage: `Model call failed: ${streamResult.error}`,
          },
          steps,
          events,
          shortCircuited: true,
          shortCircuitReason: streamResult.error,
        });
      }
    } else {
      // 非流式调用（经 wrapModelCall 中间件包裹）
      let modelCallError: string | null = null;
      modelOutput = await executeWrapHooks<ModelCallInput, ModelCallOutput>(
        "wrapModelCall",
        mwCtx,
        modelInput,
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
              usage: {
                inputTokens: result.value.usage.prompt_tokens,
                outputTokens: result.value.usage.completion_tokens,
              },
            };
          }
          // REV-341：此前这里回 `{ content: 'ERROR: …' }` 把失败伪装成正文，
          //  iterationController 见"有正文、无 tool_calls"便判 final answer → success，
          //  供应商的 400/鉴权错误于是以"模型的回答"呈现给用户。与流式分支同样诚实短路。
          modelCallError = result.error;
          return { content: "", usage: { inputTokens: 0, outputTokens: 0 } };
        },
      );
      if (modelCallError !== null) {
        return ok({
          outputText: "",
          toolCalls: [],
          toolResults: [],
          tokensConsumed: 0,
          decision: {
            shouldContinue: false,
            exitReason: "model_error",
            exitMessage: `Model call failed: ${modelCallError}`,
          },
          steps,
          events,
          shortCircuited: true,
          shortCircuitReason: modelCallError,
        });
      }
      outputText = modelOutput.content;
      tokensConsumed =
        (modelOutput.usage?.inputTokens ?? 0) +
        (modelOutput.usage?.outputTokens ?? 0);
    }

    recordStep(loopState, "⑥ ModelCall", {
      tokensConsumed,
      model: ctx.config.model,
    });

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
    await executePrePostHooks("afterModel", mwCtx, modelOutput);

    // ── ⑦ 输出解析 ──────────────────────────────────────
    recordStep(loopState, "⑦ OutputParse");

    const parsed = parseModelOutput(outputText, callResult);
    outputText = parsed.text;
    toolCalls = parsed.toolCalls;

    recordStep(loopState, "⑦ OutputParse", {
      textLength: outputText.length,
      toolCallCount: toolCalls.length,
    });

    // ── ⑧ 工具执行 ──────────────────────────────────────
    if (toolCalls.length > 0) {
      recordStep(loopState, "⑧ ToolExecute");

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
        const toolOutput = await executeWrapHooks<
          ToolCallInput,
          ToolCallOutput
        >("wrapToolCall", mwCtx, toolCallInput, async (input) => {
          const toolCtx: ToolExecutionContext = {
            operationId: tc.id,
            agentId: ctx.agentId,
            agentRole: ctx.agentRole as ToolExecutionContext["agentRole"],
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
        });

        // 工具执行结束（含被中间件短路/审批门拦截的情况）上报结果
        ctx.onToolCallResult?.({
          toolCallId: tc.id,
          toolName: tc.name,
          status: toolOutput.status === "success" ? "success" : "error",
          content: toolOutput.content,
          recoverable: toolOutput.recoverable,
          iteration: ctx.currentIteration,
          durationMs: lastToolDurationMs,
        });

        // FE-054：文件类工具的成功结果写入追加区（写侧接线；键 = file:<path>，同文件原位替换）
        if (toolOutput.status === "success") {
          recordFileWorkSet(
            ctx.contextStore,
            tc.name,
            tc.arguments,
            toolOutput.content,
          );
        }

        // 工具已在 wrapToolCall 内执行，此处构造结果记录
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          status: toolOutput.status as "success" | "error",
          recoverable: toolOutput.recoverable,
          content: toolOutput.content,
        } as ToolResult);
      }

      recordStep(loopState, "⑧ ToolExecute", {
        toolCount: toolCalls.length,
        successCount: toolResults.filter((r) => r.status === "success").length,
        errorCount: toolResults.filter((r) => r.status === "error").length,
      });
    }

    // ── ⑨ 后置监管 ──────────────────────────────────────
    recordStep(loopState, "⑨ PostSupervision");

    const postSupResult = runPostSupervision({
      outputText,
      toolResults: toolResults.map((r) => ({
        toolName: r.tool_call_id,
        status: r.status,
        recoverable: r.recoverable,
      })),
      tokensConsumed,
      // P0-3：从**唯一账本**读（⑩ 尚未累加，故取"账本 + 本轮"= 本轮结束时的账本值）。
      // 修复前这里是第三套独立求和（`ctx.totalTokensConsumed + tokensConsumed`），
      // 与 executeLoop 本地累加、decideIteration、mwCtx.data 四源互不校验。
      totalTokensConsumed:
        loopState.iteration.totalTokensConsumed + tokensConsumed,
      tokenBudget: ctx.config.token_budget,
      currentIteration: ctx.currentIteration,
      maxIterations: ctx.config.max_iterations,
      // 连续错误阈值取自已登记的 StopRuleSet（main.ts ⑮ 由 Configs/loopConfig.json 构建）；
      // 未登记（测试/子 Agent 场景）时用 DEFAULT_MAX_CONSECUTIVE_ERRORS，与配置默认值一致。
      consecutiveErrors: ctx.consecutiveErrorCount ?? 0,
      maxConsecutiveErrors: getActiveStopRuleSet()?.limits.maxConsecutiveErrors,
    });

    // ── ⑩ 迭代判定 ──────────────────────────────────────
    recordStep(loopState, "⑩ IterationDecision");

    const iterInput: IterationDecisionInput = {
      hadToolCall: toolCalls.length > 0,
      tokensConsumed,
      hasOutput: outputText.length > 0,
      riskDetected:
        postSupResult.ok && postSupResult.value.anomalies.length > 0,
    };
    const decision = decideIteration(loopState.iteration, iterInput);

    // 工具连续失败退出时保留详细说明：decideIteration 只会写 "Risk detected, forced exit"，
    // 排障时看不到是哪个工具、失败了几次（原实现的 exitMessage 等于没有信息）。
    if (
      postSupResult.ok &&
      postSupResult.value.exitDecision.shouldExit &&
      postSupResult.value.exitDecision.exitReason === "error" &&
      !decision.shouldContinue
    ) {
      decision.exitMessage =
        postSupResult.value.exitDecision.message ?? decision.exitMessage;
    }

    // StopRules 五类独立退出（读取全局已登记的 StopRuleSet，而非每轮硬重建）
    //
    // P0-1 修复（2026-10-11 控制论审查）：此处**不再**包在 `if (ctx.loopControlSnapshot)` 里。
    // 视图改由 `executeLoop` 每轮边界用本地已有量构造并通过必填参数传入，因此
    // limits（墙钟/工具数）/ budget_hard / no_progress / risk 四类判据在生产路径**必然被评估**。
    let stopDecision: StopDecision | undefined;
    {
      const rules = getActiveStopRuleSet();
      const snapshot: LoopRuntimeSnapshot = {
        iteration: ctx.currentIteration,
        // `loopState.startedAt` 仅在 `startLoop()` 时被置为真实时刻（`createLoopState` 给 0）。
        // P0-1 让墙钟判据第一次真正可达后，必须防止"未 start 就判"把它算成
        // `Date.now() - 0` = 数十年 → 一进循环就被墙钟判据截断。未 start 时以当前时刻兜底
        // （等价于"此刻才起算"，elapsed=0，不会误触发）。
        startedAt: loopState.startedAt > 0 ? loopState.startedAt : Date.now(),
        toolCallCount: control.toolCallCount,
        consecutiveErrors: control.consecutiveErrors,
        budgetUsed: {
          tokens: ctx.totalTokensConsumed + tokensConsumed,
          usd: 0,
        },
        recentMetrics: control.recentMetrics,
        // FE-070：子监管异常信号进入风险快照（此前 riskSignals 恒空——配置的 riskTriggers 永不可能触发）
        riskSignals: [
          ...control.riskSignals,
          ...(postSupResult.ok ? postSupResult.value.anomalies : []),
        ],
        verifierPassed: control.verifierPassed,
      };
      recordControlTrigger("stopRules_evaluated");
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
            metric: "custom",
            stagnationWindow: 5,
            minDelta: 0.01,
            action: "switch_strategy",
          },
          riskTriggers: [],
        };
        stopDecision = evaluateStopRules(fallbackRules, {} as any, snapshot);
      }

      if (stopDecision.shouldStop) {
        // StopRules 判定**优先于** ⑩ decideIteration 的结果——两链并存时以 StopRules 为退出类别事实源。
        //
        // P0-1 修复的关键一环：修复前这里是
        //   `if (shouldStop && !decision.shouldContinue) { /* 两者一致，无需处理 */ }`
        // 于是当 ⑩ 已判 `success`（模型给出最终答复）而 StopRules 判 `limits`/`risk`/`budget_hard` 时，
        // 真实截断原因被**静默丢弃**，退出类别仍写 `success` —— 这正是审查点名的"伪 success"
        // （"被上限截断"被记成"任务圆满完成"），也是 Docs/Agent/13 §3 登记的"同一循环挂两套优先级"。
        decision.shouldContinue = false;
        decision.exitReason = mapStoppedReasonToExitReason(stopDecision.reason);
        decision.exitMessage = stopDecision.detail;
      }

      // FE-071：no-progress 退出时附加替代策略建议（Skills/strategies 候选集消费；
      // 候选耗尽 → 自动升级人工。策略轮换“继续执行”属 Loop 控制流后续改造，当前仅进退出详情/审计）
      if (stopDecision.shouldStop && stopDecision.reason === "no_progress") {
        try {
          const candidates = getStrategyCandidates().map((c) => c.strategy);
          if (candidates.length > 0) {
            const pick = selectNextStrategy(loopState.loopId, candidates);
            stopDecision = {
              shouldStop: true,
              reason: stopDecision.reason,
              detail: `${stopDecision.detail}；建议替代策略: ${pick.strategy}${pick.escalated ? "（候选耗尽→需人工介入）" : ""}`,
            };
          }
        } catch {
          /* fail-soft：策略建议不影响退出判定 */
        }
      }
    }

    // 步骤顺序校验
    if (!assertStepOrder(steps)) {
      logger.warn("十步序列顺序异常", { source: "runIteration", steps });
    }

    // ── afterAgent 钩子（S0 修复 2026-10-15）─────────────────────
    // 修复背景：本函数此前只派发 5 个钩子（beforeAgent / beforeModel /
    // wrapModelCall / wrapToolCall / afterModel），**从不派发 `afterAgent`**。
    // 而 `Src/Services/LoopControl/middleware/checkpointWriter.ts` 与
    // `stopRuleEvaluator.ts` 都声明 `hook: 'afterAgent'` ⇒ 两者是**死代码**
    // （挂载点从未被触发）。这也是"挂起态无处落盘"的根因之一。
    // 位置：⑩ IterationDecision + StopRules 评估之后 = "Agent 一轮执行结束"，
    // 与中间件自身声明的挂载语义一致。
    await executePrePostHooks("afterAgent", mwCtx, {
      decision,
      stopDecision,
      iteration: loopState.iteration.current,
      exitReason: decision.exitReason,
      tokensConsumed,
    });

    return ok({
      outputText,
      toolCalls,
      toolResults,
      tokensConsumed,
      decision,
      stopDecision,
      steps,
      events,
      shortCircuited,
      shortCircuitReason,
    });
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    logger.error("迭代执行异常", { source: "runIteration", error: errorMsg });
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
/**
 * P1-8：暂停通道（人工监督的三档分辨率之"暂停—观察—恢复"）。
 *
 * 修复背景：`loopEngine` 的 `pauseLoop`/`resumeLoop` 只改 `state.phase`，而
 * `runIteration`/`executeLoop` **全程从不读 `loopState.phase`**，`LoopConfig.pauseSignal`
 * 也零消费者——监督级干预只剩**不可逆的 abort** 一档。
 *
 * @returns `resumed` 已恢复；`aborted` 等待期间被中止（abort 或 pauseSignal）；
 *          `timeout` 超过 `maxWaitMs` 仍未恢复（避免无限挂起）。
 */
export async function waitWhilePaused(
  loopState: LoopState,
  signal: AbortSignal | undefined,
  pollMs = 200,
  maxWaitMs = 300_000,
): Promise<"resumed" | "aborted" | "timeout"> {
  const deadline = Date.now() + maxWaitMs;
  while (loopState.phase === "paused") {
    if (signal?.aborted) return "aborted";
    if (loopState.config.pauseSignal?.signal.aborted) return "aborted";
    if (Date.now() >= deadline) return "timeout";
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }
  return "resumed";
}

export async function executeLoop(
  loopState: LoopState,
  initialCtx: Omit<
    IterationContext,
    "currentIteration" | "totalTokensConsumed"
  >,
): Promise<Result<LoopExecutionResult>> {
  const { startLoop, terminateLoop, failLoop } =
    await import("./loopEngine.js");

  const startResult = startLoop(loopState);
  if (!startResult.ok) return startResult;

  // 注册 toolSafetyGate 中间件（**回路作用域**：ownerId = loopId，P0-2）
  //
  // 修复前：`registerMiddleware(safetyGate)` 的 Result 被丢弃（重名失败无留痕），
  // 收尾处又 `unregisterMiddleware('ToolSafetyGate')` **按名**删除全局唯一实例——
  // 并发下 A 的收尾会摘掉 B 的安全门，B 随即失去 FORBIDDEN 硬拒 / 审批门 / EffectJournal 管控。
  // 现在：按句柄注销 + 按 ownerId 隔离；注册失败一律 fail-closed 拒绝起 Loop。
  const safetyGate = createToolSafetyGateMiddleware(
    () => loopState.loopId,
    () => loopState.iteration.current,
    () => loopState.traceId,
  );
  const gateHandle = registerMiddleware(safetyGate, loopState.loopId);
  if (!gateHandle.ok) {
    // fail-closed：安全执行器装不上就不跑 Loop（与 toolSafetyGate 自身记录的
    // "INTENT 写失败即拒执行" 同取向；安全层不得以两种相反方向失效）
    failLoop(loopState, `安全门注册失败（fail-closed）：${gateHandle.error}`);
    logger.error("安全门注册失败，拒绝启动 Loop（fail-closed）", {
      source: "runIteration/executeLoop",
      loopId: loopState.loopId,
      error: gateHandle.error,
    });
    return err(
      `ToolSafetyGate registration failed (fail-closed): ${gateHandle.error}`,
    );
  }

  try {
    const allIterations: IterationResult[] = [];
    const allEvents: LoopEvent[] = [];
    /**
     * P0-3：Token 账本**唯一累计器** = `loopState.iteration.totalTokensConsumed`
     * （由 ⑩ `decideIteration` 每轮累加）。此处不再维护第二个独立累加器。
     */
    const ledgerTokens = (): number => loopState.iteration.totalTokensConsumed;
    /** 仅用于**收尾一致性自检**的本地求和（不作为任何判定的输入） */
    let localTokenSum = 0;
    let totalToolCalls = 0;
    /**
     * 跨轮维护的"连续工具错误数"。
     *
     * 为什么在这里维护：修复前 `stopRules` 的 `maxConsecutiveErrors` 判定读的是调用方
     * 透传的 `loopControlSnapshot`，而两个生产调用点都不传该字段 → 该判定在生产路径上
     * 从未生效，于是"连续 3 次失败才停"退化为"第一次不可恢复错误即停"。
     * P0-1 修复后视图改由本函数每轮构造，这里继续作为它的输入。
     */
    let consecutiveErrors = 0;
    const t0 = Date.now();
    /**
     * 进展积分（P0-1 / P1-5）。
     *
     * `recentMetrics` 是**累积**进展量而非每轮增量——`stopRules.checkNoProgress` 比较窗口首尾
     * 的相对增量 `(last-first)/|first|`。度量口径 = 累计"**新的**工具调用签名"数：
     * 空转重放同一调用 → 计数不增长 → 平台期 → `no_progress` 命中。
     * 明确禁止再拿"本轮有无输出"当进展代理（审查 P1-5 原文：那是恒真的伪指标）。
     */
    const seenToolSignatures = new Set<string>();
    const recentMetrics: number[] = [];
    let progressScore = 0;
    /**
     * 跨轮累积的风险信号（P1-5）——**直接使用 LoopState 上的数组**，
     * 这样它同时被 StopRules 视图与 GoalReanchorControl 等控制器看到（P2-11 的共享控制面）。
     */
    const riskSignals: string[] = loopState.riskSignals;
    /** 频率限制窗口：由本函数逐轮 push 真实调用时刻（P1-6：修复前两个生产点都传字面量 `[]`） */
    const callTimestamps: number[] = [];
    /** 连续同指纹轮数阈值（对齐 Configs/loopConfig.json fingerprint.consecutiveDuplicateRounds 默认 3） */
    const CONSECUTIVE_DUPLICATE_ROUNDS = 3;

    // ── P2-11 / P1-7：用 userInput 填充不可变区目标 ──
    // 引擎侧 LoopState 此前没有 goal 字段，重锚器与失败反馈因此"没有可依赖的状态对象"。
    // 目标一经写入不再自动改写（ADR-0005 不可变区）。
    if (!loopState.goal.originalRequirement) {
      loopState.goal.originalRequirement = initialCtx.userInput;
    }

    logger.info("主循环启动", {
      source: "runIteration/executeLoop",
      loopId: loopState.loopId,
      maxIterations: loopState.iteration.max,
      tokenBudget: loopState.iteration.tokenBudget,
    });

    for (let iter = 1; iter <= loopState.iteration.max; iter++) {
      // 检查 abort
      if (initialCtx.signal?.aborted) {
        terminateLoop(loopState, "User aborted");
        break;
      }

      // ── P1-8：人工监督通道（暂停 / 恢复）──
      // 修复前 `loopState.phase` 在本函数与 runIteration 中**零读取**，唯一干预是不可逆 abort。
      if (loopState.phase === "paused") {
        recordControlTrigger("pause_observed");
        logger.info("Loop 处于暂停态，等待恢复", {
          source: "runIteration/executeLoop",
          loopId: loopState.loopId,
          iteration: iter,
        });
        const pauseOutcome = await waitWhilePaused(
          loopState,
          initialCtx.signal,
        );
        if (pauseOutcome !== "resumed") {
          // 暂停等待期间被中止或超时：按合法中断收尾（ADR-0001 的暂停语义）
          terminateLoop(loopState, `paused-${pauseOutcome}`);
          logger.warn("Loop 在暂停等待中被中止/超时", {
            source: "runIteration/executeLoop",
            loopId: loopState.loopId,
            outcome: pauseOutcome,
          });
          break;
        }
      }
      // `LoopConfig.pauseSignal` 此前零消费者：其 abort 视为外部暂停请求 → 合法中断
      if (loopState.config.pauseSignal?.signal.aborted) {
        recordControlTrigger("pause_observed");
        terminateLoop(loopState, "pause signal aborted");
        break;
      }

      const iterCtx: IterationContext = {
        ...initialCtx,
        currentIteration: iter,
        // P0-3：从唯一账本读（本轮开始前的累计值）
        totalTokensConsumed: ledgerTokens(),
        // 本轮开始前的连续错误数（本轮判定用的就是"本轮失败后"的累计值，见 runPostSupervision）
        consecutiveErrorCount: consecutiveErrors,
        // P1-6：覆盖调用方传进来的字面量 `[]`——频率限制窗口由本循环逐轮维护
        recentCallTimestamps: callTimestamps,
      };

      // P0-1：视图每轮由本地已有量构造并**必填**传入（不再是"调用方可选、可以忘传"的透传字段）
      const controlView = createLoopControlView({
        toolCallCount: totalToolCalls,
        consecutiveErrors,
        recentMetrics: [...recentMetrics],
        riskSignals: [...riskSignals],
      });

      const result = await runIteration(loopState, iterCtx, controlView);

      if (!result.ok) {
        failLoop(loopState, result.error);
        return err(result.error);
      }

      const iterResult = result.value;
      allIterations.push(iterResult);
      allEvents.push(...iterResult.events);
      // P0-3：账本由 ⑩ decideIteration 累加；此处只记本地求和供收尾自检
      localTokenSum += iterResult.tokensConsumed;
      totalToolCalls += iterResult.toolCalls.length;

      // 跨轮累计连续错误数（与 runPostSupervision 内部同一算法，保证判定一致）：
      // 本轮无错误 → 归零（模型已自我纠正）；有错误 → 累加本轮错误条数。
      consecutiveErrors = accumulateConsecutiveErrors(
        consecutiveErrors,
        iterResult.toolResults,
      );

      // 进展积分（P1-5）：只把"此前从未出现过"的工具调用签名计入累积进展。
      // 与 `loopState` 无关的本地状态即可——它只服务本 Loop 的 `no_progress` 判据。
      for (const tc of iterResult.toolCalls) {
        const sig = computeFingerprint(tc.name, tc.arguments);
        if (!seenToolSignatures.has(sig)) {
          seenToolSignatures.add(sig);
          progressScore += 1;
        }
      }
      recentMetrics.push(progressScore);

      // ── P1-6：真实调用时刻入窗（供 preSupervision 的频率限制判定）──
      // 修复前两个生产调用点都传字面量 `[]` 且全仓无任何 push 写方，
      // 于是 `RATE_LIMIT_EXCEEDED` 分支不可达——"调用速率"这一维完全没有闭环。
      const nowTs = Date.now();
      callTimestamps.push(nowTs);
      const rateWindowStart = nowTs - 60_000;
      while (
        callTimestamps.length > 0 &&
        (callTimestamps[0] ?? 0) < rateWindowStart
      )
        callTimestamps.shift();

      // ── P1-5：连续同指纹 → repetitive_output ──
      // 指纹历史现在挂在 LoopState 上（跨轮持久），振荡检测第一次真正可能命中。
      const fpHistory = loopState.fingerprintHistory;
      if (
        detectRepetitiveFingerprint(fpHistory, CONSECUTIVE_DUPLICATE_ROUNDS)
      ) {
        recordControlTrigger("fingerprint_hit");
        if (!riskSignals.includes("repetitive_output")) {
          riskSignals.push("repetitive_output");
          logger.warn(
            "检测到连续相同输出指纹，注入 repetitive_output 风险信号",
            {
              source: "runIteration/executeLoop",
              loopId: loopState.loopId,
              rounds: CONSECUTIVE_DUPLICATE_ROUNDS,
              fingerprint: fpHistory[fpHistory.length - 1],
            },
          );
        }
      }

      // 更新对话历史（追加助手输出 + 工具结果，供下一轮使用）
      //  REV-341：助手消息必须带上它本轮发起的 tool_calls，工具结果必须带 tool_call_id——
      //  缺任一侧，下一轮请求里的 `role:'tool'` 就无人认领，供应商按非法消息拒绝**整个请求体**
      //  （实测 `Invalid messages at index 2/3`），于是从第二轮起模型再也调不动工具。
      const assistantToolCalls = iterResult.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
      if (iterResult.outputText || assistantToolCalls.length > 0) {
        initialCtx.chatMessages.push({
          role: "assistant",
          content: iterResult.outputText,
          ...(assistantToolCalls.length > 0
            ? { tool_calls: assistantToolCalls }
            : {}),
        });
      }
      for (const tr of iterResult.toolResults) {
        // 正文回落链（REV-341）：失败结果只有 error 没有 content（旧写法 JSON.stringify(undefined)
        // 产出 undefined），实测未知工具的 content 是空串——两种情况都必须给出可辨认的占位，
        // 否则模型下一轮读到空白，等于把失败抹成"没有信息"。
        const raw =
          typeof tr.content === "string"
            ? tr.content
            : tr.content === undefined
              ? ""
              : JSON.stringify(tr.content);
        const content =
          raw !== ""
            ? raw
            : tr.error
              ? `${tr.error.code}: ${tr.error.message}`
              : tr.status === "error"
                ? "(工具失败，未返回错误信息)"
                : "(工具无输出)";
        initialCtx.chatMessages.push({
          role: "tool",
          content,
          tool_call_id: tr.tool_call_id,
        });
      }

      // 本轮**即时**上报（修复：此前所有轮次的完成事件都堆到 executeLoop 返回后才批量发布，
      // 使前端的工具块/轮次统计延迟到运行结束才出现）
      initialCtx.onIterationComplete?.({
        iteration: allIterations.length,
        totalIterations: allIterations.length, // 运行中未知总数，先给当前值（后续轮次会自然增大）
        outputText: iterResult.outputText,
        toolCalls: iterResult.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
        toolResults: iterResult.toolResults.map((tr) => ({
          tool_call_id: tr.tool_call_id,
          status: tr.status,
          ...(tr.content !== undefined
            ? {
                content:
                  typeof tr.content === "string"
                    ? tr.content
                    : JSON.stringify(tr.content),
              }
            : {}),
          ...(tr.error ? { error: tr.error } : {}),
        })),
        tokensConsumed: iterResult.tokensConsumed,
        decision: iterResult.decision?.exitReason ?? "unknown",
      });

      // ★ 迭代边界写快照（2026-10-04 新增，修复"运行期无 checkpoint"）
      //   此前 `checkpointStore.createCheckpoint` 无任何运行期调用方 → 崩溃恢复链路形同虚设
      //   （`recoveryScanner.loadLatestCheckpoint` 永远读不到东西）。这里在每轮末尾原子写入。
      writeIterationCheckpoint({
        loopId: loopState.loopId,
        iteration: allIterations.length,
        decision: iterResult.decision?.exitReason ?? "unknown",
        completedSteps: allIterations.length,
        failedAttempts: allIterations.filter(
          (it) => it.decision?.exitReason === "risk",
        ).length,
        toolNames: iterResult.toolCalls.map((tc) => tc.name),
        pendingEffects: (() => {
          const unknown = getUnknownEffects(loopState.loopId);
          return unknown.ok
            ? unknown.value.map((e) => ({ effectId: e.effectId }))
            : [];
        })(),
        nextStepHint: iterResult.decision?.shouldContinue
          ? `继续第 ${allIterations.length + 1} 轮`
          : "任务已结束，无需续跑",
      });

      if (!iterResult.decision.shouldContinue) {
        terminateLoop(
          loopState,
          iterResult.decision.exitMessage ?? "Loop ended",
        );
        break;
      }
    }

    const finalIteration = allIterations[allIterations.length - 1];

    // ── P0-3 收尾自检：账本与本地求和必须为 0 差异 ──
    // 四源账本（executeLoop 本地累加 / loopState.iteration.totalTokensConsumed /
    // postSupervision 输入 / mwCtx.data）归一后，此处是唯一的对账点。
    // 不一致说明又出现了新的独立累加器——立即留痕，避免偏差静默扩散到退出判定。
    const ledgerTotal = ledgerTokens();
    if (ledgerTotal !== localTokenSum) {
      recordControlTrigger("ledger_mismatch");
      logger.error("Token 账本不一致（P0-3 收尾自检失败）", {
        source: "runIteration/executeLoop",
        loopId: loopState.loopId,
        ledgerTotal,
        localTokenSum,
        diff: ledgerTotal - localTokenSum,
      });
    }

    logger.info("主循环结束", {
      source: "runIteration/executeLoop",
      loopId: loopState.loopId,
      iterations: allIterations.length,
      totalTokens: ledgerTotal,
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
      totalTokensConsumed: ledgerTokens(),
      totalToolCalls,
      exitReason: finalIteration?.decision.exitReason,
      exitMessage: finalIteration?.decision.exitMessage,
      totalMs: Date.now() - t0,
      allEvents,
    });
  } finally {
    // P0-2：**按句柄**注销——只摘掉本 Loop 注册的那一个实例。
    // 修复前按名删除全局唯一实例，并发下会把仍在运行的另一个 Loop 的安全门一起摘掉。
    // 若该实例已被异常路径移除（`false`），只记告警不抛错（收尾路径不得再抛）。
    const removed = unregisterMiddleware(gateHandle.value);
    if (!removed) {
      logger.warn("安全门句柄已不在注册表中（可能被显式清理）", {
        source: "runIteration/executeLoop",
        loopId: loopState.loopId,
        middlewareId: gateHandle.value.id,
      });
    }
  }
}
