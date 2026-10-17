/**
 * P3 · `NodeRunner` —— loopId **唯一派生点** · grants **只能收紧** · 事件与计量带**自身 scope**
 *
 * 设计出处：Docs/Dev/L1编排设计/23-原语补齐与监管快照.md §P3（定位四件事 + 反例 1–5）·
 *   15-ReActLoop原语.md R3/R4/R5/R6 · 24-归属复核-第二批.md 问题 2
 *
 * 纪律（25 §1）：负向用例必须**真实调用**本件与真实原语/执行件，只把**模型层迭代**换成确定性桩。
 */
import { describe, it, expect, vi } from "vitest";

import {
  createNodeRunner,
  deriveScope,
  narrowGrants,
  type Grants,
} from "../../Src/Core/Orchestration/nodeRunner.js";
import {
  createReActLoop,
  type LoopScope,
} from "../../Src/Core/Loop/reactLoop.js";
import { createReActCore } from "../../Src/Core/Orchestration/reactCore.js";
import { createLoopConfig } from "../../Src/Core/Loop/loopConfig.js";
import {
  createWorkflow,
  type WorkflowNodeSpec,
} from "../../Src/Core/Patterns/patterns.js";
import { ok, err, type Result } from "../../Src/Infra/types.js";
import type {
  Executable,
  ExecutableContract,
  ReactInput,
  ReactOutput,
} from "../../Src/Core/Orchestration/outerLoop.js";
import type { Observation } from "../../Src/Core/Context/contextAssembler.js";

const ROOT: LoopScope = { loopId: "L", agentId: "a1", traceId: "t1" };
/** 节点声明只需要 task 分区、4 轮历史 */
const TASK = { sections: ["task"], history: { recentTurns: 4 } as const };
/** 父授予的可见面：两个分区、2 轮历史 */
const PARENT_VISIBLE = {
  sections: ["task", "role"],
  history: { recentTurns: 2 } as const,
};
const PARENT_TOOLS = ["FileRead", "FileWrite", "ShellExec"];

function mkObs(over: Partial<Observation> = {}): Observation {
  return {
    contextSections: [
      { key: "role", content: "你是执行件" },
      { key: "task", content: "把编排层跑通" },
    ],
    history: [
      { role: "user", content: "h1" },
      { role: "assistant", content: "h2" },
      { role: "user", content: "h3" },
      { role: "assistant", content: "h4" },
      { role: "user", content: "h5" },
    ],
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
    grants: { tools: PARENT_TOOLS, plugins: [], visible: PARENT_VISIBLE },
    ...over,
  };
}

function contractOf(
  over: Partial<ExecutableContract> = {},
): ExecutableContract {
  return {
    inputSet: TASK,
    outputSet: ["outer"],
    toolSet: ["FileWrite"],
    ...over,
  };
}

/** 记录收到的节点输入，并原样返回给定输出的**真实执行件** */
function spyBody(
  ret: Result<ReactOutput> = ok({
    produced: { node_done: true },
    events: [],
    needsDecision: [],
    usage: { tokens: 7, iterations: 1 },
  }),
  scope?: LoopScope,
): { exe: Executable; seen: ReactInput[] } {
  const seen: ReactInput[] = [];
  const exe: Executable = {
    id: "body",
    contract: contractOf(),
    ...(scope ? { scope } : {}),
    async step(inp: ReactInput): Promise<Result<ReactOutput>> {
      seen.push(inp);
      return ret;
    },
  } as Executable;
  return { exe, seen };
}

const runner = createNodeRunner();

