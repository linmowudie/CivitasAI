/**
 * 03 §6 第 7 / 15 行「Goal 未声明出口判定」「组件自行宣称 success」的**接线级**证伪
 *
 * 为什么要单独一份：`patterns.spec.ts` / `presets.spec.ts` 里约束件都在**单件**上被调用，
 * 没有验证过三件事——
 *   ① 约束件插在**组合里**（Workflow 节点体）时是否真的生效；
 *   ② 接入约束件会不会**改写执行件的三集合**（工具/输入/输出集）；
 *   ③ E1（真实执行件）+ E4（约束件）+ E3（Workflow）三段串起来后，
 *      节点收口与达成判定是否仍各归各位（E1 只报事实、E4 只给裁决、E3 只推节点）。
 *
 * 设计出处：Docs/Dev/L1编排设计/23-原语补齐与监管快照.md §P2（反例 1/5）·
 *   27-判据执行者覆盖.md（03 §6 第 7、15 行）· 22-执行件-三种模式.md
 * 纪律（25 §1）：负向用例必须真实调用 —— 全部真实调用 `createReActCore` / `withGoalGuard` /
 * `createWorkflow`，只把模型层换成确定性桩。
 */
import { describe, it, expect } from "vitest";

import { createReActCore } from "../../Src/Core/Orchestration/reactCore.js";
import {
  createReActLoop,
  type LoopScope,
} from "../../Src/Core/Loop/reactLoop.js";
import { createLoopConfig } from "../../Src/Core/Loop/loopConfig.js";
import {
  createWorkflow,
  createGoalGuard,
  withGoalGuard,
} from "../../Src/Core/Patterns/patterns.js";
import type { IterationResult } from "../../Src/Core/Loop/runIteration.js";
import type {
  Executable,
  ReactInput,
  ReactOutput,
} from "../../Src/Core/Orchestration/outerLoop.js";
import { ok, type Result } from "../../Src/Infra/types.js";

const ZONE = "sha256:zone-v1";
const TASK = { sections: ["task"], history: { recentTurns: 4 } };

function mkInput(over: Partial<ReactInput> = {}): ReactInput {
  return {
    state: "running",
    control: { shouldContinue: true, budgetRemaining: 1000, cycle: 0 },
    observation: {
      contextSections: [{ key: "ctx:task", content: "验证约束件接线" }],
      history: [{ role: "user", content: "验证约束件接线" }],
      upstream: {},
      events: [],
    },
    grants: { tools: ["FileRead"], plugins: [], visible: TASK },
    ...over,
  };
}

/** 真实 E1：模型层换成确定性桩（其余全真） */
function realE1(
  id: string,
  scope: LoopScope,
  produced: Record<string, unknown>,
): Executable {
  const cfg = createLoopConfig({ model: "test-model", stream: false });
  if (!cfg.ok) throw new Error("config");
  const loop = createReActLoop(scope, {
    runIteration: async (): Promise<Result<IterationResult>> =>
      ok({
        outputText: "结论已给出",
        toolCalls: [],
        toolResults: [],
        tokensConsumed: 30,
        decision: { shouldContinue: false, exitReason: "success" },
        steps: [],
        events: [],
        shortCircuited: false,
        // ★ 迭代结果没有"达成断言"通道：达成只能由**出口产出**表达
      } as IterationResult),
  });
  if (!loop.ok) throw new Error("loop");
  const core = createReActCore({
    id,
    scope,
    config: cfg.value,
    contract: { inputSet: TASK, outputSet: ["outer"], toolSet: ["FileRead"] },
    loop: loop.value,
  });
  if (!core.ok) throw new Error("ReActCore: " + core.error);
  // 组合层用**产出**表达达成断言：包一层把声明的 produced 并进去
  return {
    id: core.value.id,
    contract: core.value.contract,
    async step(input: ReactInput): Promise<Result<ReactOutput>> {
      const out = await core.value.step(input);
      if (!out.ok) return out;
      return ok({
        ...out.value,
        produced: { ...out.value.produced, ...produced },
      });
    },
  };
}

/** 一个"自述达成"的替身执行件（**带工具**：约束件不得改写三集合） */
function claimingExec(
  id: string,
  produced: Record<string, unknown>,
): { exe: Executable; calls: ReactInput[] } {
  const calls: ReactInput[] = [];
  return {
    calls,
    exe: {
      id,
      contract: {
        inputSet: TASK,
        outputSet: ["outer"],
        toolSet: ["FileWrite"],
      },
      async step(input: ReactInput): Promise<Result<ReactOutput>> {
        calls.push(input);
        return ok({
          produced: { node_done: true, ...produced },
          events: [],
          needsDecision: [],
          usage: { tokens: 1, iterations: 1 },
        });
      },
    },
  };
}

function mkGuard() {
  const g = createGoalGuard({
    id: "g1",
    statement: "结论有可核验证据",
    criteria: "存在非空 evidence",
    immutableZoneDigest: ZONE,
  });
  if (!g.ok) throw new Error("约束件应可创建: " + g.error);
  return g.value;
}

function oneNodeWorkflow(body: Executable) {
  const w = createWorkflow({
    nodes: [{ id: "n1", body, predecessors: [], joinMissing: "block" }],
    entry: "n1",
    depth: 0,
    maxDepth: 0,
  });
  if (!w.ok) throw new Error("Workflow 应可创建: " + w.error);
  return w.value;
}

