/**
 * S2 · 组件级监管快照 负向测试（23 号 §S2 反例 1–6 + 13 §12.2 权限边界）
 *
 * 纪律（25 §1）：必须真实调用 C1/C2/C3/C4/S4 的真实实现，不许用字符串桩替代被测链路。
 * 这里唯一的「替身」是诊断信号来源（生产上来自 `agentRegistry`，形态是一个普通对象）。
 */
import { describe, it, expect } from "vitest";

import { ContextStore } from "../../Src/Services/Context/contextStore.js";
import { createContextAssembler } from "../../Src/Core/Context/contextAssembler.js";
import type { ContextSectionPort } from "../../Src/Core/Context/contextAssembler.js";
import {
  checkpointKey,
  createCheckpointRouter,
  createMemoryCheckpointBackend,
  componentCheckpointPort,
  type CheckpointBackend,
} from "../../Src/Core/Durable/checkpointRouter.js";
import {
  createChildRegistry,
  createDomainLedger,
} from "../../Src/Core/Ledger/ledgers.js";
import { createLifecycleController } from "../../Src/Core/Lifecycle/lifecycleController.js";
import type {
  Decision,
  LifecycleCtx,
} from "../../Src/Core/Lifecycle/lifecycleTypes.js";
import {
  createComponentSnapshot,
  createSupervisionChannel,
  EXCLUDED_DIAGNOSTIC_KEYS,
} from "../../Src/Core/Supervision/componentSnapshot.js";

const HISTORY = [
  { role: "user", content: "H1" },
  { role: "assistant", content: "A1" },
  { role: "user", content: "H2" },
  { role: "assistant", content: "A2" },
  { role: "user", content: "H3" },
];

/** 宿主（外层）声明的可见面：三个分区 + 最近 4 轮 */
const HOST = {
  sections: ["ctx:zone:static", "ctx:goal", "ctx:plan"],
  history: { recentTurns: 4 },
};
/** 组件实际可见面：宿主的**真子集**（快照的合法申请范围） */
const VISIBLE = {
  sections: ["ctx:zone:static", "ctx:plan"],
  history: { recentTurns: 2 },
};

function ctxOf(over: Partial<LifecycleCtx> = {}): LifecycleCtx {
  return {
    componentId: "c1",
    outstanding: [],
    produced: [],
    dependencySatisfied: true,
    budgetRemaining: 10,
    now: 1000,
    ...over,
  };
}

interface StackOpts {
  /** 需判断事件的默认决策（模拟模型） */
  askNext?: Decision;
  /** false ⇒ 控制器**不接**监管通道（反例 6 的第二半：绕过合法集的接线） */
  wireSupervision?: boolean;
  diagnostics?: () => Record<string, unknown>;
}

function mkStack(opts: StackOpts = {}) {
  const store = new ContextStore();
  let puts = 0;
  const spyStore = {
    put(section: ContextSectionPort): boolean {
      puts += 1;
      return store.put(section);
    },
    get: (key: string) => store.get(key),
    toAppendMessages: () => store.toAppendMessages(),
  };
  const contexts = createContextAssembler({
    store: spyStore,
    now: () => 1000,
    pullMinIntervalMs: 30_000,
  });
  contexts.putSection({
    key: "ctx:zone:static",
    content: "SP",
    changeFreq: 0,
    scope: "session",
  });
  contexts.putSection({
    key: "ctx:goal",
    content: "GOAL",
    changeFreq: 2,
    scope: "dialogue",
  });
  contexts.putSection({
    key: "ctx:plan",
    content: "PLAN",
    changeFreq: 3,
    scope: "component",
  });
  puts = 0; // 只统计**测试准备之后**的写入

  const children = createChildRegistry();
  const domain = createDomainLedger("L1");

  const saved: string[] = [];
  const inner = createMemoryCheckpointBackend();
  const spyBackend: CheckpointBackend = {
    append: async (loopId, snapshot) => {
      const r = await inner.append(loopId, snapshot);
      if (r.ok) saved.push(loopId);
      return r;
    },
    latest: (loopId) => inner.latest(loopId),
  };
  const router = createCheckpointRouter(spyBackend);
  router.registerWriter("component", "c1", "outer");

  const channel = createSupervisionChannel();
  const controllerR = createLifecycleController({
    askModel: async () =>
      opts.askNext ?? { next: "handoff", to: "parent", refs: [] },
    ...(opts.wireSupervision === false ? {} : { supervision: channel.hook }),
    checkpoint: componentCheckpointPort(router, "c1", "outer"),
  });
  if (!controllerR.ok) throw new Error("控制器创建失败: " + controllerR.error);

  const snapshot = createComponentSnapshot({
    contexts,
    children,
    domain,
    controller: controllerR.value,
    channel,
    history: () => HISTORY,
    ...(opts.diagnostics ? { diagnostics: opts.diagnostics } : {}),
    now: () => 4321,
  });

  return {
    store,
    contexts,
    children,
    domain,
    router,
    channel,
    controller: controllerR.value,
    snapshot,
    writes: () => puts,
    checkpointWrites: () => saved,
  };
}

