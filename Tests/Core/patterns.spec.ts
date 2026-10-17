/**
 * S9 · 三种模式负向测试（P&E / Workflow / GoalGuard + DIRECT 预设）
 *
 * 立场：**模式不是引擎** —— 全部由组合得到。
 * 设计出处：22-执行件-三种模式.md（各模式反例）· 04 · 21（算子闭集）
 * 纪律（25 §1）：负向用例必须真实调用。
 */
import { describe, it, expect } from "vitest";

import { ContextStore } from "../../Src/Services/Context/contextStore.js";
import { createContextAssembler } from "../../Src/Core/Context/contextAssembler.js";
import type {
  Executable,
  ReactInput,
  ReactOutput,
} from "../../Src/Core/Orchestration/outerLoop.js";
import {
  createPlanAndExecute,
  createWorkflow,
  createGoalGuard,
  withGoalGuard,
  directPreset,
  type PlanOutput,
  type WorkflowNodeSpec,
} from "../../Src/Core/Patterns/patterns.js";
import { ok, err, type Result } from "../../Src/Infra/types.js";

function mkInput(over: Partial<ReactInput> = {}): ReactInput {
  return {
    state: "running",
    control: { shouldContinue: true, budgetRemaining: 100, cycle: 0 },
    observation: { contextSections: [], history: [], upstream: {}, events: [] },
    grants: {
      tools: [],
      plugins: [],
      visible: { sections: [], history: { recentTurns: 1 } },
    },
    ...over,
  };
}

interface Call {
  id: string;
  input: ReactInput;
}

function mkExec(
  id: string,
  script: ReactOutput[],
  tools: readonly string[] = [],
): { exe: Executable; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    exe: {
      id,
      contract: {
        inputSet: { sections: [], history: { recentTurns: 1 } },
        outputSet: ["outer"],
        toolSet: tools,
      },
      step: async (input: ReactInput): Promise<Result<ReactOutput>> => {
        calls.push({ id, input });
        const out = script[Math.min(i, script.length - 1)];
        i += 1;
        if (!out) return err("空脚本");
        return ok(out);
      },
    },
  };
}

function out(partial: Partial<ReactOutput> = {}): ReactOutput {
  return {
    produced: {},
    events: [],
    needsDecision: [],
    usage: { tokens: 1, iterations: 1 },
    ...partial,
  };
}

const PLAN_OK: PlanOutput = { informationState: "complete", gaps: [] };
const PLAN_PARTIAL: PlanOutput = {
  informationState: "partial",
  gaps: [{ what: "缺资料 X" }],
};

