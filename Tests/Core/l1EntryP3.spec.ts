/**
 * P3 收尾验证：选件策略 / Goal 判定 / 监管快照读缝。
 *
 * 这三项是"编排内核真正决定何时换件、何时收敛、监管能看到什么"的生产缝，
 * 之前只有外部注入或占位；本文件锁住它们的最小生产语义。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDatabase, closeDatabase } from "../../Src/Infra/Db/database.js";
import { initMigrations, migrateUp } from "../../Src/Infra/Db/migrations.js";
import {
  setActiveOwner,
  LOCAL_OWNER,
} from "../../Src/Services/AccountScope/activeAccount.js";
import {
  initOrchestrationRuntime,
  resetOrchestrationRuntime,
} from "../../Src/Core/Orchestration/orchestrationRuntime.js";
import {
  runL1Dialogue,
  selectExecutableForMode,
} from "../../Src/Core/Orchestration/l1Entry.js";
import type { Executable } from "../../Src/Core/Orchestration/outerLoop.js";
import { createReActLoop } from "../../Src/Core/Loop/reactLoop.js";
import { ok } from "../../Src/Infra/types.js";
import { resetL1LedgerHub } from "../../Src/Core/Orchestration/ledgerHub.js";

let dir = "";

const ITERATION_RESULT = {
  outputText: "done",
  toolCalls: [],
  toolResults: [],
  tokensConsumed: 5,
  decision: { shouldContinue: false, exitReason: "success" as const },
  steps: [],
  events: [],
  shortCircuited: false,
};

const STATIC = "ctx:zone:static";

/** 假执行件：直接产出 goalSatisfied/evidence（供 GoalEvaluator 判定） */
function fakeExecutable(): Executable {
  return {
    id: "DIRECT",
    contract: {
      inputSet: { sections: [STATIC], history: { recentTurns: 1 } },
      outputSet: ["outer"],
      toolSet: [],
    },
    async step() {
      return ok({
        produced: { goalSatisfied: true, evidence: "单元测试证据" },
        events: [],
        // 真实执行件退出时会报 iteration.exited（由控制器判定 terminate，域标记完成）
        needsDecision: [
          { event: "iteration.exited", payload: { reason: "success" } },
        ],
        usage: { tokens: 5, iterations: 1 },
      });
    },
  };
}

describe("L1 执行入口 · P3 收尾（选件/Goal/监管快照）", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "civitas-l1-p3-"));
    mkdirSync(dir, { recursive: true });
    initDatabase({
      mainPath: join(dir, "main.db"),
      eventsPath: join(dir, "events.db"),
      memoryPath: join(dir, "memory.db"),
      walMode: true,
      busyTimeoutMs: 5_000,
    });
    initMigrations();
    migrateUp();
    setActiveOwner(LOCAL_OWNER);
    resetOrchestrationRuntime();
    resetL1LedgerHub();
    expect(
      initOrchestrationRuntime({ dataDir: join(dir, "orchestration") }).ok,
    ).toBe(true);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("选件策略：DIRECT/REGULATION 固定首件；其余模式按周期轮转", () => {
    const assembly = { executables: ["DIRECT", "DELEGATION"] };
    expect(selectExecutableForMode(assembly, { cycle: 0 }, "DIRECT")).toBe(
      "DIRECT",
    );
    expect(selectExecutableForMode(assembly, { cycle: 5 }, "DIRECT")).toBe(
      "DIRECT",
    );
    expect(selectExecutableForMode(assembly, { cycle: 0 }, "REGULATION")).toBe(
      "DIRECT",
    );
    expect(selectExecutableForMode(assembly, { cycle: 0 }, "DELEGATION")).toBe(
      "DIRECT",
    );
    expect(selectExecutableForMode(assembly, { cycle: 1 }, "DELEGATION")).toBe(
      "DELEGATION",
    );
    expect(
      selectExecutableForMode({ executables: [] }, { cycle: 0 }, "DIRECT"),
    ).toBeNull();
  });

  it("Goal 判定：goalDecl + 不可变区摘要 ⇒ 执行件产出被 Core/Goal 判定为达成", async () => {
    const ran = await runL1Dialogue({
      agentId: "agent-l1-goal",
      task: "有明确目标的 L1 任务",
      goal: "产出可验收结果",
      traceId: "trace-l1-goal",
      loopId: "L-goal",
      maxCycles: 4,
      executableFor: () => fakeExecutable(),
      goalDecl: {
        id: "goal-p3",
        statement: "产出可验收结果",
        criteria: "goalSatisfied && evidence",
        immutableZoneDigest: "digest-ok",
      },
      immutableZoneDigest: () => "digest-ok",
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    expect(ran.value.state).toBe("domain_complete");
    expect(ran.value.snapshots.length).toBeGreaterThanOrEqual(1);
    expect(ran.value.snapshots[0]?.componentId).toBeTruthy();
    expect(ran.value.mode).toBe("DIRECT");
  });

  it("摘要漂移 ⇒ GoalEvaluator 不判达成（不谎报完成）", async () => {
    const innerLoop = createReActLoop(
      {
        loopId: "L-drift/N1",
        parentLoopId: "L-drift",
        agentId: "agent-l1-drift",
        traceId: "trace-l1-drift",
      },
      { runIteration: async () => ok(ITERATION_RESULT as never) },
    );
    expect(innerLoop.ok).toBe(true);
    if (!innerLoop.ok) return;
    const ran = await runL1Dialogue({
      agentId: "agent-l1-drift",
      task: "摘要漂移任务",
      goal: "目标",
      traceId: "trace-l1-drift",
      loopId: "L-drift",
      maxCycles: 2,
      innerLoop: innerLoop.value,
      goalDecl: {
        id: "goal-drift",
        statement: "目标",
        criteria: "goalSatisfied && evidence",
        immutableZoneDigest: "digest-declared",
      },
      // 实测摘要与声明不符 ⇒ 不得判定达成
      immutableZoneDigest: () => "digest-actual",
    });
    // 外层到 maxCycles 报"疑死循环"是如实失败（未达成不得谎报完成）
    expect(ran.ok).toBe(false);
    if (!ran.ok) expect(ran.error).toContain("最大周期");
  });
});