describe("S2 · 反例 1：快照导出全量上下文（超出组件可见范围）⇒ 拒绝", () => {
  it("【负向】申请宿主未声明的分区 ⇒ 拒绝（越权可见）", () => {
    const { snapshot } = mkStack();
    const r = snapshot.snapshot({
      componentId: "c1",
      visible: {
        sections: ["ctx:zone:static", "ctx:governance:internal"],
        history: { recentTurns: 1 },
      },
      host: HOST,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("越权");
  });

  it("【负向】申请宿主全集 ⇒ 拒绝（全量导出不是监管该做的事）", () => {
    const { snapshot } = mkStack();
    const r = snapshot.snapshot({
      componentId: "c1",
      visible: { ...HOST, sections: [...HOST.sections] },
      host: HOST,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("宿主全集");
  });

  it("【负向】历史轮数超出宿主 ⇒ 拒绝（只能收紧）", () => {
    const { snapshot } = mkStack();
    const r = snapshot.snapshot({
      componentId: "c1",
      visible: { sections: ["ctx:plan"], history: { recentTurns: 9 } },
      host: HOST,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("只能收紧");
  });

  it("【负向】未指明组件 id ⇒ 拒绝", () => {
    const { snapshot } = mkStack();
    const r = snapshot.snapshot({
      componentId: "  ",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("组件 id");
  });

  it("【正向】快照只含申请的两个分区（store 里有三个）", () => {
    const { snapshot, store } = mkStack();
    const r = snapshot.snapshot({
      componentId: "c1",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(store.keys()).toHaveLength(3);
    // 稳定段在前（变更频率升序）：监管复现判断时看到的顺序 = 组件实际看到的顺序
    expect(r.value.context.sections.map((s) => s.key)).toEqual([
      "ctx:zone:static",
      "ctx:plan",
    ]);
  });

  it("【正向】历史按可见面裁剪，且不拼接更早轮次", () => {
    const { snapshot } = mkStack();
    const r = snapshot.snapshot({
      componentId: "c1",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.context.history.map((m) => m.content)).toEqual(["A2", "H3"]);
    expect(r.value.context.historyTurns).toBe(2);
  });
});

describe("S2 · 反例 2：快照包含私有推理（S-01 草稿）⇒ 拒绝", () => {
  it("【负向】草稿/私有推理键（含变体写法）进不了快照", () => {
    const { snapshot } = mkStack({
      diagnostics: () => ({
        draft: "我想先删掉文件",
        Draft_Note: "草稿变体",
        reasoning: "内心独白",
        CoT: ["a", "b"],
        scratch_pad: "p",
        private_notes: "n",
        s_01: "S-01 草稿",
        iterations: 7,
        toolCalls: 3,
      }),
    });
    const r = snapshot.snapshot({
      componentId: "c1",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dumped = JSON.stringify(r.value.work.diagnostics).toLowerCase();
    for (const bad of EXCLUDED_DIAGNOSTIC_KEYS) {
      expect(dumped).not.toContain(bad);
    }
    expect(dumped).not.toContain("内心独白");
    // benign 信号必须**保留**（否则过滤成了「什么都不给」，监管无从复现）
    expect(r.value.work.diagnostics).toEqual({ iterations: 7, toolCalls: 3 });
  });

  it("【负向】草稿藏在数组元素里同样被剔除（字段过滤，结构保留）", () => {
    const { snapshot } = mkStack({
      diagnostics: () => ({ stallSignals: [{ turn: 5, draft: "泄漏路径" }] }),
    });
    const r = snapshot.snapshot({
      componentId: "c1",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.value.work.diagnostics)).not.toContain("泄漏路径");
    expect(r.value.work.diagnostics).toEqual({ stallSignals: [{ turn: 5 }] });
  });

  it("【负向】草稿藏在嵌套对象里同样被剔除", () => {
    const { snapshot } = mkStack({
      diagnostics: () => ({
        signals: { step1: { reasoning: "独白", tokens: 12 } },
      }),
    });
    const r = snapshot.snapshot({
      componentId: "c1",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.value.work.diagnostics)).not.toContain("独白");
  });
});

describe("S2 · 反例 3：快照独立落盘（成为第三个写者）⇒ 拒绝", () => {
  it("【负向】取快照不写任何分区", () => {
    const { snapshot, writes } = mkStack({
      diagnostics: () => ({ iterations: 1 }),
    });
    const r = snapshot.snapshot({
      componentId: "c1",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(true);
    expect(writes()).toBe(0);
  });

  it("【负向】取快照不碰落盘，也不新增写者", () => {
    const { snapshot, router, checkpointWrites } = mkStack();
    snapshot.snapshot({ componentId: "c1", visible: VISIBLE, host: HOST });
    expect(checkpointWrites()).toEqual([]);
    expect(router.writersOf("component", "c1")).toEqual(["outer"]);
    // 快照本身没有落盘入口（想写只能借 C1 的端口 ⇒ 仍是唯一写者）
    expect("save" in snapshot).toBe(false);
  });
});

describe("S2 · 反例 4：允许监管直接改写组件内部数据 ⇒ 拒绝", () => {
  it("【负向】本件对外只有两个动作（观察 / 干预），没有任何置状态或改写入口", () => {
    const { snapshot } = mkStack();
    expect(Object.keys(snapshot).sort()).toEqual(["intervene", "snapshot"]);
  });

  it("【负向】取快照后：账本版本、控制器状态、模型调用次数一律不变", () => {
    const stack = mkStack({ diagnostics: () => ({ iterations: 2 }) });
    stack.children.register({ childId: "k1", joinedAt: 1000 });
    stack.domain.addPeer("p1", "write");
    const before = {
      childVer: stack.children.version(),
      domainVer: stack.domain.version(),
      state: stack.controller.getState(),
      modelCalls: stack.controller.modelCallCount(),
      selfState: stack.domain.snapshot().selfState,
    };
    const r = stack.snapshot.snapshot({
      componentId: "c1",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(true);
    expect(stack.children.version()).toBe(before.childVer);
    expect(stack.domain.version()).toBe(before.domainVer);
    expect(stack.controller.getState()).toBe(before.state);
    expect(stack.controller.modelCallCount()).toBe(before.modelCalls);
    expect(stack.domain.snapshot().selfState).toBe(before.selfState);
  });

  it("【正向】工作状态是真实账本的投影（C3 未收敛下级 / C2 兄弟 / C1 决策历史）", () => {
    const stack = mkStack();
    stack.children.register({ childId: "k1", joinedAt: 1000 });
    stack.children.register({ childId: "k2", joinedAt: 1000 });
    stack.children.settle("k2", "success", 1500);
    stack.domain.addPeer("p1", "write");
    stack.domain.peerSettled("p1");

    const r = stack.snapshot.snapshot({
      componentId: "c1",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.work.outstandingChildren).toEqual(["k1"]);
    expect(r.value.work.childrenQuiescent).toBe(false);
    expect(r.value.work.domainPeers).toEqual([
      { peerId: "p1", state: "done", conflictDomain: "write" },
    ]);
    expect(r.value.work.domainSelf).toBe("running");
    expect(r.value.work.domainQuiescent).toBe(false);
    expect(r.value.work.decisions).toEqual([]); // 还没有任何决策发生
    expect(r.value.takenAt).toBe(4321);
  });

  it("【负向】投影不可回写：改快照里的账本视图不影响真账本", () => {
    const stack = mkStack();
    stack.children.register({ childId: "k1", joinedAt: 1000 });
    const r = stack.snapshot.snapshot({
      componentId: "c1",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const list = r.value.work.outstandingChildren as unknown as string[];
    list.push("injected");
    expect(stack.children.outstanding()).toEqual(["k1"]);
  });
});

describe("S2 · 反例 5：快照含治理内部状态（层级隔离被打破）⇒ 拒绝", () => {
  it("【负向】合法表 / 收紧表 / 决策缓存 / 治理状态都进不了快照", () => {
    const { snapshot } = mkStack({
      diagnostics: () => ({
        legalTable: { "iteration.exited": ["terminate"] },
        tightenedSet: ["*"],
        decisionCache: { size: 99 },
        governanceInternal: { writers: ["outer"] },
        internalGovernance: { level: "L1" },
        iterations: 4,
      }),
    });
    const r = snapshot.snapshot({
      componentId: "c1",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.work.diagnostics).toEqual({ iterations: 4 });
  });

  it("【负向】快照只带留痕结论（违规记录），不带 C1 的内部合法表", async () => {
    const stack = mkStack({
      diagnostics: () => ({
        legalTable: { x: 1 },
        governanceInternal: { y: 2 },
        iterations: 4,
      }),
    });
    stack.children.register({ childId: "k1", joinedAt: 1000 });
    await stack.snapshot.intervene({
      componentId: "c1",
      event: "iteration.exited",
      ctx: ctxOf({ outstanding: ["k1"] }),
      directive: { next: "terminate" },
    });
    const r = stack.snapshot.snapshot({
      componentId: "c1",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.work.violations).toHaveLength(1);
    expect(r.value.work.violations[0]?.kind).toBe(
      "supervision_out_of_legal_set",
    );
    expect(r.value.work.diagnostics).toEqual({ iterations: 4 });
  });
});

describe("S2 · 反例 6：监管干预未走合法集（直接置状态）⇒ 拒绝，必须经 C1 收束", () => {
  it("【负向】建议 terminate 但仍有未收敛下级 ⇒ C1 拒绝并留痕，状态不得变 terminate", async () => {
    const stack = mkStack();
    stack.children.register({ childId: "k1", joinedAt: 1000 });
    const r = await stack.snapshot.intervene({
      componentId: "c1",
      event: "iteration.exited",
      ctx: ctxOf({ outstanding: ["k1"] }),
      directive: { next: "terminate" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.next).toBe("handoff"); // 由模型在**合法集内**给出（不是监管要的那个）
    expect(stack.controller.getState()).toBe("handoff");
    expect(stack.controller.getState()).not.toBe("terminate");
    expect(
      stack.controller
        .violations()
        .some((v) => v.kind === "supervision_out_of_legal_set"),
    ).toBe(true);
    const last =
      stack.controller.decisions()[stack.controller.decisions().length - 1];
    expect(last?.via).toBe("model");
    expect(last?.to).toBe("handoff");
  });

  it("【负向】控制器创建时没接监管通道 ⇒ 干预报错（不允许「下了指令但没人收束」）", async () => {
    const stack = mkStack({ wireSupervision: false });
    const r = await stack.snapshot.intervene({
      componentId: "c1",
      event: "deadline.reached",
      ctx: ctxOf(),
      directive: { next: "degrade", reason: "监管降级", gaps: [] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("未经 C1 收束");
    expect(stack.channel.hasPending("c1", "deadline.reached")).toBe(false); // 不留残余
  });

  it("【负向】指令目标与判定上下文组件不一致 ⇒ 拒绝，且不落到 C1", async () => {
    const stack = mkStack();
    const stateBefore = stack.controller.getState();
    const callsBefore = stack.controller.modelCallCount();
    const r = await stack.snapshot.intervene({
      componentId: "c1",
      event: "deadline.reached",
      ctx: ctxOf({ componentId: "other" }),
      directive: { next: "abandon", reason: "打到别的组件" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不一致");
    expect(stack.controller.getState()).toBe(stateBefore);
    expect(stack.controller.modelCallCount()).toBe(callsBefore);
    expect(stack.channel.hasPending("c1", "deadline.reached")).toBe(false);
  });

  it("【正向】合法集内的降级 ⇒ 经 C1 生效，决策历史记为 supervision 通道", async () => {
    const stack = mkStack();
    const r = await stack.snapshot.intervene({
      componentId: "c1",
      event: "deadline.reached",
      ctx: ctxOf(),
      directive: {
        next: "degrade",
        reason: "超时",
        gaps: [{ what: "未完成的验收项" }],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.next).toBe("degrade");
    expect(stack.controller.getState()).toBe("degrade");
    expect(stack.controller.violations()).toEqual([]);
    const records = stack.controller.decisions();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "deadline.reached",
      from: "running",
      to: "degrade",
      via: "supervision",
    });
  });

  it("【负向】指令一次性消费：后续事件不再复用旧指令", async () => {
    const stack = mkStack({ askNext: { next: "running" } });
    const first = await stack.snapshot.intervene({
      componentId: "c1",
      event: "goal.unmet",
      ctx: ctxOf(),
      directive: { next: "degrade", reason: "首次降级", gaps: [] },
    });
    expect(first.ok).toBe(true);
    // 后续循环自己上报事件（不带监管指令）⇒ 必须走模型判定，而不是沿用上一条指令
    const second = await stack.controller.onEvent("goal.unmet", ctxOf());
    expect(second.ok).toBe(true);
    const via = stack.controller.decisions().map((d) => d.via);
    expect(via[0]).toBe("supervision");
    expect(via[1]).toBe("model");
    expect(stack.channel.hasPending("c1", "goal.unmet")).toBe(false);
  });

  it("【正向】干预后快照能复现「为何选了那个状态」", async () => {
    const stack = mkStack({ diagnostics: () => ({ iterations: 3 }) });
    await stack.snapshot.intervene({
      componentId: "c1",
      event: "deadline.reached",
      ctx: ctxOf(),
      directive: { next: "degrade", reason: "超时", gaps: [] },
    });
    const r = stack.snapshot.snapshot({
      componentId: "c1",
      visible: VISIBLE,
      host: HOST,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.work.state).toBe("degrade");
    expect(r.value.work.decisions).toHaveLength(1);
    expect(r.value.work.decisions[0]?.via).toBe("supervision");
  });
});

describe("S2 · 落盘键空间归属（S4 纪律的延续）", () => {
  it("【负向】C1 因监管指令挂起时，快照写的是组件自己的空间", async () => {
    const stack = mkStack();
    const r = await stack.snapshot.intervene({
      componentId: "c1",
      event: "dependency.blocked",
      ctx: ctxOf({ dependencySatisfied: false }),
      directive: { next: "suspend", until: "event", refs: ["dep-1"] },
    });
    expect(r.ok).toBe(true);
    expect(stack.controller.getState()).toBe("suspend");
    expect(stack.checkpointWrites()).toEqual([
      checkpointKey("component", "c1"),
    ]);
    expect(stack.router.writersOf("component", "c1")).toEqual(["outer"]);
  });
});
