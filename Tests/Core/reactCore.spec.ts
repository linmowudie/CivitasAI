/**
 * E1 · `ReActCore` —— 把 P1 原语包成执行件（四条归属纪律 + 三条控制纪律）
 *
 * 设计出处：Docs/Dev/L1编排设计/12-ReAct类设计.md §16.4 · 15-ReActLoop原语.md §2（R1–R6）
 * 纪律（25 §1）：负向用例必须真实调用 —— 本件真实调用 `createReActCore` / `step` / 真实原语，
 * 只把**模型层**换成确定性桩（与 `reactLoop.spec.ts` 同一口径）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ callModel: vi.fn() }));
vi.mock("../../Src/Core/Model/modelCaller.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../Src/Core/Model/modelCaller.js")
    >();
  return { ...actual, callModel: h.callModel };
});

import {
  createReActCore,
  type ReactCoreDeps,
} from "../../Src/Core/Orchestration/reactCore.js";
import {
  createReActLoop,
  type LoopScope,
} from "../../Src/Core/Loop/reactLoop.js";
import { createLoopConfig } from "../../Src/Core/Loop/loopConfig.js";
import { createLoopState } from "../../Src/Core/Loop/loopEngine.js";
import {
  resetSystemPromptCache,
  type IterationResult,
} from "../../Src/Core/Loop/runIteration.js";
import { clearMiddlewares } from "../../Src/Core/Middleware/middlewareRegistry.js";
import { buildToolHeader } from "../../Src/Tools/Registry/toolHeader.js";
import { registerBuiltinTools } from "../../Src/Tools/builtinLoader.js";
import type { Observation } from "../../Src/Core/Context/contextAssembler.js";
import type { ReactInput } from "../../Src/Core/Orchestration/outerLoop.js";
import { ok, type Result } from "../../Src/Infra/types.js";

const TASK = { sections: ["task"], history: { recentTurns: 4 } as const };

function mkObs(over: Partial<Observation> = {}): Observation {
  return {
    contextSections: [{ key: "ctx:task", content: "把编排层跑通" }],
    history: [{ role: "user", content: "把编排层跑通" }],
    upstream: {},
    events: [],
    ...over,
  };
}

function mkInput(over: Partial<ReactInput> = {}): ReactInput {
  return {
    state: "running",
    control: { shouldContinue: true, budgetRemaining: 1000, cycle: 0 },
    observation: mkObs(),
    grants: { tools: ["FileRead"], plugins: [], visible: TASK },
    ...over,
  };
}

function iteration(over: Partial<IterationResult> = {}): IterationResult {
  return {
    outputText: "done",
    toolCalls: [],
    toolResults: [],
    tokensConsumed: 25,
    decision: { shouldContinue: true },
    steps: [],
    events: [],
    shortCircuited: false,
    ...over,
  };
}

/** 用**注入的确定性迭代**建一件（模型层桩，其余真实） */
function coreWith(
  id: string,
  scope: LoopScope,
  toolSet: readonly string[],
  next: (over?: Partial<IterationResult>) => IterationResult,
): ReturnType<typeof makeCore> {
  const cfg = createLoopConfig({ model: "test-model", stream: false });
  if (!cfg.ok) throw new Error("config");
  const seen: Array<{
    granted?: readonly string[];
    currentIteration: number;
    tokens: number;
  }> = [];
  const loop = createReActLoop(scope, {
    runIteration: async (_s, ctx) => {
      seen.push({
        granted: ctx.grantedToolNames,
        currentIteration: ctx.currentIteration,
        tokens: ctx.totalTokensConsumed,
      });
      return ok(next());
    },
  });
  if (!loop.ok) throw new Error("loop");
  return makeCore(
    {
      id,
      scope,
      config: cfg.value,
      contract: { inputSet: TASK, outputSet: ["outer"], toolSet },
      loop: loop.value,
    },
    seen,
  );
}

function makeCore(
  deps: ReactCoreDeps,
  seen: Array<{
    granted?: readonly string[];
    currentIteration: number;
    tokens: number;
  }>,
) {
  const r = createReActCore(deps);
  if (!r.ok) throw new Error("ReActCore 应可创建: " + r.error);
  return { core: r.value, seen };
}

