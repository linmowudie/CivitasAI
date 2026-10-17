/**
 * S3 · LifecycleController 负向测试
 *
 * 纪律（Docs/Dev/L1编排设计/25 §1）：负向用例必须**真实调用** —— 全程走
 * `createLifecycleController(...).onEvent(...)` 的真实路径，不用静态断言。
 * 每条测试对应 16-LifecycleController.md 的一条实现纪律与反例。
 */
import { describe, it, expect } from "vitest";

import {
  createLifecycleController,
  type ComponentCheckpointPort,
  type DecisionPrompt,
} from "../../Src/Core/Lifecycle/lifecycleController.js";
import {
  DEFAULT_LEGALITY,
  type Decision,
  type LifecycleCtx,
  type LegalityTable,
} from "../../Src/Core/Lifecycle/lifecycleTypes.js";

function ctx(over: Partial<LifecycleCtx> = {}): LifecycleCtx {
  return {
    componentId: "comp-1",
    outstanding: [],
    produced: [],
    dependencySatisfied: true,
    budgetRemaining: 1000,
    now: 1,
    ...over,
  };
}

/** 可用的落盘桩件（仅用于"落盘成功"这一侧的测试；失败侧单独注入） */
function okCheckpoint(): ComponentCheckpointPort {
  return { save: async () => ({ ok: true, value: undefined }) };
}

function alwaysReturn(
  d: Decision,
): (p: DecisionPrompt) => Promise<Decision | null> {
  return async () => d;
}