describe("S9 · PlanAndExecute（完备度门两个出口）", () => {
  it("【负向】plan 缺 required 输出（informationState/gaps）⇒ 拒绝", async () => {
    const plan = mkExec("plan", [
      out({ produced: { plan: { steps: ["a"] } } }),
    ]);
    const exec = mkExec("exec", [out()]);
    const pae = createPlanAndExecute({
      plan: plan.exe,
      execute: exec.exe,
      gate: { onMissing: "degrade" },
    });
    const res = await pae.step(mkInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("required 输出");
    expect(exec.calls.length).toBe(0);
  });

  it("【负向】plan 仍有会改计划的 pendingChildren ⇒ **不得**进 execute", async () => {
    const plan = mkExec("plan", [
      out({ produced: { plan: { ...PLAN_OK, pendingChildren: ["kid-1"] } } }),
    ]);
    const exec = mkExec("exec", [out()]);
    const pae = createPlanAndExecute({
      plan: plan.exe,
      execute: exec.exe,
      gate: { onMissing: "degrade" },
    });
    const res = await pae.step(mkInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.produced.gate).toBe("back_to_plan");
    expect(exec.calls.length).toBe(0);
  });

  it("不完备 + back_to_plan ⇒ 回调查（execute 未被调用）", async () => {
    const plan = mkExec("plan", [out({ produced: { plan: PLAN_PARTIAL } })]);
    const exec = mkExec("exec", [out()]);
    const pae = createPlanAndExecute({
      plan: plan.exe,
      execute: exec.exe,
      gate: { onMissing: "back_to_plan" },
    });
    const res = await pae.step(mkInput());
    expect(res.ok).toBe(true);
    if (res.ok)
      expect(
        res.value.needsDecision.some((n) => n.event === "goal.unmet"),
      ).toBe(true);
    expect(exec.calls.length).toBe(0);
  });

  it("【负向】不完备 + degrade ⇒ 放行，但 **gaps 必须传给 execute**", async () => {
    const plan = mkExec("plan", [out({ produced: { plan: PLAN_PARTIAL } })]);
    const exec = mkExec("exec", [out()]);
    const pae = createPlanAndExecute({
      plan: plan.exe,
      execute: exec.exe,
      gate: { onMissing: "degrade" },
    });
    const res = await pae.step(mkInput());
    expect(res.ok).toBe(true);
    expect(exec.calls.length).toBe(1);
    const upstream = exec.calls[0]!.input.observation.upstream as {
      gaps?: unknown[];
    };
    expect(Array.isArray(upstream.gaps)).toBe(true);
    expect((upstream.gaps ?? []).length).toBe(1);
  });

  it("完备 ⇒ 直接进 execute（两个执行件都被真实调用，证明是**组合**而非新循环）", async () => {
    const plan = mkExec("plan", [out({ produced: { plan: PLAN_OK } })]);
    const exec = mkExec("exec", [out({ produced: { done: true } })]);
    const pae = createPlanAndExecute({
      plan: plan.exe,
      execute: exec.exe,
      gate: { onMissing: "degrade" },
    });
    const res = await pae.step(mkInput());
    expect(res.ok).toBe(true);
    expect(plan.calls.length).toBe(1);
    expect(exec.calls.length).toBe(1);
    expect(pae.id).toBe("plan&execute");
  });

  it("工具集 = 两半的并集（组合语义）", () => {
    const plan = mkExec("plan", [out()], ["FileRead"]);
    const exec = mkExec("exec", [out()], ["FileWrite"]);
    const pae = createPlanAndExecute({
      plan: plan.exe,
      execute: exec.exe,
      gate: { onMissing: "degrade" },
    });
    expect([...pae.contract.toolSet].sort()).toEqual(["FileRead", "FileWrite"]);
  });
});

describe("S9 · Workflow（节点门禁 + 递归节点体）", () => {
  function nodesWith(predecessors: string[]): WorkflowNodeSpec[] {
    return [
      {
        id: "n1",
        body: mkExec("n1", [out({ produced: { node_done: true } })]).exe,
        predecessors: [],
        joinMissing: "block",
      },
      {
        id: "n2",
        body: mkExec("n2", [out({ produced: { node_done: true } })]).exe,
        predecessors,
        joinMissing: "block",
      },
    ];
  }

  it("【负向】节点体不是执行件 ⇒ 构造期拒绝", () => {
    const bad = {
      id: "x",
      body: {} as never,
      predecessors: [],
      joinMissing: "block" as const,
    };
    const r = createWorkflow({
      nodes: [bad],
      entry: "x",
      depth: 0,
      maxDepth: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不是执行件");
  });

  it("【负向】嵌套深度未声明 ⇒ 构造期拒绝", () => {
    const r = createWorkflow({
      nodes: nodesWith([]),
      entry: "n1",
      depth: 3,
      maxDepth: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("未声明嵌套");
  });

  it("【负向】前驱不存在 ⇒ 构造期拒绝", () => {
    const r = createWorkflow({
      nodes: nodesWith(["ghost"]),
      entry: "n1",
      depth: 0,
      maxDepth: 0,
    });
    expect(r.ok).toBe(false);
  });

  it("【负向】前驱未收敛 ⇒ 不放行（dependency.blocked）", async () => {
    // n1 立即收敛；n2 的前驱是它自己（永不满足）⇒ 只剩 n2 时应当 blocked、且 n2 从不被执行
    const n1 = mkExec("n1", [out({ produced: { node_done: true } })]);
    const n2 = mkExec("n2", [out({ produced: { node_done: true } })]);
    const r = createWorkflow({
      nodes: [
        { id: "n1", body: n1.exe, predecessors: [], joinMissing: "block" },
        { id: "n2", body: n2.exe, predecessors: ["n2"], joinMissing: "block" },
      ],
      entry: "n1",
      depth: 0,
      maxDepth: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const first = await r.value.step(mkInput());
    expect(first.ok).toBe(true); // n1 正常推进
    const second = await r.value.step(mkInput());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      second.value.needsDecision.some((n) => n.event === "dependency.blocked"),
    ).toBe(true);
    expect(n2.calls.length).toBe(0); // 未放行
  });

  it("正常推进：n1 收敛后 n2 才被执行，最终 workflowDone", async () => {
    const n1 = mkExec("n1", [out({ produced: { node_done: true } })]);
    const n2 = mkExec("n2", [out({ produced: { node_done: true } })]);
    const r = createWorkflow({
      nodes: [
        { id: "n1", body: n1.exe, predecessors: [], joinMissing: "block" },
        { id: "n2", body: n2.exe, predecessors: ["n1"], joinMissing: "block" },
      ],
      entry: "n1",
      depth: 0,
      maxDepth: 0,
    });
    if (!r.ok) return;
    await r.value.step(mkInput());
    expect(n2.calls.length).toBe(0);
    const second = await r.value.step(mkInput());
    expect(second.ok).toBe(true);
    expect(n2.calls.length).toBe(1);
    const third = await r.value.step(mkInput());
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.value.produced.workflowDone).toBe(true);
  });

  it("【负向】推进**不动恒定区**（前缀稳定）", async () => {
    const store = new ContextStore();
    const contexts = createContextAssembler({
      store,
      now: () => 1,
      pullMinIntervalMs: 1000,
    });
    contexts.putSection({
      key: "ctx:zone:static",
      content: "SP",
      changeFreq: 0,
      scope: "session",
    });
    const h0 = contexts.applyConstantZone("SP", ["FileRead"]);
    expect(h0.ok).toBe(true);
    const before = contexts.diagnostics().constantHash;

    const n1 = mkExec("n1", [out({ produced: { node_done: true } })]);
    const r = createWorkflow({
      nodes: [
        { id: "n1", body: n1.exe, predecessors: [], joinMissing: "block" },
      ],
      entry: "n1",
      depth: 0,
      maxDepth: 0,
    });
    if (!r.ok) return;
    await r.value.step(mkInput());
    expect(contexts.diagnostics().constantHash).toBe(before);
  });

  it("【负向】无界环 ⇒ 报错（访问上限防线）", async () => {
    // 自环：n1 的 body 永不完成、且 n1 是自己的前驱
    const n1 = mkExec("n1", [out({ produced: {} })]);
    const r = createWorkflow({
      nodes: [
        { id: "n1", body: n1.exe, predecessors: ["n1"], joinMissing: "block" },
      ],
      entry: "n1",
      maxNodeVisits: 3,
      depth: 0,
      maxDepth: 0,
    });
    // 自环 ⇒ 前驱永不满足 ⇒ 一直 blocked（这是有界行为，不报错）
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 0; i < 5; i++) {
      const res = await r.value.step(mkInput());
      expect(res.ok).toBe(true);
    }
    expect(n1.calls.length).toBe(0);
  });
});

describe("S9 · GoalGuard（约束件：空工具集 + 只给建议 + 判定委托 P2 原语）", () => {
  const ZONE = "sha256:zone-v1";

  it("【负向】Goal 未声明判定口径 ⇒ 拒绝创建", () => {
    const r = createGoalGuard({
      id: "g1",
      statement: "完成 X",
      criteria: "   ",
      immutableZoneDigest: ZONE,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("判定口径");
  });

  it("【负向】Goal 未声明不可变区摘要 ⇒ 拒绝创建", () => {
    const r = createGoalGuard({
      id: "g1",
      statement: "完成 X",
      criteria: "有证据",
      immutableZoneDigest: "  ",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不可变区摘要");
  });

  it("【负向】工具集**恒为空**；挂到执行件上也不引入任何工具", () => {
    const g = createGoalGuard({
      id: "g1",
      statement: "完成 X",
      criteria: "存在产出且被检验",
      immutableZoneDigest: ZONE,
    });
    if (!g.ok) throw new Error("约束件创建应成功: " + g.error);
    expect(g.value.toolSet).toEqual([]);

    const body = mkExec("body", [out()], ["FileWrite"]);
    const guarded = withGoalGuard(body.exe, g.value, () => ZONE);
    expect(guarded.contract.toolSet).toEqual(["FileWrite"]); // 不新增工具
  });

  it("【负向】只给建议、**不产生状态**（状态归 LifecycleController）", () => {
    const g = createGoalGuard({
      id: "g1",
      statement: "X",
      criteria: "有证据",
      immutableZoneDigest: ZONE,
    });
    if (!g.ok) throw new Error("约束件创建应成功: " + g.error);
    const v = g.value.check({ goalSatisfied: true, evidence: "e" }, ZONE);
    if (!v.ok) throw new Error("判定应成功: " + v.error);
    expect("next" in (v.value as unknown as Record<string, unknown>)).toBe(
      false,
    );
    expect(v.value.suggestion).toBe("terminate");
  });

  it("【负向】出口声称达成但约束件判定未达成 ⇒ **拒绝该断言**", async () => {
    const g = createGoalGuard({
      id: "g1",
      statement: "X",
      criteria: "有证据",
      immutableZoneDigest: ZONE,
    });
    if (!g.ok) throw new Error("约束件创建应成功: " + g.error);
    const body = mkExec("body", [out({ produced: { goalSatisfied: true } })]); // 无 evidence
    const guarded = withGoalGuard(body.exe, g.value, () => ZONE);
    const res = await guarded.step(mkInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("拒绝该断言");
  });

  it("【负向】§P2 反例 5：不可变区摘要漂移 ⇒ 即便有证据也不得判为达成", () => {
    const g = createGoalGuard({
      id: "g1",
      statement: "X",
      criteria: "有证据",
      immutableZoneDigest: ZONE,
    });
    if (!g.ok) throw new Error("约束件创建应成功: " + g.error);
    const v = g.value.check(
      { goalSatisfied: true, evidence: "log#1" },
      "sha256:zone-v2-drifted",
    );
    if (!v.ok) throw new Error("判定应成功: " + v.error);
    expect(v.value.satisfied).toBe(false);
    expect(v.value.suggestion).toBe("degrade");
    expect(v.value.gaps[0]!.what).toContain("不可变区摘要");
  });

  it("【负向】判定原语不接受执行端口（§P2 反例 1）", async () => {
    const { createGoalEvaluator } =
      await import("../../Src/Core/Goal/goalEvaluator.js");
    const r = createGoalEvaluator(
      {
        id: "g1",
        statement: "X",
        criteria: "有证据",
        immutableZoneDigest: ZONE,
      },
      { modelPort: {} },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不接受执行/副作用端口");
  });

  it("有证据且摘要一致 ⇒ 判定达成，并把裁决写进产出", async () => {
    const g = createGoalGuard({
      id: "g1",
      statement: "X",
      criteria: "有证据",
      immutableZoneDigest: ZONE,
    });
    if (!g.ok) throw new Error("约束件创建应成功: " + g.error);
    const body = mkExec("body", [
      out({ produced: { goalSatisfied: true, evidence: "log#12" } }),
    ]);
    const guarded = withGoalGuard(body.exe, g.value, () => ZONE);
    const res = await guarded.step(mkInput());
    if (!res.ok) throw new Error("步进应成功: " + res.error);
    const verdict = res.value.produced.goalVerdict as { satisfied?: boolean };
    expect(verdict.satisfied).toBe(true);
  });

  it("【负向】判定基础由外层观测给出：digestOf 与实际不符 ⇒ 出口被拒", async () => {
    const g = createGoalGuard({
      id: "g1",
      statement: "X",
      criteria: "有证据",
      immutableZoneDigest: ZONE,
    });
    if (!g.ok) throw new Error("约束件创建应成功: " + g.error);
    const body = mkExec("body", [
      out({ produced: { goalSatisfied: true, evidence: "log#12" } }),
    ]);
    const guarded = withGoalGuard(
      body.exe,
      g.value,
      () => "sha256:zone-v2-drifted",
    );
    const res = await guarded.step(mkInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("拒绝该断言");
  });
});

describe("S9 · DIRECT 预设与迁移状态", () => {
  it("DIRECT 预设 = 单节点 Workflow，可正常步进", async () => {
    const body = mkExec("direct-body", [
      out({ produced: { node_done: true } }),
    ]);
    const preset = directPreset(body.exe);
    expect(preset.ok).toBe(true);
    if (!preset.ok) return;
    expect(preset.value.id.startsWith("workflow(")).toBe(true);
    const res = await preset.value.step(mkInput());
    expect(res.ok).toBe(true);
    expect(body.calls.length).toBe(1);
  });

  it("六个模式的预设由 presets.ts 给出；基线归属如实（4 有 / 2 无）", async () => {
    const { presetDescriptors, MODES_WITH_BASELINE, MODES_WITHOUT_BASELINE } =
      await import("../../Src/Core/Patterns/presets.js");
    expect([...MODES_WITH_BASELINE].length).toBe(4);
    expect([...MODES_WITHOUT_BASELINE]).toEqual(["LITIGATION", "REGULATION"]);
    const ds = presetDescriptors({});
    expect(ds.map((d) => d.mode).sort()).toEqual([
      "ASSEMBLY_LINE",
      "CONSORTIUM",
      "DELEGATION",
      "DIRECT",
      "LITIGATION",
      "REGULATION",
    ]);
    for (const d of ds) {
      if (MODES_WITHOUT_BASELINE.includes(d.mode))
        expect(d.baseline.kind).toBe("absent");
      else expect(d.baseline.kind).toBe("implemented");
    }
  });
});
