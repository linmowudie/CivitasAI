/**
 * 《Docs/Agent/17-控制论审查》P1-9 / P1-10 回归锁 —— E6 / E7
 *
 * - E7（P1-9）：派发闸门让 `dependsOn` 与 `maxParallelism` 真正有执行器
 * - E6（P1-10）：编排慢环监视器订阅式巡检 + 异常落终态 + `anomaly_poll_invoked` 计数
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  registerDispatchPlan,
  pumpDispatch,
  getDispatchPlanState,
  resetDispatchGate,
  type PendingDispatch,
} from "../../Src/Core/Decision/orchestrator/dispatchGate.js";
import {
  pollOrchestrationAnomalies,
  startOrchestrationMonitor,
  stopOrchestrationMonitor,
  isOrchestrationMonitorRunning,
  getOrchestrationMonitorStats,
  resetOrchestrationMonitor,
} from "../../Src/Core/Decision/orchestrator/orchestrationMonitor.js";
import {
  registerAssignment,
  updateProgress,
  resetProgressTracker,
} from "../../Src/Core/Decision/orchestrator/progressTracker.js";
import {
  resetEventBus,
  getEventLog,
  publish,
  createEvent,
} from "../../Src/Services/EventBus/eventBus.js";
import { EventType } from "../../Src/Services/EventBus/eventTypes.js";
import {
  getControlTriggerCounts,
  resetControlTriggerCounts,
} from "../../Src/Infra/Logging/controlTriggers.js";
import type { TaskAssignment } from "../../Src/Core/Decision/types.js";

function assignment(
  assignmentId: string,
  dependsOn: string[] = [],
): TaskAssignment {
  return {
    assignmentId,
    description: `子任务 ${assignmentId}`,
    requiredTools: [],
    dependsOn,
    status: "pending",
  } as TaskAssignment;
}

function item(
  id: string,
  dependsOn: string[],
  log: string[],
  onBlocked?: (r: string) => void,
): PendingDispatch {
  return {
    assignmentId: id,
    dependsOn,
    dispatch: () => {
      log.push(id);
    },
    ...(onBlocked ? { onBlocked } : {}),
  };
}

/** 模拟子任务进入终态（走真实事件通道，闸门据此释放后继） */
function terminate(assignmentId: string, failed = false): void {
  publish(
    createEvent({
      eventType: failed ? EventType.TASK_FAILED : EventType.TASK_COMPLETED,
      source: "Tests/dispatchGateAndMonitor",
      traceId: "trace-gate",
      payload: { assignmentId },
    }),
  );
}

beforeEach(() => {
  resetDispatchGate();
  resetProgressTracker();
  resetOrchestrationMonitor();
  resetEventBus();
  resetControlTriggerCounts();
});

// ═══════════════════════════════════════════════════════════════════
// E7 · P1-9 依赖序与并发上限
// ═══════════════════════════════════════════════════════════════════

