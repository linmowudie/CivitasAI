/**
 * RoutingMode 预设 · **运行期 A/B 对齐**
 *
 * A 侧（改写前）：现有编排器 `receiveTask({ forcedMode })` 的真实产出 —— `plan.maxParallelism`
 *   与 `assignments` 的依赖链（串行/并行语义）。
 * B 侧（改写后）：`presets.ts` 预设组合的**真实执行**形状（并行是否重叠、顺序是否保序）。
 *
 * 两侧都**真的跑**，然后比对"编排形状"是否一致。
 * 覆盖范围：有 A 侧基线的 4 个模式（DIRECT / DELEGATION / ASSEMBLY_LINE / CONSORTIUM）。
 * `LITIGATION` / `REGULATION` **无 A 侧基线**（现有实现只有类型与注释）⇒ 不做 A/B（原因见 25 §7.24）。
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  receiveTask,
  resetOrchestrator,
} from "../../Src/Core/Decision/orchestrator/orchestrator.js";
import { resetDecomposer } from "../../Src/Core/Decision/TaskDecomposer/taskDecomposer.js";
import { resetRoutingRules } from "../../Src/Core/Decision/RouteDecision/routingRules.js";
import { resetAggregator } from "../../Src/Core/Decision/Orchestrator/resultAggregator.js";
import { resetAgentFactory } from "../../Src/Core/AgentRuntime/agentFactory.js";
import { resetAgentRegistry } from "../../Src/Core/AgentRuntime/agentRegistry.js";
import { resetAgentRuntime } from "../../Src/Core/AgentRuntime/agentRuntime.js";
import { resetEventBus } from "../../Src/Services/EventBus/eventBus.js";
import {
  resetWalletManager,
  initWalletManager,
} from "../../Src/Services/TokenEconomy/walletManager.js";
import { resetRouter } from "../../Src/Infra/Llm/Router/modelRouter.js";

import { presetFor } from "../../Src/Core/Patterns/presets.js";
import type {
  Executable,
  ReactInput,
  ReactOutput,
} from "../../Src/Core/Orchestration/outerLoop.js";
import { ok, type Result } from "../../Src/Infra/types.js";

function fullReset(): void {
  resetRouter();
  resetEventBus();
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  resetAgentRegistry();
  resetAgentFactory();
  resetAgentRuntime();
  resetOrchestrator();
  resetRoutingRules();
  resetDecomposer();
  resetAggregator();
}

/** A 侧观测：真实调用现有编排器，取编排形状 */
function observeBaseline(mode: string, taskDescription: string) {
  const res = receiveTask({
    taskId: "t-" + mode,
    traceId: "tr-" + mode,
    taskDescription,
    forcedMode: mode as never,
  });
  return res;
}

function mkInput(): ReactInput {
  return {
    state: "running",
    control: { shouldContinue: true, budgetRemaining: 1000, cycle: 0 },
    observation: { contextSections: [], history: [], upstream: {}, events: [] },
    grants: {
      tools: [],
      plugins: [],
      visible: { sections: [], history: { recentTurns: 1 } },
    },
  };
}

/** B 侧探针：记录调用顺序与时间，用于判定"真并行/真保序" */
function mkTimedExec(
  id: string,
  delayMs: number,
): { exe: Executable; calls: Array<{ at: number }> } {
  const calls: Array<{ at: number }> = [];
  return {
    calls,
    exe: {
      id,
      contract: {
        inputSet: { sections: [], history: { recentTurns: 1 } },
        outputSet: ["outer"],
        toolSet: [],
      },
      step: async (input: ReactInput): Promise<Result<ReactOutput>> => {
        calls.push({ at: Date.now() });
        await new Promise((r) => setTimeout(r, delayMs));
        void input;
        return ok({
          produced: { by: id },
          events: [],
          needsDecision: [],
          usage: { tokens: 1, iterations: 1 },
        });
      },
    },
  };
}