describe("E1 · 构造期（R3 作用域 / 声明一致性）", () => {
  it("【负向】scope.loopId 为空 ⇒ 拒绝创建", () => {
    const cfg = createLoopConfig({ model: "m", stream: false });
    if (!cfg.ok) throw new Error("config");
    const r = createReActCore({
      id: "rc",
      scope: { loopId: "  ", agentId: "a", traceId: "t" },
      config: cfg.value,
      contract: { inputSet: TASK, outputSet: ["outer"], toolSet: [] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("loopId");
  });

  it("【负向】注入的原语作用域与本件声明不一致 ⇒ 拒绝（杜绝两处派生，R3）", () => {
    const cfg = createLoopConfig({ model: "m", stream: false });
    if (!cfg.ok) throw new Error("config");
    const loop = createReActLoop({
      loopId: "L/OTHER",
      agentId: "a",
      traceId: "t",
    });
    if (!loop.ok) throw new Error("loop");
    const r = createReActCore({
      id: "rc",
      scope: { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      config: cfg.value,
      contract: { inputSet: TASK, outputSet: ["outer"], toolSet: [] },
      loop: loop.value,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("作用域与本件声明不一致");
  });
});

describe("E1 · step 的控制纪律（控制由外部决定，13 §16.4）", () => {
  it("【负向】外部未放行 ⇒ 一次迭代都**不跑**", async () => {
    const { core, seen } = coreWith(
      "rc",
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      ["FileRead"],
      () => iteration(),
    );
    const res = await core.step(
      mkInput({
        control: { shouldContinue: false, budgetRemaining: 1000, cycle: 0 },
      }),
    );
    if (!res.ok) throw new Error("步进应成功: " + res.error);
    expect(seen.length).toBe(0);
    expect(res.value.produced["notRun"]).toBe(true);
    expect(res.value.usage.tokens).toBe(0);
  });

  it("【负向】预算耗尽 ⇒ 不跑，并把 `budget.exhausted` 作为**待决事项**上报", async () => {
    const { core, seen } = coreWith(
      "rc",
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      ["FileRead"],
      () => iteration(),
    );
    const res = await core.step(
      mkInput({
        control: { shouldContinue: true, budgetRemaining: 0, cycle: 0 },
      }),
    );
    if (!res.ok) throw new Error("步进应成功: " + res.error);
    expect(seen.length).toBe(0);
    expect(res.value.needsDecision.map((n) => n.event)).toContain(
      "budget.exhausted",
    );
  });

  it("【负向】授予工具超出声明 ⇒ 拒绝（工具集只能收紧，不能放宽）", async () => {
    const { core, seen } = coreWith(
      "rc",
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      ["FileRead"],
      () => iteration(),
    );
    const res = await core.step(
      mkInput({ grants: { tools: ["ShellExec"], plugins: [], visible: TASK } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("只能收紧");
    expect(seen.length).toBe(0);
  });

  it("【负向】已释放的执行件再 step ⇒ 拒绝（R6）", async () => {
    const { core } = coreWith(
      "rc",
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      ["FileRead"],
      () => iteration(),
    );
    core.dispose();
    const res = await core.step(mkInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("已释放");
  });
});

describe("E1 · 观察与授予的传递（不扩大可见面）", () => {
  it("grants.tools ∩ contract.toolSet 才进入迭代（交集，不是并集）", async () => {
    const { core, seen } = coreWith(
      "rc",
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      ["FileRead", "ToolSearch"],
      () => iteration(),
    );
    const res = await core.step(
      mkInput({
        grants: {
          tools: ["FileRead", "ShellExec"],
          plugins: [],
          visible: TASK,
        },
      }),
    );
    // 超出的 ShellExec 在**步前进**就被拒（放宽即拒），所以这里改用合法收紧再验一次
    expect(res.ok).toBe(false);

    const tightened = await core.step(
      mkInput({ grants: { tools: ["FileRead"], plugins: [], visible: TASK } }),
    );
    if (!tightened.ok) throw new Error("收紧应被允许: " + tightened.error);
    expect(seen[0]!.granted).toEqual(["FileRead"]);
  });

  it("外部给的 cycle / 已累计 tokens 进入迭代上下文（组件不自造进度）", async () => {
    const { core, seen } = coreWith(
      "rc",
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      ["FileRead"],
      () => iteration({ tokensConsumed: 40 }),
    );
    await core.step(
      mkInput({
        control: { shouldContinue: true, budgetRemaining: 1000, cycle: 3 },
      }),
    );
    await core.step(
      mkInput({
        control: { shouldContinue: true, budgetRemaining: 1000, cycle: 4 },
      }),
    );
    expect(seen[0]!.currentIteration).toBe(4);
    expect(seen[0]!.tokens).toBe(0);
    expect(seen[1]!.currentIteration).toBe(5);
    expect(seen[1]!.tokens).toBe(40); // 上一轮真实用量累计，不是重新估
  });

  it("任务文本来自外部组装好的观察（不自行拉取）", async () => {
    const cfg = createLoopConfig({ model: "m", stream: false });
    if (!cfg.ok) throw new Error("config");
    let captured = "";
    const loop = createReActLoop(
      { loopId: "L", agentId: "a", traceId: "t" },
      {
        runIteration: async (_s, ctx) => {
          captured = ctx.userInput;
          return ok(iteration());
        },
      },
    );
    if (!loop.ok) throw new Error("loop");
    const r = createReActCore({
      id: "rc",
      scope: { loopId: "L", agentId: "a", traceId: "t" },
      config: cfg.value,
      contract: { inputSet: TASK, outputSet: ["outer"], toolSet: [] },
      loop: loop.value,
    });
    if (!r.ok) throw new Error(r.error);
    await r.value.step(
      mkInput({
        grants: { tools: [], plugins: [], visible: TASK },
        observation: mkObs({
          contextSections: [{ key: "ctx:task", content: "只许读，不许写" }],
        }),
      }),
    );
    expect(captured).toBe("只许读，不许写");
  });
});

describe("E1 · 上报（R4/R5 + 不自行判定达成）", () => {
  it("一次 step = 一个迭代：usage.iterations 恒为 1（节奏归外层）", async () => {
    const { core } = coreWith(
      "rc",
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      ["FileRead"],
      () => iteration({ tokensConsumed: 12 }),
    );
    const res = await core.step(mkInput());
    if (!res.ok) throw new Error("步进应成功: " + res.error);
    expect(res.value.usage).toEqual({ tokens: 12, iterations: 1 });
  });

  it("迭代判为终止 ⇒ `node_done=true` + `iteration.exited`（收口信号只是事实上报）", async () => {
    const { core } = coreWith(
      "rc",
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      ["FileRead"],
      () =>
        iteration({
          decision: { shouldContinue: false, exitReason: "success" },
        }),
    );
    const res = await core.step(mkInput());
    if (!res.ok) throw new Error("步进应成功: " + res.error);
    expect(res.value.produced["node_done"]).toBe(true);
    expect(res.value.produced["exitReason"]).toBe("success");
    const events = res.value.needsDecision.map((n) => n.event);
    expect(events).toContain("iteration.exited");
  });

  it("【负向】本件**绝不**自行产生 `goal.satisfied` / `goal.unmet`（判定归 P2+E4，状态归 C1）", async () => {
    const { core } = coreWith(
      "rc",
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      ["FileRead"],
      () =>
        iteration({
          decision: { shouldContinue: false, exitReason: "success" },
        }),
    );
    for (const cycle of [0, 1, 2]) {
      const res = await core.step(
        mkInput({
          control: { shouldContinue: true, budgetRemaining: 100, cycle },
        }),
      );
      if (!res.ok) throw new Error("步进应成功: " + res.error);
      const events = res.value.needsDecision.map((n) => n.event);
      expect(events).not.toContain("goal.satisfied");
      expect(events).not.toContain("goal.unmet");
    }
  });

  it("退出类别为预算耗尽 ⇒ 上报 `budget.exhausted` 而不是 iteration.exited", async () => {
    const { core } = coreWith(
      "rc",
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      ["FileRead"],
      () =>
        iteration({
          decision: { shouldContinue: false, exitReason: "budget_exhausted" },
        }),
    );
    const res = await core.step(mkInput());
    if (!res.ok) throw new Error("步进应成功: " + res.error);
    expect(res.value.needsDecision.map((n) => n.event)).toEqual([
      "budget.exhausted",
    ]);
  });

  it("控制面跨轮滚动：工具错误数在连续失败时累计、成功即归零", async () => {
    let n = 0;
    const { core } = coreWith(
      "rc",
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      ["FileRead"],
      () => {
        n += 1;
        return iteration({
          toolCalls: [{ id: "c" + n, name: "FileRead", arguments: {} }],
          toolResults: n === 2 ? [] : ([{ status: "error" }] as never),
        });
      },
    );
    await core.step(mkInput());
    expect(core.controlView().consecutiveErrors).toBe(1);
    expect(core.controlView().toolCallCount).toBe(1);
    await core.step(
      mkInput({
        control: { shouldContinue: true, budgetRemaining: 100, cycle: 1 },
      }),
    );
    expect(core.controlView().consecutiveErrors).toBe(0);
    expect(core.controlView().toolCallCount).toBe(2);
  });

  it("跨轮控制面**真正传给** ⑩（不是每次全零视图，P0-1 的失效模式）", async () => {
    const cfg = createLoopConfig({ model: "m", stream: false });
    if (!cfg.ok) throw new Error("config");
    const seenControls: Array<number> = [];
    let n = 0;
    const loop = createReActLoop(
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      {
        runIteration: async (_s, _c, control) => {
          n += 1;
          seenControls.push(control?.toolCallCount ?? -1);
          return ok(
            iteration({
              toolCalls: Array.from({ length: n }, (_x, i) => ({
                id: "c" + i,
                name: "FileRead",
                arguments: {},
              })),
            }),
          );
        },
      },
    );
    if (!loop.ok) throw new Error("loop");
    const r = createReActCore({
      id: "rc",
      scope: { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      config: cfg.value,
      contract: { inputSet: TASK, outputSet: ["outer"], toolSet: ["FileRead"] },
      loop: loop.value,
    });
    if (!r.ok) throw new Error(r.error);

    await r.value.step(mkInput());
    await r.value.step(
      mkInput({
        control: { shouldContinue: true, budgetRemaining: 100, cycle: 1 },
      }),
    );
    // 第一轮见到的是**进轮前**的累计（0），第二轮必须看到第一轮的真实工具数（1）
    expect(seenControls).toEqual([0, 1]);
  });

  it("两个实例互不串状态（R1/R6：控制面与累计量各自一份）", async () => {
    const scopeA: LoopScope = {
      loopId: "L/A",
      parentLoopId: "L",
      agentId: "a",
      traceId: "t",
    };
    const scopeB: LoopScope = {
      loopId: "L/B",
      parentLoopId: "L",
      agentId: "a",
      traceId: "t",
    };
    const a = coreWith("rc-a", scopeA, ["FileRead"], () =>
      iteration({ tokensConsumed: 10 }),
    );
    const b = coreWith("rc-b", scopeB, ["FileRead"], () =>
      iteration({ tokensConsumed: 7 }),
    );
    await a.core.step(mkInput());
    await a.core.step(mkInput());
    await b.core.step(mkInput());
    expect(a.seen.length).toBe(2);
    expect(b.seen.length).toBe(1);
    // A 的累计不进入 B
    const resB = await b.core.step(
      mkInput({
        control: { shouldContinue: true, budgetRemaining: 100, cycle: 1 },
      }),
    );
    if (!resB.ok) throw new Error("步进应成功: " + resB.error);
    expect(b.seen[1]!.tokens).toBe(7);
    expect(a.core.loop.metrics().tokens).toBe(20);
    expect(b.core.loop.metrics().tokens).toBe(14);
  });
});

describe("E1 · 真实十步集成（**授予边界在真实执行路径上生效**）", () => {
  /** 用**有热工具可见**的角色，否则目录为空、本组用例失去意义 */
  const ROLE = "prime_director";

  beforeEach(() => {
    clearMiddlewares();
    resetSystemPromptCache();
    h.callModel.mockReset();
    registerBuiltinTools();
  });

  function realCore(scope: LoopScope, toolSet: readonly string[]) {
    const cfg = createLoopConfig({ model: "test-model", stream: false });
    if (!cfg.ok) throw new Error("config");
    // 不注入 loop ⇒ 内部用**真实** `runIteration`
    const r = createReActCore({
      id: "rc-real",
      scope,
      config: cfg.value,
      contract: { inputSet: TASK, outputSet: ["outer"], toolSet },
      agentRole: ROLE,
    });
    if (!r.ok) throw new Error("ReActCore: " + r.error);
    return r.value;
  }

  it("【负向】模型调用**未授予**的工具 ⇒ 不进入派发器，结果是拒执而不是执行", async () => {
    const header = buildToolHeader(ROLE as never);
    expect(header.length).toBeGreaterThan(1); // 目录为空/过小则本用例失去意义，必须响
    const granted = header[0]!.name;
    const ungranted = header[1]!.name;

    h.callModel.mockResolvedValue({
      ok: true,
      value: {
        content: "我要写文件",
        finish_reason: "tool_calls",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: "test-model",
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: ungranted, arguments: "{}" },
          },
        ],
      },
    });

    const core = realCore(
      { loopId: "Lreal", agentId: "a1", traceId: "t-real" },
      [granted],
    );
    const res = await core.step(
      mkInput({ grants: { tools: [granted], plugins: [], visible: TASK } }),
    );
    if (!res.ok) throw new Error("步进应成功: " + res.error);
    const results = res.value.produced["toolResults"] as Array<{
      status: string;
      content?: unknown;
    }>;
    expect(results.length).toBe(1);
    expect(results[0]!.status).toBe("error");
    expect(String(results[0]!.content)).toContain("工具未授予");
  });

  it("工具目录按授予**取交集**（提示里不得出现未授予的工具）", async () => {
    const header = buildToolHeader(ROLE as never);
    expect(header.length).toBeGreaterThan(1);
    const granted = header[0]!.name;

    h.callModel.mockResolvedValue({
      ok: true,
      value: {
        content: "done",
        finish_reason: "stop",
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      },
    });

    const core = realCore({ loopId: "Ldir", agentId: "a1", traceId: "t-dir" }, [
      granted,
    ]);
    const res = await core.step(
      mkInput({ grants: { tools: [granted], plugins: [], visible: TASK } }),
    );
    if (!res.ok) throw new Error("步进应成功: " + res.error);

    const options = h.callModel.mock.calls.at(-1)?.[2] as
      { tools?: Array<{ function?: { name?: string } }> } | undefined;
    const names = (options?.tools ?? []).map((t) => t.function?.name ?? "");
    expect(names).toEqual([granted]); // 只给交集，且只有一个
  });

  it("未提供授予清单的原语调用**行为不变**（两个生产调用点不受影响）", async () => {
    const header = buildToolHeader(ROLE as never);
    expect(header.length).toBeGreaterThan(1);
    h.callModel.mockResolvedValue({
      ok: true,
      value: {
        content: "done",
        finish_reason: "stop",
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      },
    });
    // 直接驱动原语（不经 E1）：ctx 不带 grantedToolNames ⇒ 目录保持角色全量
    const cfg = createLoopConfig({ model: "test-model", stream: false });
    if (!cfg.ok) throw new Error("config");
    const loop = createReActLoop({
      loopId: "Lraw",
      agentId: "a1",
      traceId: "t-raw",
    });
    if (!loop.ok) throw new Error("loop");
    const state = createLoopState({
      loopId: "Lraw",
      agentId: "a1",
      traceId: "t-raw",
      config: cfg.value,
    });
    const out = await loop.value.runOnce(state, {
      userInput: "hi",
      sessionId: "s",
      agentId: "a1",
      agentRole: ROLE,
      config: cfg.value,
      currentIteration: 1,
      totalTokensConsumed: 0,
      chatMessages: [{ role: "user", content: "hi" }],
      recentCallTimestamps: [],
    });
    if (!out.ok) throw new Error("十步应成功: " + out.error);
    const options = h.callModel.mock.calls.at(-1)?.[2] as
      { tools?: Array<{ function?: { name?: string } }> } | undefined;
    const names = (options?.tools ?? [])
      .map((t) => t.function?.name ?? "")
      .sort();
    expect(names).toEqual(header.map((s) => s.name).sort());
  });
});
