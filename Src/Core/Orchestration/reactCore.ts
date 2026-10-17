/**
 * @module Core/Orchestration/reactCore
 * @description
 * E1 · `ReActCore` —— 把 P1 `ReActLoop`（十步循环原语）**包成执行件**。
 *
 * 设计出处：Docs/Dev/L1编排设计/12-ReAct类设计.md §16.4（修正后的类骨架）·
 *   15-ReActLoop原语.md §2（R1–R6）· 13 §16（状态与控制由外部输入）· 19-OuterLoop.md（宿主调用 Executable）
 *
 * 它**只**做四件事（§5 内部执行细节），并且**一件都不多**：
 *   ① 观察：直接采用外部组装好的 `observation`，**不自行扩大可见面**
 *   ② 推理：经外部授予的工具集调用模型（工具集**只能收紧**，放宽即拒）
 *   ③ 执行：一次 `step` = **一个**十步迭代（要不要再来一轮不归它，13 §16.4）
 *   ④ 上报：`produced/events/needsDecision/usage` 如实回流，**自己不改状态**
 *
 * 三条归属纪律（各有负向测试）：
 *   - **不派生 `loopId`**（R3）：scope 由上层（NodeRunner / 外层）派生后注入，本件只校验形状。
 *   - **不重复计量**（R5）：计量由原语上报一次；本件只在 `ReactOutput.usage` 里**转报**同一份。
 *   - **不自行判定达成**：`goal.satisfied` / `goal.unmet` **不在**本件产生的待决事项里
 *     （达成判定归 P2 原语 + E4 约束件；状态转移归 C1 控制器）。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import type { ChatMessage } from "../Model/modelCaller.js";
import {
  assertScopeShape,
  createReActLoop,
  type LoopScope,
  type ReActLoop,
} from "../Loop/reactLoop.js";
import { createLoopState, type LoopState } from "../Loop/loopEngine.js";
import type { LoopConfig } from "../Loop/loopConfig.js";
import {
  createLoopControlView,
  type IterationContext,
  type LoopControlView,
} from "../Loop/runIteration.js";
import type { Observation } from "../Context/contextAssembler.js";
import type { ContextStore } from "../../Services/Context/contextStore.js";

import type {
  Executable,
  ExecutableContract,
  NeedsDecision,
  ReactInput,
  ReactOutput,
} from "./outerLoop.js";

/** 执行件级依赖（全部外部注入；缺能力显式失败，不静默降级） */
export interface ReactCoreDeps {
  readonly id: string;
  readonly contract: ExecutableContract;
  /** 作用域由**上层派生**后注入（R3） */
  readonly scope: LoopScope;
  readonly config: LoopConfig;
  /** 会话与工作目录（沿用现有十步循环的上下文口径；缺省按纯内存运行） */
  readonly sessionId?: string;
  readonly agentRole?: string;
  readonly workDir?: string;
  /** 追加式上下文集合：注入则观察到的分区按稳定键原位写入（不破坏前缀） */
  readonly contextStore?: ContextStore;
  /** 原语实例（注入仅用于确定性测试；缺省用真实 `runIteration`） */
  readonly loop?: ReActLoop;
  /** 任务文本来源：默认取最后一个 `task` 分区，其次最后一条 user 历史 */
  readonly taskOf?: (obs: Observation) => string;
}

export interface ReactCore extends Executable {
  readonly scope: LoopScope;
  readonly loop: ReActLoop;
  /** 释放（R6）：原语一并释放，注册过的 disposables 由原语负责 */
  dispose(): void;
  /** 跨轮控制面视图（只读快照，供监管与测试取证） */
  controlView(): LoopControlView;
  step(input: ReactInput): Promise<Result<ReactOutput>>;
}

/** 观察 → 任务文本：优先 `task` 分区，其次最后一条 user 消息 */
function defaultTaskOf(obs: Observation): string {
  const task = [...obs.contextSections]
    .reverse()
    .find((s) => s.key.includes("task"));
  if (task && task.content.trim().length > 0) return task.content;
  const lastUser = [...obs.history].reverse().find((m) => m.role === "user");
  if (lastUser && lastUser.content.trim().length > 0) return lastUser.content;
  return obs.contextSections.map((s) => s.content).join("\n\n");
}

/**
 * 创建 E1 执行件。
 *
 * 构造期即拒绝两类不合法（都有负向测试）：
 *   - `scope` 形状不合法（`loopId` 为空 / 嵌套前缀不由父派生）；
 *   - `grants.tools` 超出声明工具集 —— 外部**授予**只能收紧，不能放宽（12 §0.4 条 1）。
 */