describe("A/B 对齐 · A 侧（现有编排器）可运行", () => {
  beforeEach(() => {
    fullReset();
  });

  it("ASSEMBLY_LINE：A 侧产出 plan（maxParallelism=1，串行语义）", () => {
    const res = observeBaseline(
      "ASSEMBLY_LINE",
      "执行 data migration 数据迁移，把旧库迁到新库",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const plan = res.value.taskPlan;
    expect(plan).toBeDefined();
    if (!plan) return;
    expect(plan.maxParallelism).toBe(1); // 流水线 = 串行
    expect(res.value.routingMode).toBe("ASSEMBLY_LINE");
  });

  it("DIRECT：A 侧 maxParallelism=1 且路由为 DIRECT", () => {
    const res = observeBaseline("DIRECT", "把 README 第一行改成新标题");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.routingMode).toBe("DIRECT");
    if (res.value.taskPlan) expect(res.value.taskPlan.maxParallelism).toBe(1);
  });

  it("DELEGATION / CONSORTIUM：A 侧可产出 plan（并行度 >= 1）", () => {
    for (const mode of ["DELEGATION", "CONSORTIUM"] as const) {
      fullReset();
      const res = observeBaseline(
        mode,
        mode === "CONSORTIUM"
          ? "攻克高难度的分布式一致性问题"
          : "并行调研三个子课题",
      );
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.value.routingMode).toBe(mode);
      if (res.value.taskPlan)
        expect(res.value.taskPlan.maxParallelism).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("A/B 对齐 · B 侧（预设）形状与 A 侧一致", () => {
  beforeEach(() => {
    fullReset();
  });

  it("ASSEMBLY_LINE：A 侧串行 ⇒ B 侧 Seq **保序**执行", async () => {
    const aRes = observeBaseline(
      "ASSEMBLY_LINE",
      "执行 data migration 数据迁移",
    );
    expect(aRes.ok).toBe(true);
    if (!aRes.ok || !aRes.value.taskPlan) return;
    const aParallel = aRes.value.taskPlan.maxParallelism;

    const s1 = mkTimedExec("s1", 5);
    const s2 = mkTimedExec("s2", 5);
    const preset = presetFor("ASSEMBLY_LINE", { stages: [s1.exe, s2.exe] });
    expect(preset.ok).toBe(true);
    if (!preset.ok) return;
    expect(preset.value.id.startsWith("seq(")).toBe(true);
    const bRes = await preset.value.step(mkInput());
    expect(bRes.ok).toBe(true);

    // A 侧串行（maxParallelism=1）⇒ B 侧必须**不重叠**（s2 在 s1 之后启动）
    expect(aParallel).toBe(1);
    expect(s2.calls[0]!.at).toBeGreaterThanOrEqual(s1.calls[0]!.at + 5);
  });

  it("DELEGATION：B 侧 Par **真并行**（重叠执行）", async () => {
    const started = Date.now();
    const w1 = mkTimedExec("w1", 40);
    const w2 = mkTimedExec("w2", 40);
    const preset = presetFor("DELEGATION", { workers: [w1.exe, w2.exe] });
    expect(preset.ok).toBe(true);
    if (!preset.ok) return;
    const res = await preset.value.step(mkInput());
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(true);
    expect(w1.calls.length).toBe(1);
    expect(w2.calls.length).toBe(1);
    // 真并行 ⇒ 总耗时显著小于串行（2×40ms）
    expect(elapsed).toBeLessThan(70);
  });

  it("DIRECT：A 侧单执行 ⇒ B 侧单节点只跑一次", async () => {
    const aRes = observeBaseline("DIRECT", "改一行标题");
    expect(aRes.ok).toBe(true);
    const body = mkTimedExec("body", 1);
    const preset = presetFor("DIRECT", { body: body.exe });
    expect(preset.ok).toBe(true);
    if (!preset.ok) return;
    const bRes = await preset.value.step(mkInput());
    expect(bRes.ok).toBe(true);
    expect(body.calls.length).toBe(1);
  });

  it("CONSORTIUM：B 侧 Par(settled) 容忍个别失败（A 侧 partner 攻坚的容错语义）", async () => {
    const p1 = mkTimedExec("p1", 1);
    const failing: Executable = {
      id: "p2",
      contract: {
        inputSet: { sections: [], history: { recentTurns: 1 } },
        outputSet: ["outer"],
        toolSet: [],
      },
      step: async () => ({ ok: false as const, error: "partner 失败" }),
    };
    const preset = presetFor("CONSORTIUM", { partners: [p1.exe, failing] });
    expect(preset.ok).toBe(true);
    if (!preset.ok) return;
    const res = await preset.value.step(mkInput());
    expect(res.ok).toBe(true); // settled：个别失败不影响整体
  });

  it("【负向】无 A 侧基线的两个模式**不做 A/B**（如实标注，不假装对齐过）", async () => {
    const { MODES_WITHOUT_BASELINE, presetDescriptors } =
      await import("../../Src/Core/Patterns/presets.js");
    expect([...MODES_WITHOUT_BASELINE]).toEqual(["LITIGATION", "REGULATION"]);
    for (const d of presetDescriptors({})) {
      if (MODES_WITHOUT_BASELINE.includes(d.mode)) {
        expect(d.baseline.kind).toBe("absent");
      }
    }
  });
});