describe("03 §6-7/15 · 约束件接线的三条真实约束", () => {
  it("【负向 ①】未插约束件 ⇒ 自述达成**不产生任何裁决**（外层不得据此收口）", async () => {
    const body = claimingExec("claim", {
      goalSatisfied: true,
      evidence: "自说自话",
    });
    const wf = oneNodeWorkflow(body.exe);
    const res = await wf.step(mkInput());
    if (!res.ok) throw new Error("步进应成功: " + res.error);
    expect(res.value.produced["goalSatisfied"]).toBe(true); // 组件确实自述了
    expect(res.value.produced["goalVerdict"]).toBeUndefined(); // 但**没有**裁决
  });

  it("接了约束件 ⇒ 裁决随产出上行（Workflow 路径，不是直调 guard）", async () => {
    const body = claimingExec("claim", {
      goalSatisfied: true,
      evidence: "pytest 12 passed",
    });
    const guarded = withGoalGuard(body.exe, mkGuard(), () => ZONE);
    const wf = oneNodeWorkflow(guarded);
    const res = await wf.step(mkInput());
    if (!res.ok) throw new Error("步进应成功: " + res.error);
    const verdict = res.value.produced["goalVerdict"] as {
      satisfied: boolean;
      suggestion: string;
    };
    expect(verdict.satisfied).toBe(true);
    expect(verdict.suggestion).toBe("terminate");
    expect(res.value.produced["node_done"]).toBe(true); // 节点照常收口
  });

  it("【负向 ②】接入约束件不改写执行件的三集合（工具/输入/输出都恒等）", () => {
    const body = claimingExec("claim", { goalSatisfied: true, evidence: "e" });
    const guarded = withGoalGuard(body.exe, mkGuard(), () => ZONE);
    expect(guarded.contract.toolSet).toEqual(["FileWrite"]);
    expect(guarded.contract.inputSet).toEqual(body.exe.contract.inputSet);
    expect(guarded.contract.outputSet).toEqual(body.exe.contract.outputSet);
    // 约束件自身工具集恒为空
    expect(mkGuard().toolSet).toEqual([]);
  });

  it("【负向 ③】外层观测到不可变区漂移 ⇒ 经 Workflow 的出口同样被拒", async () => {
    const body = claimingExec("claim", {
      goalSatisfied: true,
      evidence: "pytest 12 passed",
    });
    const guarded = withGoalGuard(body.exe, mkGuard(), () => "sha256:tampered");
    const wf = oneNodeWorkflow(guarded);
    const res = await wf.step(mkInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("拒绝该断言");
    expect(body.calls.length).toBe(1); // 主体确实跑了，是**出口**被拒
  });

  it("【负向 ③续】判定基础缺失（外层不给摘要）⇒ 拒绝判定而不是默认达成", async () => {
    const body = claimingExec("claim", { goalSatisfied: true, evidence: "e" });
    const guarded = withGoalGuard(body.exe, mkGuard(), () => "");
    const res = await oneNodeWorkflow(guarded).step(mkInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("不可变区摘要");
  });

  it("真实 E1 作为节点体：不自述达成 ⇒ 出口无 goalSatisfied，约束件放行不误伤", async () => {
    const scope: LoopScope = {
      loopId: "L/C1",
      parentLoopId: "L",
      agentId: "a1",
      traceId: "t1",
    };
    const e1 = realE1("rc1", scope, {}); // 没有任何达成断言
    const guarded = withGoalGuard(e1, mkGuard(), () => ZONE);
    const wf = oneNodeWorkflow(guarded);
    const res = await wf.step(mkInput());
    if (!res.ok) throw new Error("步进应成功: " + res.error);
    const verdict = res.value.produced["goalVerdict"] as {
      satisfied: boolean;
      suggestion: string;
    };
    expect(verdict.satisfied).toBe(false); // 未达成是事实
    expect(verdict.suggestion).toBe("running"); // 建议继续，**不是**报错
    expect(res.value.produced["node_done"]).toBe(true);
  });

  it("真实 E1 + 自述达成但无证据 ⇒ 出口被拒（约束件对**真实执行件**同样生效）", async () => {
    const scope: LoopScope = {
      loopId: "L/C1",
      parentLoopId: "L",
      agentId: "a1",
      traceId: "t1",
    };
    const e1 = realE1("rc1", scope, { goalSatisfied: true }); // 无 evidence
    const guarded = withGoalGuard(e1, mkGuard(), () => ZONE);
    const res = await oneNodeWorkflow(guarded).step(mkInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("拒绝该断言");
  });

  it("【负向】E1 声明工具集外的授予 ⇒ 组合前就被拒（约束件不豁免工具收紧）", async () => {
    const scope: LoopScope = {
      loopId: "L/C1",
      parentLoopId: "L",
      agentId: "a1",
      traceId: "t1",
    };
    const e1 = realE1("rc1", scope, {});
    const guarded = withGoalGuard(e1, mkGuard(), () => ZONE);
    const res = await guarded.step(
      mkInput({ grants: { tools: ["ShellExec"], plugins: [], visible: TASK } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("只能收紧");
  });

  it("恒定区不被节点步进改写（约束件与 Workflow 都只动上游产物）", async () => {
    const body = claimingExec("claim", { goalSatisfied: true, evidence: "e" });
    const guarded = withGoalGuard(body.exe, mkGuard(), () => ZONE);
    const input = mkInput();
    const res = await oneNodeWorkflow(guarded).step(input);
    if (!res.ok) throw new Error("步进应成功: " + res.error);
    expect(input.grants.tools).toEqual(["FileRead"]);
    expect(input.observation.upstream).toEqual({});
    expect(input.state).toBe("running");
  });
});