describe("E7 · P1-9 派发闸门", () => {
  it("遵守 maxParallelism：上限 1 时只派发一个，终态后释放下一个", () => {
    const log: string[] = [];
    registerDispatchPlan(
      "t-cap",
      [item("a", [], log), item("b", [], log), item("c", [], log)],
      1,
    );
    expect(log).toEqual(["a"]);
    expect(getDispatchPlanState("t-cap")).toMatchObject({
      pending: 2,
      inFlight: 1,
      maxParallelism: 1,
    });

    terminate("a");
    expect(log).toEqual(["a", "b"]);
    terminate("b");
    expect(log).toEqual(["a", "b", "c"]);
  });

  it("遵守 dependsOn 拓扑序（流水线不再扇出）", () => {
    const log: string[] = [];
    registerDispatchPlan(
      "t-chain",
      [item("n1", [], log), item("n2", ["n1"], log), item("n3", ["n2"], log)],
      4,
    );
    // 首波只有 n1（n2/n3 的前置未终态）
    expect(log).toEqual(["n1"]);

    terminate("n1");
    expect(log).toEqual(["n1", "n2"]);
    terminate("n2");
    expect(log).toEqual(["n1", "n2", "n3"]);
  });

  it("并发上限与依赖序同时生效", () => {
    const log: string[] = [];
    // a、b 无依赖（可并行，但上限 2）；c 依赖 a
    registerDispatchPlan(
      "t-mix",
      [item("a", [], log), item("b", [], log), item("c", ["a"], log)],
      2,
    );
    expect(log).toEqual(["a", "b"]);

    terminate("a");
    expect(log).toEqual(["a", "b", "c"]);
  });

  it("前置失败 → 后继不再派发并如实回调 onBlocked（不等 TTL）", () => {
    const log: string[] = [];
    const blocked: string[] = [];
    registerDispatchPlan(
      "t-fail",
      [item("a", [], log), item("b", ["a"], log, (r) => blocked.push(r))],
      4,
    );
    expect(log).toEqual(["a"]);

    terminate("a", true);
    expect(log).toEqual(["a"]); // b 永不派发
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toContain("a");
  });

  it("单项派发抛异常不卡死计划（按失败计入终态，释放后继）", () => {
    const log: string[] = [];
    registerDispatchPlan(
      "t-throw",
      [
        {
          assignmentId: "boom",
          dependsOn: [],
          dispatch: () => {
            throw new Error("招募炸了");
          },
        },
        item("after", ["boom"], log, () => {
          /* blocked */
        }),
      ],
      4,
    );
    const state = getDispatchPlanState("t-throw");
    expect(state?.terminal).toBe(2); // boom 与 after 都被记入终态
    expect(log).toEqual([]);
  });

  it("pumpDispatch 可显式触发（幂等）", () => {
    const log: string[] = [];
    registerDispatchPlan("t-pump", [item("x", [], log)], 1);
    expect(log).toEqual(["x"]);
    expect(pumpDispatch("t-pump")).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// E6 · P1-10 慢环监视器
// ═══════════════════════════════════════════════════════════════════

describe("E6 · P1-10 编排慢环监视器", () => {
  it("巡检把异常转成 TASK_FAILED（携带 assignmentId）并计数", () => {
    // 用"连续失败达上限"制造异常（无需时间旅行）
    registerAssignment(assignment("assign-sick"));
    updateProgress("assign-sick", null, { status: "in_progress", failures: 5 });

    const anomalies = pollOrchestrationAnomalies();
    expect(anomalies.length).toBeGreaterThan(0);
    expect(
      anomalies.some((a) => a.anomalyType === "consecutive_failures"),
    ).toBe(true);

    const failedEvents = getEventLog({ eventType: EventType.TASK_FAILED });
    expect(
      failedEvents.some((e) => e.payload["assignmentId"] === "assign-sick"),
    ).toBe(true);
    // 元监控：该计数长期为 0 即意味着慢环没接上
    expect(getControlTriggerCounts().anomaly_poll_invoked).toBe(1);
  });

  it("无异常时不发布事件，但仍计数（证明巡检在跑）", () => {
    expect(pollOrchestrationAnomalies()).toEqual([]);
    expect(getEventLog({ eventType: EventType.TASK_FAILED })).toHaveLength(0);
    expect(getControlTriggerCounts().anomaly_poll_invoked).toBe(1);
  });

  it("启停幂等，状态可查询", () => {
    expect(isOrchestrationMonitorRunning()).toBe(false);
    startOrchestrationMonitor(50_000);
    expect(isOrchestrationMonitorRunning()).toBe(true);
    startOrchestrationMonitor(50_000); // 幂等
    const stats = getOrchestrationMonitorStats();
    expect(stats.running).toBe(true);
    expect(stats.intervalMs).toBe(50_000);
    stopOrchestrationMonitor();
    expect(isOrchestrationMonitorRunning()).toBe(false);
  });

  it("默认周期 = 停滞阈值 / 4（保证阈值内至少巡检 4 次）", () => {
    const stats = getOrchestrationMonitorStats();
    expect(stats.intervalMs).toBe(75_000); // 300000 / 4
  });
});
