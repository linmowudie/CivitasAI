/**
 * G7 · 编排内核 **外部真实模型** 回归（≥3 轮）。
 *
 * 这是 `Tests/Core/orchestrationKernelG7.spec.ts`（确定性 scripted provider）的配对用例：
 * 同一链路 `executeAssignedTask（flag 开启）→ runL1Dialogue → OuterLoop → ReActCore → runIteration`，
 * 但模型换成**真实华为云 MaaS**——用来证明"内核接管后真实模型 Agent 仍能端到端跑完"。
 *
 * 门控：缺 `HUAWEI_MAAS_API_KEY` 时登记 NOT-RUN（与 `realAgent.spec.ts` 同口径），
 * 绝不因为缺 key 就伪造一次"通过"。
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { hasRealLlmKey, notRun } from "../Helpers/credentialGate.js";

import { OpenAIProvider } from "../../Src/Infra/Llm/Provider/openaiProvider.js";
import type { ProviderConfig } from "../../Src/Infra/Llm/Provider/providerBase.js";
import {
  registerProvider,
  setRoutingConfig,
  resetRouter,
} from "../../Src/Infra/Llm/Router/modelRouter.js";
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
import { resetAgentRuntime } from "../../Src/Core/AgentRuntime/agentRuntime.js";
import { executeAssignedTask } from "../../Src/Core/AgentRuntime/agentExecutor.js";
import {
  initOrchestrationRuntime,
  resetOrchestrationRuntime,
} from "../../Src/Core/Orchestration/orchestrationRuntime.js";
import { setOrchestrationKernelEnabled } from "../../Src/Core/Orchestration/l1Entry.js";

const HUAWEI_CONFIG: ProviderConfig = {
  provider: "huawei",
  base_url: "https://api.modelarts-maas.com/plan/v2",
  api_key_ref: "env:HUAWEI_MAAS_API_KEY",
  display_name: "华为云 MaaS",
  models: [
    {
      id: "glm-5.1",
      context_window: 128000,
      max_output: 8192,
      supports_vision: false,
      supports_tools: true,
      cost_per_1k_input: 1.0,
      cost_per_1k_output: 2.0,
    },
  ],
};
const MODEL = "huawei/glm-5.1";

describe("G7 · 编排内核真实模型回归（≥3 轮，外部模型）", () => {
  beforeAll(() => {
    if (!hasRealLlmKey()) {
      console.log(
        "G7 外部模型回归：缺 HUAWEI_MAAS_API_KEY ⇒ 登记 NOT-RUN（不伪造通过）",
      );
    }
  });

  afterEach(() => {
    setOrchestrationKernelEnabled(false);
  });

  it("3 轮真实模型 Agent 调用全部经编排内核跑完（flag 开启）", async () => {
    if (!hasRealLlmKey()) {
      notRun();
      return;
    }

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

    registerProvider(new OpenAIProvider(HUAWEI_CONFIG));
    setRoutingConfig({
      defaultModel: MODEL,
      directorModel: MODEL,
      workerModel: MODEL,
      verifierModel: MODEL,
      arbitrationModels: [MODEL],
      fallbackOrder: ["huawei"],
      timeoutMs: 60_000,
      firstByteTimeoutMs: 10_000,
      interChunkTimeoutMs: 15_000,
    });
    expect(initOrchestrationRuntime().ok).toBe(true);
    setOrchestrationKernelEnabled(true);

    for (let round = 1; round <= 3; round += 1) {
      const traceId = `trace-g7-real-${round}`;
      const created = createAgent(
        { role: "partner", model: "glm-5.1" },
        traceId,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const ran = await executeAssignedTask({
        agentId: created.value.agentId,
        instruction: `G7 真实模型第 ${round} 轮：用一句话概括你的任务结论。`,
        maxIterations: 2,
      });
      expect(ran.ok).toBe(true);
      if (!ran.ok) return;
      expect(ran.value.exitReason).toBe("success");
      expect(ran.value.iterations).toBeGreaterThanOrEqual(1);
    }
  }, 600_000);
});