export function createReActCore(deps: ReactCoreDeps): Result<ReactCore> {
  const shape = assertScopeShape(deps.scope);
  if (!shape.ok) return shape;

  // 跨轮控制面（原 `executeLoop` 的职责，现在**每个组件一份**：R1 实例私有）
  let view: LoopControlView = createLoopControlView();
  let tokensConsumed = 0;
  let disposed = false;

  const loopResult: Result<ReActLoop> = deps.loop
    ? ok(deps.loop)
    : createReActLoop(deps.scope);
  if (!loopResult.ok) return loopResult;
  const loop = loopResult.value;
  // 注入的 loop 若与声明 id 不同源，仍以**声明的 scope**为准（R3：本件不再派生）
  if (loop.scope.loopId !== deps.scope.loopId) {
    return err(
      "注入的 ReActLoop 作用域与本件声明不一致：" +
        loop.scope.loopId +
        " ≠ " +
        deps.scope.loopId,
    );
  }

  const state: LoopState = createLoopState({
    loopId: deps.scope.loopId,
    agentId: deps.scope.agentId,
    traceId: deps.scope.traceId,
    config: deps.config,
  });

  function buildIterationContext(input: ReactInput): IterationContext {
    const obs = input.observation;
    const chatMessages: ChatMessage[] = obs.history.map((m) => ({
      role: m.role as ChatMessage["role"],
      content: m.content,
    }));
    // 观察到的分区：有追加式上下文集合就按稳定键写入（原位替换，不破坏前缀）；
    // 没有就并置到任务文本之后 —— 可见面仍**严格等于**外部给定的 observation。
    const task = deps.taskOf ? deps.taskOf(obs) : defaultTaskOf(obs);
    return {
      userInput: task,
      sessionId: deps.sessionId ?? deps.scope.agentId,
      agentId: deps.scope.agentId,
      agentRole: deps.agentRole ?? "worker",
      config: deps.config,
      currentIteration: input.control.cycle + 1,
      totalTokensConsumed: tokensConsumed,
      chatMessages,
      recentCallTimestamps: [],
      // ★ 收紧：本轮可执行的工具 = **外部授予** ∩ **声明工具集**
      grantedToolNames: [
        ...new Set(
          input.grants.tools.filter((t) => deps.contract.toolSet.includes(t)),
        ),
      ],
      ...(deps.workDir !== undefined ? { workDir: deps.workDir } : {}),
      ...(deps.contextStore !== undefined
        ? { contextStore: deps.contextStore }
        : {}),
    };
  }

  /** 迭代结果 → 待决事项（**只报事实**；达成判定与状态转移都不在本件） */
  function toNeedsDecision(reason?: string): NeedsDecision[] {
    if (!reason) return [];
    if (reason === "budget_exhausted") {
      return [{ event: "budget.exhausted", payload: { reason } }];
    }
    return [{ event: "iteration.exited", payload: { reason } }];
  }

  return ok({
    id: deps.id,
    contract: deps.contract,
    scope: deps.scope,
    loop,

    controlView: () => view,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      loop.dispose();
    },

    async step(input: ReactInput): Promise<Result<ReactOutput>> {
      if (disposed) {
        return err("ReActCore(" + deps.id + ") 已释放，拒绝执行 step");
      }
      // ★ 控制由外部决定（13 §16.4）：外部说不继续，就**一次都不跑**
      if (!input.control.shouldContinue) {
        return ok({
          produced: { notRun: true, reason: "外部控制未放行" },
          events: [],
          needsDecision: [],
          usage: { tokens: 0, iterations: 0 },
        });
      }
      // 预算/截止已耗尽 ⇒ 不跑，把事实**上报**给外层（degrade 由控制器决定）
      if (input.control.budgetRemaining <= 0) {
        return ok({
          produced: { notRun: true, reason: "预算耗尽" },
          events: [],
          needsDecision: [
            {
              event: "budget.exhausted",
              payload: { remaining: input.control.budgetRemaining },
            },
          ],
          usage: { tokens: 0, iterations: 0 },
        });
      }
      // 授予超出声明工具集 ⇒ 拒（工具集只能收紧；放宽说明组装体与本件声明冲突）
      const widened = input.grants.tools.filter(
        (t) => !deps.contract.toolSet.includes(t),
      );
      if (widened.length > 0) {
        return err(
          "授予的工具集超出执行件声明（只能收紧）：" +
            widened.join(", ") +
            " ∉ " +
            deps.id,
        );
      }

      const ctx = buildIterationContext(input);
      const out = await loop.runOnce(state, ctx, view);
      if (!out.ok) return out;
      const r = out.value;

      tokensConsumed += r.tokensConsumed;
      // 控制面按本轮**真实**结果滚动（与原 executeLoop 的跨轮维护等价，只是每个组件一份）
      const errored = r.toolResults.filter((t) => t.status === "error").length;
      const postSignals: string[] = [];
      for (const e of r.events) {
        if (e.step !== "⑨ PostSupervision") continue;
        const s = e.data["riskSignals"];
        if (Array.isArray(s)) postSignals.push(...(s as string[]));
      }
      view = createLoopControlView({
        toolCallCount: view.toolCallCount + r.toolCalls.length,
        consecutiveErrors: errored === 0 ? 0 : view.consecutiveErrors + errored,
        recentMetrics: [...view.recentMetrics, r.tokensConsumed].slice(-8),
        riskSignals: [...new Set([...view.riskSignals, ...postSignals])],
        verifierPassed: view.verifierPassed,
      });
      const atEnd = r.decision.shouldContinue === false;
      return ok({
        produced: {
          outputText: r.outputText,
          toolCalls: r.toolCalls,
          toolResults: r.toolResults,
          ...(r.decision.exitReason
            ? { exitReason: r.decision.exitReason }
            : {}),
          // 节点收口信号：**一次迭代判为终止**才置位（Workflow 据此 settle 节点）
          node_done: atEnd,
          shortCircuited: r.shortCircuited,
          ...(r.shortCircuitReason
            ? { shortCircuitReason: r.shortCircuitReason }
            : {}),
        },
        // R4：事件带原语自身 scope（原语已附）；此处原样转报，不补外层标签
        events: [...r.events],
        needsDecision: atEnd ? toNeedsDecision(r.decision.exitReason) : [],
        // R5：计量**转报**同一份，不重复累计（累计归外层）
        usage: { tokens: r.tokensConsumed, iterations: 1 },
      });
    },
  });
}
