/**
 * G7 · 编排内核真实 Agent 执行回归（≥3 轮，flag 开启）。
 *
 * 与 `Tests/AgentRuntime/realAgent.spec.ts`（外部真实模型，缺 key 则 NOT-RUN）的分工：
 * 本文件把**真实 Agent 执行链**跑通并锁住——
 *   `executeAssignedTask`（flag 开启）→ `runL1Dialogue` → `OuterLoop`
 *   → 内核内层组件 `ReActCore` → **legacy `runIteration` 十步** → 真实 Provider 接口。
 * 模型侧用确定性假 Provider（不依赖网络），因此每次 CI 都能验证"编排内核接管后
 * L1 任务仍能端到端跑完"，而不是等 key。
 *
 * 这补的是 G7 的"生产装配后必须实调取证"：3 轮真实 Agent 调用（同一运行时，独立 trace）。
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
  registerProvider,
  setRoutingConfig,
  resetRouter,
} from "../../Src/Infra/Llm/Router/modelRouter.js";
import type { LlmProvider } from "../../Src/Infra/Llm/Provider/providerBase.js";
import { ok } from "../../Src/Infra/types.js";
import {
  initEventBus,
  resetEventBus,
} from "../../Src/Services/EventBus/eventBus.js";
import {
  initWalletManager,
  resetWalletManager,
} from "../../Src/Services/TokenEconomy/walletManager.js";
import {
  createAgent,
  resetAgentFactory,
} from "../../Src/Core/AgentRuntime/agentFactory.js";
import { resetAgentRegistry } from "../../Src/Core/AgentRuntime/agentRegistry.js";
import { executeAssignedTask } from "../../Src/Core/AgentRuntime/agentExecutor.js";
import {
  initOrchestrationRuntime,
  resetOrchestrationRuntime,
} from "../../Src/Core/Orchestration/orchestrationRuntime.js";
import {
  isOrchestrationKernelEnabled,
  setOrchestrationKernelEnabled,
} from "../../Src/Core/Orchestration/l1Entry.js";
import { resetAgentRuntime } from "../../Src/Core/AgentRuntime/agentRuntime.js";

let dir = "";
let callCount = 0;

/** 确定性假 Provider：每次返回一段完成文本（真实 Provider 接口，不走网络） */
function makeScriptedProvider(): LlmProvider {
  const model = {
    id: "scripted",
    context_window: 32000,
    max_output: 2048,
    supports_vision: false,
    supports_tools: true,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
  };
  return {
    name: "scripted-kernel",
    getModels: () => [model],
    supportsModel: () => true,
    chat: async () => {
      callCount += 1;
      return ok({
        content: `第 ${callCount} 轮：任务已完成（scripted）`,
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        model: "scripted",
      });
    },
    chatStream: async () =>
      ok({
        content: "",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        model: "scripted",
      }),
  } as unknown as LlmProvider;
}

describe("G7 · 编排内核真实 Agent 执行回归（flag 开启，≥3 轮）", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "civitas-g7-"));
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

    resetRouter();
    resetEventBus();
    initEventBus();
    resetWalletManager();
    initWalletManager({
      initialSupply: 1_000_000,
      defaultWalletBalance: 10_000,
    });
    resetAgentRegistry();
    resetAgentFactory();
    resetAgentRuntime();
    resetOrchestrationRuntime();

    registerProvider(makeScriptedProvider());
    setRoutingConfig({
      defaultModel: "scripted-kernel/scripted",
      directorModel: "scripted-kernel/scripted",
      workerModel: "scripted-kernel/scripted",
      verifierModel: "scripted-kernel/scripted",
      arbitrationModels: ["scripted-kernel/scripted"],
      fallbackOrder: ["scripted-kernel"],
      timeoutMs: 30_000,
      firstByteTimeoutMs: 5_000,
      interChunkTimeoutMs: 10_000,
    });
    const init = initOrchestrationRuntime({
      dataDir: join(dir, "orchestration"),
    });
    expect(init.ok).toBe(true);
    setOrchestrationKernelEnabled(true);
  });

  afterEach(() => {
    setOrchestrationKernelEnabled(false);
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it("3 轮真实 Agent 调用全部经编排内核跑完（每轮独立 trace）", async () => {
    expect(isOrchestrationKernelEnabled()).toBe(true);

    const results = [];
    for (let round = 1; round <= 3; round += 1) {
      const traceId = `trace-g7-round-${round}`;
      const created = createAgent(
        { role: "partner", model: "scripted-kernel/scripted" },
        traceId,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const ran = await executeAssignedTask({
        agentId: created.value.agentId,
        instruction: `G7 第 ${round} 轮：完成一个可验收的小任务`,
      });
      results.push({ round, ran });
      expect(ran.ok).toBe(true);
      if (!ran.ok) return;
      expect(ran.value.iterations).toBeGreaterThanOrEqual(1);
      expect(ran.value.exitReason).toBe("success");
      // 每轮独立 trace / loopId（不串轮）
      expect(ran.value.traceId).toBe(traceId);
      expect(ran.value.loopId).toContain("l1-");
    }

    expect(results).toHaveLength(3);
  }, 120_000);
});
