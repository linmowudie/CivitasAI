/**
 * ① · ReActLoop 可实例化测试（六条契约 R1–R6 + 真实十步集成）
 *
 * 设计出处：15-ReActLoop原语.md §2（R1–R6）· 26-S1模块级可变状态盘点.md（盘点结论）
 * 纪律（25 §1）：负向用例必须真实调用；最后一条用**真实** `runIteration`（只 mock 模型层）。
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
  createReActLoop,
  assertScopeShape,
  type LoopScope,
} from "../../Src/Core/Loop/reactLoop.js";
import { createLoopState } from "../../Src/Core/Loop/loopEngine.js";
import { createLoopConfig } from "../../Src/Core/Loop/loopConfig.js";
import {
  resetSystemPromptCache,
  type IterationContext,
  type IterationResult,
} from "../../Src/Core/Loop/runIteration.js";
import { clearMiddlewares } from "../../Src/Core/Middleware/middlewareRegistry.js";
import { ok, err } from "../../Src/Infra/types.js";
import type { ChatMessage } from "../../Src/Core/Model/modelCaller.js";

function mkState(loopId: string) {
  const cfg = createLoopConfig({ model: "test-model", stream: false });
  if (!cfg.ok) throw new Error("config");
  return createLoopState({
    loopId,
    agentId: "a1",
    traceId: "t-" + loopId,
    config: cfg.value,
  });
}

function mkCtx(
  msgs: ChatMessage[] = [],
): Omit<IterationContext, "currentIteration" | "totalTokensConsumed"> {
  const cfg = createLoopConfig({ model: "test-model", stream: false });
  if (!cfg.ok) throw new Error("config");
  return {
    userInput: "hi",
    sessionId: "s1",
    agentId: "a1",
    agentRole: "worker",
    config: cfg.value,
    chatMessages: msgs,
    recentCallTimestamps: [],
  };
}

const fakeResult = (tokens: number): IterationResult =>
  ({
    outputText: "ok",
    toolCalls: [],
    toolResults: [],
    tokensConsumed: tokens,
    decision: { shouldContinue: false, exitReason: "success" },
    steps: [],
    events: [],
    shortCircuited: false,
    shortCircuitReason: undefined,
  }) as unknown as IterationResult;

describe("ReActLoop · R3 作用域形状（派生权在上层，本原语只校验）", () => {
  it("【负向】嵌套 loopId 前缀不合法 ⇒ 拒绝创建", () => {
    const bad: LoopScope = {
      loopId: "C1",
      parentLoopId: "L",
      agentId: "a",
      traceId: "t",
    };
    const r = createReActLoop(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("必须由父派生出前缀");
  });

  it("【负向】空 loopId ⇒ 拒绝创建", () => {
    const r = createReActLoop({ loopId: "  ", agentId: "a", traceId: "t" });
    expect(r.ok).toBe(false);
  });

  it("合法：根循环无父；子循环前缀正确", () => {
    expect(
      assertScopeShape({ loopId: "L", agentId: "a", traceId: "t" }).ok,
    ).toBe(true);
    expect(
      assertScopeShape({
        loopId: "L/C1",
        parentLoopId: "L",
        agentId: "a",
        traceId: "t",
      }).ok,
    ).toBe(true);
    expect(
      assertScopeShape({
        loopId: "L/C1/C2",
        parentLoopId: "L/C1",
        agentId: "a",
        traceId: "t",
      }).ok,
    ).toBe(true);
  });
});

describe("ReActLoop · R1/R5/R6 实例隔离与计量", () => {
  it("【负向】两个实例的计量互不混淆（无模块级共享状态）", async () => {
    const a = createReActLoop(
      { loopId: "L1", agentId: "a", traceId: "t" },
      {
        runIteration: async () => ok(fakeResult(10)),
      },
    );
    const b = createReActLoop(
      { loopId: "L2", agentId: "a", traceId: "t" },
      {
        runIteration: async () => ok(fakeResult(7)),
      },
    );
    if (!a.ok || !b.ok) return;
    await a.value.runOnce(mkState("L1"), mkCtx() as never);
    await a.value.runOnce(mkState("L1"), mkCtx() as never);
    await b.value.runOnce(mkState("L2"), mkCtx() as never);

    expect(a.value.metrics().iterations).toBe(2);
    expect(a.value.metrics().tokens).toBe(20);
    expect(b.value.metrics().iterations).toBe(1);
    expect(b.value.metrics().tokens).toBe(7);
  });

  it("并发两个实例：各自的计量与 scope 不串味（R6）", async () => {
    const seen: Array<{ loopId: string; tokens: number }> = [];
    const mk = (loopId: string, tok: number) =>
      createReActLoop(
        { loopId, agentId: "a", traceId: "t" },
        {
          runIteration: async () => {
            await new Promise((r) => setTimeout(r, 1));
            return ok(fakeResult(tok));
          },
          meter: (id, u) => seen.push({ loopId: id, tokens: u.tokens }),
        },
      );
    const a = mk("Lc1", 3);
    const b = mk("Lc2", 5);
    if (!a.ok || !b.ok) return;
    await Promise.all([
      a.value.runOnce(mkState("Lc1"), mkCtx() as never),
      b.value.runOnce(mkState("Lc2"), mkCtx() as never),
    ]);
    expect(a.value.metrics().tokens).toBe(3);
    expect(b.value.metrics().tokens).toBe(5);
    expect(seen.map((s) => s.loopId).sort()).toEqual(["Lc1", "Lc2"]);
  });

  it("计量只上报本实例用量（汇总由外部做，不重复计）", async () => {
    const calls: number[] = [];
    const a = createReActLoop(
      { loopId: "Lm", agentId: "a", traceId: "t" },
      {
        runIteration: async () => ok(fakeResult(4)),
        meter: (_id, u) => calls.push(u.tokens),
      },
    );
    if (!a.ok) return;
    await a.value.runOnce(mkState("Lm"), mkCtx() as never);
    await a.value.runOnce(mkState("Lm"), mkCtx() as never);
    expect(calls).toEqual([4, 4]);
    expect(a.value.metrics().tokens).toBe(8);
  });

  it("R4：事件一律带自身 scope（杜绝跨层串味）", async () => {
    const events: Array<{ loopId: string; parent?: string }> = [];
    const a = createReActLoop(
      { loopId: "Lp/Cx", parentLoopId: "Lp", agentId: "a", traceId: "t" },
      {
        runIteration: async () => ok(fakeResult(1)),
        emit: (e) =>
          events.push({ loopId: e.loopId, parent: e.scope.parentLoopId }),
      },
    );
    if (!a.ok) return;
    await a.value.runOnce(mkState("Lp/Cx"), mkCtx() as never);
    expect(events.length).toBe(1);
    expect(events[0]!.loopId).toBe("Lp/Cx");
    expect(events[0]!.parent).toBe("Lp");
  });

  it("失败的一轮不计量 token（但仍计一次迭代）", async () => {
    const a = createReActLoop(
      { loopId: "Lf", agentId: "a", traceId: "t" },
      {
        runIteration: async () => err("boom"),
      },
    );
    if (!a.ok) return;
    const out = await a.value.runOnce(mkState("Lf"), mkCtx() as never);
    expect(out.ok).toBe(false);
    expect(a.value.metrics().iterations).toBe(1);
    expect(a.value.metrics().tokens).toBe(0);
  });
});

describe("ReActLoop · dispose", () => {
  it("【负向】dispose 后再 runOnce ⇒ 拒绝", async () => {
    const a = createReActLoop(
      { loopId: "Ld", agentId: "a", traceId: "t" },
      {
        runIteration: async () => ok(fakeResult(1)),
      },
    );
    if (!a.ok) return;
    a.value.dispose();
    const out = await a.value.runOnce(mkState("Ld"), mkCtx() as never);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("已释放");
    expect(a.value.metrics().disposed).toBe(true);
  });

  it("释放回调 LIFO 执行；幂等；可取消注册", () => {
    const order: string[] = [];
    const a = createReActLoop({ loopId: "Lr", agentId: "a", traceId: "t" });
    if (!a.ok) return;
    a.value.registerDisposable(() => order.push("first"));
    const cancel = a.value.registerDisposable(() => order.push("cancelled"));
    a.value.registerDisposable(() => order.push("second"));
    cancel();
    a.value.dispose();
    a.value.dispose(); // 幂等
    expect(order).toEqual(["second", "first"]);
  });

  it("某个释放回调抛错不阻断其余释放", () => {
    const ran: string[] = [];
    const a = createReActLoop({ loopId: "Le", agentId: "a", traceId: "t" });
    if (!a.ok) return;
    a.value.registerDisposable(() => ran.push("outer"));
    a.value.registerDisposable(() => {
      throw new Error("释放失败");
    });
    a.value.registerDisposable(() => ran.push("inner"));
    expect(() => a.value.dispose()).not.toThrow();
    expect(ran).toEqual(["inner", "outer"]);
  });

  it("dispose 后注册释放回调无效（不泄漏）", () => {
    const a = createReActLoop({ loopId: "Ln", agentId: "a", traceId: "t" });
    if (!a.ok) return;
    a.value.dispose();
    let ran = false;
    a.value.registerDisposable(() => {
      ran = true;
    });
    a.value.dispose();
    expect(ran).toBe(false);
  });
});

describe("ReActLoop · R2 可嵌套", () => {
  it("内层循环在外层 runOnce 的调用栈内运行，两层 scope 各自正确", async () => {
    const innerEvents: string[] = [];
    const outerEvents: string[] = [];

    const inner = createReActLoop(
      { loopId: "L/C1", parentLoopId: "L", agentId: "a", traceId: "t" },
      {
        runIteration: async () => ok(fakeResult(2)),
        emit: (e) => innerEvents.push(e.loopId),
      },
    );
    if (!inner.ok) return;

    const outer = createReActLoop(
      { loopId: "L", agentId: "a", traceId: "t" },
      {
        emit: (e) => outerEvents.push(e.loopId),
        runIteration: async () => {
          // 外层一轮之内驱动内层
          const r = await inner.value.runOnce(
            mkState("L/C1"),
            mkCtx() as never,
          );
          expect(r.ok).toBe(true);
          return ok(fakeResult(5));
        },
      },
    );
    if (!outer.ok) return;

    await outer.value.runOnce(mkState("L"), mkCtx() as never);

    expect(outerEvents).toEqual(["L"]);
    expect(innerEvents).toEqual(["L/C1"]);
    expect(outer.value.metrics().tokens).toBe(5);
    expect(inner.value.metrics().tokens).toBe(2); // 内层不被计入外层
  });
});

describe("ReActLoop · 真实十步集成（默认真实 runIteration）", () => {
  beforeEach(() => {
    clearMiddlewares();
    resetSystemPromptCache();
    h.callModel.mockReset();
  });

  it("runOnce 驱动**真实**十步循环并返回真实 IterationResult", async () => {
    h.callModel.mockResolvedValue({
      ok: true,
      value: {
        content: "done",
        finish_reason: "stop",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: "test-model",
      },
    });
    // 不注入 runIteration ⇒ 走真实实现
    const loop = createReActLoop({
      loopId: "Lreal",
      agentId: "a1",
      traceId: "t-real",
    });
    expect(loop.ok).toBe(true);
    if (!loop.ok) return;

    const out = await loop.value.runOnce(
      mkState("Lreal"),
      mkCtx([{ role: "user", content: "hi" }]) as never,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 真实十步：steps 里应出现已知步骤，且决策被算出
    expect(out.value.steps.length).toBeGreaterThan(0);
    expect(out.value.steps).toContain("① InputReceived");
    expect(out.value.steps).toContain("⑩ IterationDecision");
    expect(out.value.decision).toBeDefined();
    expect(loop.value.metrics().iterations).toBe(1);
  });
});
