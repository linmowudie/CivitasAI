/**
 * 编排器尊重用户显式选择的工作方式（P0-4）。
 *
 * 修复前 `forceRoute()` 在整个代码库零调用点：不论前端选什么，编排器都按复杂度评估自动决策，
 * 用户的选择被静默丢弃。现在 `receiveTask({ forcedMode })` 必须走 `forceRoute`，
 * 且对编排器 switch 里不存在的模式给出**明确失败**而不是降级成 DIRECT。
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  receiveTask,
  resetOrchestrator,
} from "../../Src/Core/Decision/orchestrator/orchestrator.js";
import { resetProgressTracker } from "../../Src/Core/Decision/orchestrator/progressTracker.js";
import { resetAggregator } from "../../Src/Core/Decision/orchestrator/resultAggregator.js";
import { resetDecomposer } from "../../Src/Core/Decision/TaskDecomposer/taskDecomposer.js";
import { resetAssessor } from "../../Src/Core/Decision/complexityAssessor/complexityAssessor.js";
import { resetRoutingRules } from "../../Src/Core/Decision/routeDecision/routingRules.js";
import { resetRecruiter } from "../../Src/Services/Recruitment/recruiter.js";
import { resetTerminations } from "../../Src/Services/Recruitment/terminationRationale.js";
import { resetAgentRegistry } from "../../Src/Core/AgentRuntime/agentRegistry.js";
import { resetAgentFactory } from "../../Src/Core/AgentRuntime/agentFactory.js";
import { resetAgentRuntime } from "../../Src/Core/AgentRuntime/agentRuntime.js";
import {
  resetEventBus,
  initEventBus,
} from "../../Src/Services/EventBus/eventBus.js";
import {
  resetWalletManager,
  initWalletManager,
} from "../../Src/Services/TokenEconomy/walletManager.js";

function fullReset(): void {
  resetEventBus();
  initEventBus();
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  resetAgentRegistry();
  resetAgentFactory();
  resetAgentRuntime();
  resetOrchestrator();
  resetProgressTracker();
  resetAggregator();
  resetDecomposer();
  resetAssessor();
  resetRoutingRules();
  resetRecruiter();
  resetTerminations();
}

/** 复杂度评估必然判为 DIRECT 的简单任务，用来做"自动 vs 指定"的对照 */
const SIMPLE = "修改按钮颜色";

describe("receiveTask · forcedMode", () => {
  beforeEach(fullReset);

  it("不指定时保持既有行为：按复杂度评估自动决策", () => {
    const result = receiveTask({
      taskId: "t1",
      traceId: "tr1",
      taskDescription: SIMPLE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.routingMode).toBe("DIRECT");
  });

  it("指定工作方式时压过自动决策（forceRoute 生效）", () => {
    const result = receiveTask({
      taskId: "t2",
      traceId: "tr2",
      taskDescription: SIMPLE,
      forcedMode: "DELEGATION",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 同一句描述、同一套规则：自动决策给出 DIRECT，指定 DELEGATION 后必须真的是 DELEGATION
      expect(result.value.routingMode).toBe("DELEGATION");
      expect(result.value.status).toBe("success");
    }
  });

  it("编排器尚未实现的模式的错误是明确的（不静默降级）", () => {
    const result = receiveTask({
      taskId: "t3",
      traceId: "tr3",
      taskDescription: SIMPLE,
      forcedMode: "LITIGATION",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("尚未实现");
  });
});
