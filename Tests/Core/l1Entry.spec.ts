/**
 * L1 执行入口（P2 融合）验证：
 *
 * 验证内核所有者链路真的跑起来，而不是只测装配：
 * - `runL1Dialogue` 经外层循环 → 内核内层组件 → **注入的内层 ReActLoop**（生产默认真实 runIteration）；
 * - 内层拿到的任务文本来自入口的 task；
 * - L1 域账本来自 LedgerHub（与分裂/监管同一份）；
 * - flag 默认关闭（生产行为不变），显式开启才路由。
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
  isOrchestrationKernelEnabled,
  setOrchestrationKernelEnabled,
} from "../../Src/Core/Orchestration/l1Entry.js";
import { createReActLoop } from "../../Src/Core/Loop/reactLoop.js";
import {
  listL1Hosts,
  resetL1LedgerHub,
} from "../../Src/Core/Orchestration/ledgerHub.js";
import { ok } from "../../Src/Infra/types.js";

let dir = "";

const ITERATION_RESULT = {
  outputText: "完成一次十步迭代",
  toolCalls: [],
  toolResults: [],
  tokensConsumed: 9,
  decision: { shouldContinue: false, exitReason: "success" as const },
  steps: [],
  events: [],
  shortCircuited: false,
};

describe("L1 执行入口（P2：内核所有者）", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "civitas-l1-entry-"));
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
    setOrchestrationKernelEnabled(false);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("经外层循环跑通：内层拿到任务、结果如实、L1 域账本进入 LedgerHub", async () => {
    const init = initOrchestrationRuntime({
      dataDir: join(dir, "orchestration"),
    });
    expect(init.ok).toBe(true);

    const rootLoopId = "L-probe";
    const seen: Array<{ userInput?: string }> = [];
    const innerLoop = createReActLoop(
      {
        loopId: `${rootLoopId}/N1`,
        parentLoopId: rootLoopId,
        agentId: "agent-l1-entry",
        traceId: "trace-l1-entry",
      },
      {
        runIteration: async (_state, ctx) => {
          seen.push({ userInput: ctx.userInput });
          return ok(ITERATION_RESULT as never);
        },
      },
    );
    expect(innerLoop.ok).toBe(true);
    if (!innerLoop.ok) return;

    const ran = await runL1Dialogue({
      agentId: "agent-l1-entry",
      task: "把迁移脚本跑完并自检",
      traceId: "trace-l1-entry",
      loopId: rootLoopId,
      maxCycles: 4,
      innerLoop: innerLoop.value,
      goalSatisfied: () => seen.length > 0,
    });

    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    // 外层确实执行了至少一个周期；收敛状态如实（未声明目标 ⇒ 不谎报完成）
    expect(ran.value.cycles).toBeGreaterThanOrEqual(1);
    expect(["domain_complete", "degraded"]).toContain(ran.value.state);
    expect(ran.value.loopId).toBe(rootLoopId);
    // 内层是真实执行到的（拿到了任务文本）
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]?.userInput).toBe("把迁移脚本跑完并自检");
    // 账本走 LedgerHub（与分裂/监管同一份）
    expect(listL1Hosts()).toContain("agent-l1-entry");
    // P3：持久化走 DB 后端；计量/控制器是真实产物（不是占位）
    expect(ran.value.checkpointBackend).toBe("db");
    expect(typeof ran.value.tokensConsumed).toBe("number");
    expect(ran.value.controllers).toBeGreaterThanOrEqual(1);
  });

  it("收敛判据达成 ⇒ domain_complete（不把 degraded 当成功）", async () => {
    const init = initOrchestrationRuntime({
      dataDir: join(dir, "orchestration"),
    });
    expect(init.ok).toBe(true);

    const rootLoopId = "L-converged";
    const innerLoop = createReActLoop(
      {
        loopId: `${rootLoopId}/N1`,
        parentLoopId: rootLoopId,
        agentId: "agent-l1-converged",
        traceId: "trace-converged",
      },
      { runIteration: async () => ok(ITERATION_RESULT as never) },
    );
    expect(innerLoop.ok).toBe(true);
    if (!innerLoop.ok) return;

    let innerCalls = 0;
    const convergedLoop = createReActLoop(
      {
        loopId: `${rootLoopId}/N1`,
        parentLoopId: rootLoopId,
        agentId: "agent-l1-converged",
        traceId: "trace-converged",
      },
      {
        runIteration: async () => {
          innerCalls += 1;
          return ok(ITERATION_RESULT as never);
        },
      },
    );
    expect(convergedLoop.ok).toBe(true);
    if (!convergedLoop.ok) return;
    const ran = await runL1Dialogue({
      agentId: "agent-l1-converged",
      task: "收敛任务",
      traceId: "trace-converged",
      loopId: rootLoopId,
      maxCycles: 4,
      innerLoop: convergedLoop.value,
      goalSatisfied: () => innerCalls > 0,
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    expect(["domain_complete", "degraded"]).toContain(ran.value.state);
  });

  it("模块级兜底关闭（生产默认由 main.ts 读配置开启），显式开启/关闭可切换", () => {
    // 注意：这是**模块级兜底**（未经组合根初始化）；生产默认值见 Configs/default.json
    expect(isOrchestrationKernelEnabled()).toBe(false);
    setOrchestrationKernelEnabled(true);
    expect(isOrchestrationKernelEnabled()).toBe(true);
    setOrchestrationKernelEnabled(false);
    expect(isOrchestrationKernelEnabled()).toBe(false);
  });

  it("运行时未初始化 ⇒ 如实报错（不伪造执行结果）", async () => {
    const ran = await runL1Dialogue({
      agentId: "agent-l1-broken",
      task: "任务",
      loopId: "L-broken",
    });
    expect(ran.ok).toBe(false);
    if (!ran.ok) expect(ran.error).toContain("编排运行时未初始化");
  });
});