// ─────────────────────────────────────────────────────────────
describe("P3 · deriveScope（唯一派生点）", () => {
  it("父 `L` + 节点 `N1` ⇒ `L/N1`，父链与 agent/trace 一并继承", () => {
    const r = deriveScope(ROOT, "N1");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("应可派生: " + r.error);
    expect(r.value).toEqual({
      loopId: "L/N1",
      parentLoopId: "L",
      agentId: "a1",
      traceId: "t1",
    });
  });

  it("可递归：`L/N1` 再派生 ⇒ `L/N1/N2`（前缀始终成立）", () => {
    const one = deriveScope(ROOT, "N1");
    if (!one.ok) throw new Error("应可派生: " + one.error);
    const two = deriveScope(one.value, "N2");
    expect(two.ok).toBe(true);
    if (!two.ok) throw new Error("应可派生: " + two.error);
    expect(two.value.loopId).toBe("L/N1/N2");
    expect(two.value.parentLoopId).toBe("L/N1");
  });

  it("同一输入两次派生**深相等**（派生值不随时间变化）", () => {
    expect(deriveScope(ROOT, "N1")).toEqual(deriveScope(ROOT, "N1"));
  });

  it.each(["", "  ", "a/b", "a b", "a\tb"])(
    "【反例 2 面】节点 id=%j ⇒ 拒绝派生",
    (id) => {
      expect(deriveScope(ROOT, id).ok).toBe(false);
    },
  );

  it("【负向】父 scope 自身畸形 ⇒ 拒绝派生（空 loopId / 前缀不符）", () => {
    expect(
      deriveScope({ loopId: "", agentId: "a", traceId: "t" }, "N1").ok,
    ).toBe(false);
    expect(
      deriveScope(
        { loopId: "X/N1", parentLoopId: "L", agentId: "a", traceId: "t" },
        "N2",
      ).ok,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
describe("P3 · narrowGrants（反例 3：只能收紧）", () => {
  const parent: Grants = {
    tools: PARENT_TOOLS,
    plugins: ["p1"],
    visible: PARENT_VISIBLE,
  };

  it("节点声明超出父授予 ⇒ 生效集为**交集**，未授予项不得出现", () => {
    const g = narrowGrants(
      parent,
      contractOf({ toolSet: ["FileWrite", "net.fetch"] }),
    );
    expect(g.tools).toEqual(["FileWrite"]);
    expect(g.tools).not.toContain("net.fetch");
  });

  it("未声明 plugins ⇒ 沿用父集（不变宽）；声明了则取交集", () => {
    expect(narrowGrants(parent, contractOf()).plugins).toEqual(["p1"]);
    expect(
      narrowGrants(parent, contractOf({ plugins: ["p1", "p9"] })).plugins,
    ).toEqual(["p1"]);
  });

  it("可见面：分区取交集，历史轮数取较小值；all∩all 才是 all", () => {
    const g = narrowGrants(
      parent,
      contractOf({ inputSet: { sections: ["task", "goal"], history: "all" } }),
    );
    expect(g.visible.sections).toEqual(["task"]);
    expect(g.visible.history).toEqual({ recentTurns: 2 });

    const all = narrowGrants(
      { ...parent, visible: { sections: ["task"], history: "all" } },
      contractOf({ inputSet: { sections: ["task"], history: "all" } }),
    );
    expect(all.visible.history).toBe("all");
  });

  it("【负向】结构上不可能变宽：任意声明下生效集 ⊆ 父授予", () => {
    for (const toolSet of [
      ["FileRead"],
      ["ShellExec", "FileWrite"],
      [],
      ["net.fetch"],
    ]) {
      const g = narrowGrants(parent, contractOf({ toolSet }));
      for (const t of g.tools) expect(parent.tools).toContain(t);
      for (const s of g.visible.sections)
        expect(parent.visible.sections).toContain(s);
    }
  });
});

// ─────────────────────────────────────────────────────────────
describe("P3 · runNode 五条反例", () => {
  it("【反例 1】body 不是执行件（无 contract）⇒ 拒绝，且未执行任何逻辑", async () => {
    const calls: number[] = [];
    const inline = {
      id: "inline",
      step: async () => {
        calls.push(1);
        return ok({} as ReactOutput);
      },
    } as never;
    const r = await createNodeRunner().runNode(
      { id: "N1", body: inline },
      ROOT,
      mkInput(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不是执行件");
    expect(calls).toEqual([]);
  });

  it("【反例 2】节点体自带第二个 loopId ⇒ 派生冲突，**运行前**拒绝（无副作用）", async () => {
    const { exe, seen } = spyBody(undefined, {
      loopId: "L/X",
      agentId: "a1",
      traceId: "t1",
    });
    const r = await createNodeRunner().runNode(
      { id: "N1", body: exe },
      ROOT,
      mkInput(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("唯一派生点");
    expect(seen).toEqual([]); // 一次都没派发
  });

  it("【反例 3】节点体收到的 grants 是收紧后的交集，观察也**真实裁剪**", async () => {
    const { exe, seen } = spyBody();
    const r = await createNodeRunner().runNode(
      { id: "N1", body: exe },
      ROOT,
      mkInput(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("应可运行: " + r.error);
    expect(seen[0]!.grants.tools).toEqual(["FileWrite"]);
    expect(r.value.grants.tools).toEqual(["FileWrite"]);
    // 可见面只留 task ⇒ role 分区不得进入观察；历史裁到 2 轮
    expect(seen[0]!.observation.contextSections.map((s) => s.key)).toEqual([
      "task",
    ]);
    expect(seen[0]!.observation.history).toHaveLength(2);
    expect(seen[0]!.observation.history.at(-1)!.content).toBe("h5");
  });

  it("【反例 4】状态与控制由外部给出：注入 C1 切片则采用，父输入不被改写", async () => {
    const { exe, seen } = spyBody();
    const input = mkInput();
    const r = await createNodeRunner({
      stateOf: () => "suspend",
      controlOf: (_id, p) => ({ ...p.control, cycle: p.control.cycle + 100 }),
    }).runNode({ id: "N1", body: exe }, ROOT, input);
    expect(r.ok).toBe(true);
    expect(seen[0]!.state).toBe("suspend");
    expect(seen[0]!.control.cycle).toBe(100);
    // 父输入未被反灌（节点不自决状态）
    expect(input.state).toBe("running");
    expect(input.control.cycle).toBe(0);
  });

  it("【反例 4】未注入 stateOf ⇒ 原样转发父状态；needsDecision 原样上浮不吞", async () => {
    const { exe, seen } = spyBody(
      ok({
        produced: {},
        events: [{ type: "x" }],
        needsDecision: [
          { event: "dependency.blocked", payload: { node: "N1" } },
        ],
        usage: { tokens: 1, iterations: 1 },
      }),
    );
    const r = await createNodeRunner().runNode(
      { id: "N1", body: exe },
      ROOT,
      mkInput(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seen[0]!.state).toBe("running"); // 原样转发，本件未迁状态
    expect(r.value.needsDecision).toEqual([
      { event: "dependency.blocked", payload: { node: "N1" } },
    ]);
  });

  it.each(["ok", "err", "throw"])(
    "【反例 5】body %s 路径下订阅仍被解绑（恰好一次）",
    async (kind) => {
      const unbind = vi.fn();
      const body: Executable = {
        id: "body",
        contract: contractOf(),
        async step(): Promise<Result<ReactOutput>> {
          if (kind === "throw") throw new Error("boom");
          if (kind === "err") return err("节点内失败");
          return ok({
            produced: {},
            events: [],
            needsDecision: [],
            usage: { tokens: 0, iterations: 1 },
          });
        },
      };
      const p = createNodeRunner({ attach: () => unbind }).runNode(
        { id: "N1", body },
        ROOT,
        mkInput(),
      );
      if (kind === "throw") {
        await expect(p).rejects.toThrow("boom");
      } else {
        const out = await p;
        expect(out.ok).toBe(kind === "ok");
      }
      expect(unbind).toHaveBeenCalledTimes(1);
    },
  );

  it("【R4/R5】事件带**节点自身** scope；计量只报本节点用量一次", async () => {
    const events: Array<{
      loopId: string;
      scope: LoopScope;
      payload: unknown;
    }> = [];
    const metered: Array<[string, { tokens: number; iterations: number }]> = [];
    const r = await createNodeRunner({
      emit: (e) => events.push(e),
      meter: (id, u) => metered.push([id, u]),
    }).runNode({ id: "N1", body: spyBody().exe }, ROOT, mkInput());
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.loopId).toBe("L/N1");
    expect(events[0]!.scope.parentLoopId).toBe("L");
    expect(metered).toEqual([["L/N1", { tokens: 7, iterations: 1 }]]); // 不重复计、不计父层
  });

  it("失败路径不臆造计量（没有可信 usage 就不报数）", async () => {
    const metered: string[] = [];
    const r = await createNodeRunner({
      meter: (id) => metered.push(id),
    }).runNode({ id: "N1", body: spyBody(err("失败")).exe }, ROOT, mkInput());
    expect(r.ok).toBe(false);
    expect(metered).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
describe("P3 · E3 Workflow 经节点运行器推进（不再共用父 ReactInput）", () => {
  it("声明自身 scope ⇒ 节点收到派生的 `L/N1`，produced 与事件都带上该 loopId", async () => {
    const { exe, seen } = spyBody();
    const r = createWorkflow({
      nodes: [{ id: "N1", body: exe, predecessors: [], joinMissing: "block" }],
      entry: "N1",
      depth: 0,
      maxDepth: 0,
      scope: ROOT,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("workflow 应可创建: " + r.error);
    const out = await r.value.step(mkInput());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(seen[0]!.grants.tools).toEqual(["FileWrite"]); // 收紧后进入节点
    expect(out.value.produced.nodeLoopId).toBe("L/N1");
    expect(out.value.events.at(-1)).toEqual({
      type: "workflow_node",
      node: "N1",
      loopId: "L/N1",
    });
  });

  it("未声明 scope ⇒ **不臆造** loopId（派生权不在本件），节点体收到父输入原样", async () => {
    const { exe, seen } = spyBody();
    const r = createWorkflow({
      nodes: [{ id: "N1", body: exe, predecessors: [], joinMissing: "block" }],
      entry: "N1",
      depth: 0,
      maxDepth: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("workflow 应可创建: " + r.error);
    const input = mkInput();
    const out = await r.value.step(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.produced.nodeLoopId).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(input); // 未派生 ⇒ 也不越权裁剪
  });

  it("【负向】节点 id 含 `/` ⇒ 构造期拒绝（loopId 由此派生）", () => {
    const r = createWorkflow({
      nodes: [
        {
          id: "a/b",
          body: spyBody().exe,
          predecessors: [],
          joinMissing: "block",
        },
      ],
      entry: "a/b",
      depth: 0,
      maxDepth: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("节点 id");
  });

  it("【真实嵌套】Workflow(L) → NodeRunner → ReActCore(L/N1) → ReActLoop：工具集按声明收紧，计量不翻倍", async () => {
    const nodes: WorkflowNodeSpec[] = [];
    const cfg = createLoopConfig({ model: "test-model", stream: false });
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) throw new Error("config 应可用: " + cfg.error);

    const seenGrants: Array<readonly string[] | undefined> = [];
    const nodeScope: LoopScope = {
      loopId: "L/N1",
      parentLoopId: "L",
      agentId: "a1",
      traceId: "t1",
    };
    // 真实 P1（作用域为派生结果），只把**十步循环里的模型迭代**换成确定性桩
    const loop = createReActLoop(nodeScope, {
      runIteration: async (_s, ctx) => {
        seenGrants.push(ctx.grantedToolNames);
        return ok({
          outputText: "done",
          toolCalls: [],
          toolResults: [],
          tokensConsumed: 11,
          decision: { shouldContinue: false, exitReason: "success" as const },
          steps: [],
          events: [],
          shortCircuited: false,
        });
      },
    });
    expect(loop.ok).toBe(true);
    if (!loop.ok) throw new Error("loop 应可创建: " + loop.error);

    const core = createReActCore({
      id: "worker",
      scope: nodeScope,
      config: cfg.value,
      contract: contractOf({ toolSet: ["FileWrite"] }),
      loop: loop.value,
    });
    expect(core.ok).toBe(true);
    if (!core.ok) throw new Error("ReActCore 应可创建: " + core.error);

    nodes.push({
      id: "N1",
      body: core.value,
      predecessors: [],
      joinMissing: "block",
    });
    const events: string[] = [];
    const metered: Array<[string, number]> = [];
    const wfR = createWorkflow({
      nodes,
      entry: "N1",
      depth: 0,
      maxDepth: 0,
      scope: ROOT,
      runner: createNodeRunner({
        emit: (e) => events.push(e.loopId),
        meter: (id, u) => metered.push([id, u.tokens]),
      }),
    });
    expect(wfR.ok).toBe(true);
    if (!wfR.ok) throw new Error("workflow 应可创建: " + wfR.error);

    const out = await wfR.value.step(mkInput());
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // 父授予 3 个工具，节点声明 1 个 ⇒ 十步循环只看见 1 个
    expect(seenGrants).toEqual([["FileWrite"]]);
    expect(out.value.produced.nodeLoopId).toBe("L/N1");
    expect(events).toEqual(["L/N1"]);
    expect(metered).toEqual([["L/N1", 11]]);
    expect(out.value.usage.tokens).toBe(11); // 外层转报，不翻倍
    // 原语自身的计量归原语实例（P3 不重复计）
    expect(core.value.loop.metrics().tokens).toBe(11);
  });
});