describe("S3 · LifecycleController", () => {
  // ── 纪律 1：合法集只能收紧 ──────────────────────────────
  it("【负向】收紧表越出默认表 ⇒ **拒绝创建**（不是警告）", () => {
    const widening: LegalityTable = () => new Set(["running", "terminate"]);
    const r = createLifecycleController({
      askModel: alwaysReturn({ next: "running" }),
      tightened: widening,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("只能收紧不能放宽");
  });

  it("收紧为真子集 ⇒ 创建成功，且合法集确实被收窄", async () => {
    // 收紧表必须**状态感知**：终态（terminate/abandon）下默认是"吸收"（只能保持自身），
    // 任何覆盖都会构成"放宽"而被校验器拒绝。
    const tightened: LegalityTable = (ev, st, c) => {
      const base = DEFAULT_LEGALITY(ev, st, c);
      if (st === "terminate" || st === "abandon") return base;
      // 探测上下文有子代 ⇒ 默认 {suspend,handoff,abandon}；收紧为真子集 {suspend}
      if (ev === "iteration.exited") return new Set(["suspend"]);
      return base;
    };
    const r = createLifecycleController({
      askModel: alwaysReturn({ next: "running" }),
      tightened,
      checkpoint: okCheckpoint(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 本测试的 ctx 无子代 ⇒ 默认集 = {terminate}；收紧集 = {suspend} ⇒ 交集为空
    expect([...r.value.legalFor("iteration.exited", ctx())]).toEqual([]);
  });

  // ── 纪律 2：机械事件不问 LLM ────────────────────────────
  it("【负向】机械事件 child.spawned 按规则处理，**不调用模型**", async () => {
    const r = createLifecycleController({
      askModel: alwaysReturn({ next: "running" }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = await r.value.onEvent(
      "child.spawned",
      ctx({ outstanding: ["c1"] }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toEqual({ next: "running" });
    expect(r.value.modelCallCount()).toBe(0);
  });

  // ── 纪律 3：只给合法集 + 非法必究 ────────────────────────
  it("【负向】有未收敛子代时，给模型的选项里**不含 terminate**", async () => {
    let seen: string[] = [];
    const r = createLifecycleController({
      askModel: async (p) => {
        seen = p.legal;
        return { next: "suspend", until: "child", refs: ["c1"] };
      },
      checkpoint: okCheckpoint(),
    });
    if (!r.ok) return;
    await r.value.onEvent("iteration.exited", ctx({ outstanding: ["c1"] }));
    expect(seen).not.toContain("terminate");
    expect(seen.sort()).toEqual(["abandon", "handoff", "suspend"]);
  });

  it("【负向】连续非法决策 ⇒ 记违规并**按失败处理**（有子代 → suspend），不静默兜底", async () => {
    const r = createLifecycleController({
      askModel: alwaysReturn({ next: "terminate" }), // 恒非法：有未收敛子代
      checkpoint: okCheckpoint(),
      maxRetry: 2,
    });
    if (!r.ok) return;
    const out = await r.value.onEvent(
      "iteration.exited",
      ctx({ outstanding: ["c1"] }),
    );
    expect(out.ok).toBe(true);
    if (out.ok)
      expect(out.value).toEqual({
        next: "suspend",
        until: "child",
        refs: ["c1"],
      });
    // 首次 + 2 次重决 = 3 次违规
    expect(r.value.violations().length).toBe(3);
    expect(
      r.value.violations().every((v) => v.kind === "illegal_decision"),
    ).toBe(true);
    expect(r.value.modelCallCount()).toBe(3);
  });

  it("【负向】连续非法且**无**子代 ⇒ abandon（不是假装成功）", async () => {
    const r = createLifecycleController({
      askModel: alwaysReturn({ next: "handoff", to: "parent", refs: [] }), // deadline.reached 下非法
      checkpoint: okCheckpoint(),
    });
    if (!r.ok) return;
    const out = await r.value.onEvent("deadline.reached", ctx());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.next).toBe("abandon");
  });

  // ── 决策缓存 ──────────────────────────────────────────
  it("同事件+同上下文第二次走缓存：模型只被调用一次", async () => {
    // 用 `goal.unmet → running`：状态保持 running，故两次指纹相同 ⇒ 第二次命中缓存
    const r = createLifecycleController({
      askModel: alwaysReturn({ next: "running" }),
      checkpoint: okCheckpoint(),
    });
    if (!r.ok) return;
    const c = ctx();
    const first = await r.value.onEvent("goal.unmet", c);
    expect(first.ok).toBe(true);
    const before = r.value.modelCallCount();
    await r.value.onEvent("goal.unmet", c);
    expect(before).toBe(1);
    expect(r.value.modelCallCount()).toBe(1); // 第二次由缓存提供，未再询问模型
    expect(r.value.cacheSize()).toBe(1);
  });

  it("状态变化后指纹不同 ⇒ 缓存不误用旧决策", async () => {
    // 首次 terminate（状态 → terminate），再次询问时状态已变 ⇒ 必须重新询问
    const r = createLifecycleController({
      askModel: alwaysReturn({ next: "terminate" }),
      checkpoint: okCheckpoint(),
    });
    if (!r.ok) return;
    await r.value.onEvent("iteration.exited", ctx());
    await r.value.onEvent("goal.unmet", ctx());
    expect(r.value.modelCallCount()).toBe(2);
  });

  // ── 纪律 4：监管优先但不得越界 ──────────────────────────
  it("【负向】监管指令越出合法集 ⇒ 被拒 + 留痕，且**不产生 terminate**", async () => {
    const r = createLifecycleController({
      askModel: alwaysReturn({ next: "suspend", until: "child", refs: ["c1"] }),
      checkpoint: okCheckpoint(),
      supervision: () => ({ next: "terminate" }), // 越界
    });
    if (!r.ok) return;
    const out = await r.value.onEvent(
      "iteration.exited",
      ctx({ outstanding: ["c1"] }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.next).toBe("suspend");
    expect(r.value.getState()).not.toBe("terminate");
    expect(
      r.value
        .violations()
        .some((v) => v.kind === "supervision_out_of_legal_set"),
    ).toBe(true);
  });

  it("监管指令在合法集内 ⇒ 直接采纳且**不问模型**", async () => {
    const r = createLifecycleController({
      askModel: alwaysReturn({ next: "abandon", reason: "should-not-be-used" }),
      checkpoint: okCheckpoint(),
      supervision: () => ({ next: "degrade", reason: "监管降级", gaps: [] }),
    });
    if (!r.ok) return;
    const out = await r.value.onEvent("dependency.blocked", ctx());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.next).toBe("degrade");
    expect(r.value.modelCallCount()).toBe(0);
  });

  // ── 纪律 5：落盘 ──────────────────────────────────────
  it("【负向】suspend 落盘失败 ⇒ 返回错误（**不允许假装已挂起**）", async () => {
    const failing: ComponentCheckpointPort = {
      save: async () => ({ ok: false, error: "磁盘满" }),
    };
    const r = createLifecycleController({
      askModel: alwaysReturn({ next: "suspend", until: "child", refs: ["c1"] }),
      checkpoint: failing,
    });
    if (!r.ok) return;
    const out = await r.value.onEvent(
      "iteration.exited",
      ctx({ outstanding: ["c1"] }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("落盘失败");
    // 状态不得被推进为 suspend
    expect(r.value.getState()).toBe("running");
  });

  it("【负向】未注入落盘端口时 suspend 直接失败（挂而不存 = 重启即丢）", async () => {
    const r = createLifecycleController({
      askModel: alwaysReturn({ next: "suspend", until: "child", refs: ["c1"] }),
    });
    if (!r.ok) return;
    const out = await r.value.onEvent(
      "iteration.exited",
      ctx({ outstanding: ["c1"] }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("未注入 checkpoint");
  });

  // ── 终态吸收 ─────────────────────────────────────────
  it("【负向】进入 terminate 后**终态吸收**：合法集只剩 terminate，不得被拉回 running", async () => {
    const r = createLifecycleController({
      askModel: alwaysReturn({ next: "terminate" }),
      checkpoint: okCheckpoint(),
    });
    if (!r.ok) return;
    const first = await r.value.onEvent("iteration.exited", ctx());
    expect(first.ok).toBe(true);
    expect(r.value.getState()).toBe("terminate");
    const legal = r.value.legalFor("goal.unmet", ctx());
    expect([...legal]).toEqual(["terminate"]);
    const second = await r.value.onEvent("goal.unmet", ctx());
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.next).toBe("terminate");
    expect(r.value.getState()).toBe("terminate");
  });

  // ── 硬边界：无 success ────────────────────────────────
  it("【负向】任何事件×状态下，默认合法集都**不含 success**（成功只由外层推导）", () => {
    const probe = ctx({ outstanding: ["c1"] });
    const seen = new Set<string>();
    for (const ev of [
      "component.entered",
      "iteration.exited",
      "child.spawned",
      "child.settled",
      "dependency.blocked",
      "budget.exhausted",
      "deadline.reached",
      "goal.satisfied",
      "goal.unmet",
    ] as const) {
      for (const st of ["running", "suspend", "handoff", "degrade"] as const) {
        for (const s of DEFAULT_LEGALITY(ev, st, probe)) seen.add(s);
        for (const s of DEFAULT_LEGALITY(ev, st, ctx())) seen.add(s);
      }
    }
    expect([...seen]).not.toContain("success");
    expect([...seen].sort()).toEqual([
      "abandon",
      "degrade",
      "handoff",
      "running",
      "suspend",
      "terminate",
    ]);
  });
});
