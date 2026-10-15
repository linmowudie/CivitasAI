/**
 * S10 · 派发驱动与子任务终态链路（REV-338/339/344/347，2026-10-09）
 *
 * 锁定四处装配：
 *  1. `initTaskDriver` 订阅 `task:assigned`，按任务书（instruction + maxIterations +
 *     tokenBudget + timeLimitMs）驱动 Agent，且对同一 assignmentId 幂等
 *     （编排器与 `assignTask` 各发一次事件，此前重复驱动会双跑 Loop）。
 *  2. 审核拒绝侧发布带 `assignmentId` 的 `task:failed`（此前只有 `APPROVAL_DECIDED`）。
 *  3. `progressTracker` 收到 `task:failed` 必须落 `status='failed'`，否则聚合永不收尾。
 *  4. 子任务台账写点的两条护栏：`in_progress` 是 `started_at` 的唯一写面（REV-347，此前全库
 *     无人写过，耗时不可审计）；已终态的行既不能被复活、也不能被重复累加 failure_count（REV-344）。
 *
 * 边界：本 spec 只锁事件与状态装配。终态回写、Agent 回收、时限/预算的真实生效
 * 一律以真实进程取证为准（§16.4：不以单测通过作为收口）。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const execMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    value: {
      agentId: "agent-worker-1",
      loopId: "loop-x",
      traceId: "trace-x",
      exitReason: "success",
      iterations: 2,
      tokensConsumed: 100,
      output: "done",
    },
  })),
);

// 子任务仓储的读侧可控：`markSubtaskStarted` 的护栏全靠 `getSubtask` 返回什么决定。
// 其余导出保持真实实现（本 spec 不触发它们），避免整模块 mock 掩盖别的调用点。
const repoMock = vi.hoisted(() => ({
  getSubtask: vi.fn(() => undefined as undefined | { status: string }),
  updateSubtaskStatus: vi.fn(),
  upsertSubtask: vi.fn(),
}));

vi.mock("../../Src/Core/AgentRuntime/agentExecutor.js", () => ({
  executeAssignedTask: execMock,
}));

vi.mock(
  "../../Src/Infra/Db/Repositories/subtaskRepository.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../Src/Infra/Db/Repositories/subtaskRepository.js")
      >();
    return {
      ...actual,
      getSubtask: repoMock.getSubtask,
      updateSubtaskStatus: repoMock.updateSubtaskStatus,
      upsertSubtask: repoMock.upsertSubtask,
    };
  },
);

import {
  initTaskDriver,
  resetTaskDriver,
  drainTaskDriver,
} from "../../Src/Core/Decision/orchestrator/taskDriver.js";
import {
  initProgressTracker,
  registerAssignment,
  getProgress,
  resetProgressTracker,
} from "../../Src/Core/Decision/orchestrator/progressTracker.js";
import {
  submitForReview,
  reviewSubmission,
  resetAgentRuntime,
  assignTask,
} from "../../Src/Core/AgentRuntime/agentRuntime.js";
import {
  createAgent,
  resetAgentFactory,
} from "../../Src/Core/AgentRuntime/agentFactory.js";
import {
  markSubtaskStarted,
  markSubtaskFailed,
} from "../../Src/Core/Decision/orchestrator/subtaskDispatcher.js";
import { resetAgentRegistry } from "../../Src/Core/AgentRuntime/agentRegistry.js";
import { EventType } from "../../Src/Services/EventBus/eventTypes.js";
import type { DomainEvent } from "../../Src/Services/EventBus/eventTypes.js";
import {
  createEvent,
  publish,
  subscribe,
  resetEventBus,
  initEventBus,
} from "../../Src/Services/EventBus/eventBus.js";
import {
  resetWalletManager,
  initWalletManager,
} from "../../Src/Services/TokenEconomy/walletManager.js";

function assignment(id: string, taskId = "task-1") {
  return {
    assignmentId: id,
    taskId,
    traceId: "trace-1",
    parentAgentId: "agent-director-1",
    subtaskIndex: 0,
    description: `子任务 ${id}`,
    inputContext: {},
    outputSchema: {},
    maxIterations: 6,
    timeLimitMs: 60_000,
    tokenBudget: 5_000,
    dependsOn: [],
    requiredTools: [],
    status: "assigned" as const,
    assignedAgentId: "agent-worker-1",
  };
}

function fullReset() {
  resetTaskDriver();
  resetEventBus();
  initEventBus();
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  resetAgentRegistry();
  resetAgentFactory();
  resetAgentRuntime();
  resetProgressTracker();
  execMock.mockClear();
  repoMock.getSubtask.mockReset();
  repoMock.getSubtask.mockReturnValue(undefined);
  repoMock.updateSubtaskStatus.mockClear();
}

describe("REV-338 · 派发后台执行驱动", () => {
  beforeEach(fullReset);

  it("按任务书驱动，且同一 assignmentId 只驱动一次", async () => {
    initTaskDriver();

    publish(
      createEvent({
        eventType: EventType.TASK_ASSIGNED,
        source: "Orchestrator/executeDelegation",
        traceId: "trace-1",
        payload: {
          taskId: "task-1",
          assignmentId: "asg-1",
          agentId: "agent-worker-1",
          instruction: "产出模块 A 的实现说明",
          maxIterations: 6,
          tokenBudget: 15_000,
          timeLimitMs: 150_000,
        },
      }),
    );
    // 同一指派的第二条事件（`AgentRuntime/assignTask` 也会发 task:assigned）不得重复驱动
    publish(
      createEvent({
        eventType: EventType.TASK_ASSIGNED,
        source: "AgentRuntime/assignTask",
        traceId: "trace-1",
        payload: {
          taskId: "asg-1",
          assignmentId: "asg-1",
          agentId: "agent-worker-1",
        },
      }),
    );
    await drainTaskDriver();

    expect(execMock).toHaveBeenCalledTimes(1);
    // 任务书的迭代上限、token 预算与墙钟时限必须透传（台账记 15000/150s 而实花 416907 token、
    // 实测单任务 605s，是 REV-345/346 的成因）
    expect(execMock).toHaveBeenCalledWith({
      agentId: "agent-worker-1",
      instruction: "产出模块 A 的实现说明",
      maxIterations: 6,
      tokenBudget: 15_000,
      timeLimitMs: 150_000,
    });
  });

  it("不带 assignmentId 的事件不驱动（汇总类事件）", async () => {
    initTaskDriver();
    publish(
      createEvent({
        eventType: EventType.TASK_ASSIGNED,
        source: "Orchestrator/finalizeOrchestration",
        traceId: "trace-1",
        payload: { taskId: "task-1", agentId: "agent-worker-1" },
      }),
    );
    await drainTaskDriver();
    expect(execMock).not.toHaveBeenCalled();
  });

  it("串行：后到的指派不并发执行", async () => {
    initTaskDriver();
    const timeline: string[] = [];
    execMock.mockImplementation(async (p: { agentId: string }) => {
      timeline.push(`start:${p.agentId}`);
      await new Promise((r) => setTimeout(r, 20));
      timeline.push(`end:${p.agentId}`);
      return {
        ok: true,
        value: {
          agentId: p.agentId,
          loopId: "",
          traceId: "",
          iterations: 1,
          tokensConsumed: 0,
          output: "",
        },
      };
    });

    for (const id of ["w-1", "w-2"]) {
      publish(
        createEvent({
          eventType: EventType.TASK_ASSIGNED,
          source: "Orchestrator/executeAssemblyLine",
          traceId: "trace-1",
          payload: {
            taskId: "task-1",
            assignmentId: `asg-${id}`,
            agentId: id,
            instruction: "x",
          },
        }),
      );
    }
    await drainTaskDriver();

    expect(timeline).toEqual(["start:w-1", "end:w-1", "start:w-2", "end:w-2"]);
  });
});

describe("REV-339 · 审核拒绝落子任务终态", () => {
  beforeEach(fullReset);

  it("拒绝评审发布带 assignmentId 的 task:failed", () => {
    const traceId = "trace-rev-1";
    const worker = createAgent(
      { role: "worker", model: "worker-model" },
      traceId,
    );
    const reviewer = createAgent(
      { role: "reviewer", model: "reviewer-model" },
      traceId,
    );
    expect(worker.ok).toBe(true);
    expect(reviewer.ok).toBe(true);
    if (!worker.ok || !reviewer.ok) return;

    assignTask(worker.value.agentId, "asg-9", traceId);
    expect(
      submitForReview({
        taskId: "asg-9",
        workerAgentId: worker.value.agentId,
        payload: { summary: "产出说明" },
      }).ok,
    ).toBe(true);

    const received: DomainEvent[] = [];
    subscribe(EventType.TASK_FAILED, (e) => received.push(e));

    const result = reviewSubmission({
      taskId: "asg-9",
      reviewerAgentId: reviewer.value.agentId,
      accepted: false,
      comment: "摘要与任务要求不符",
    });
    expect(result.ok).toBe(true);

    const failed = received.find((e) => e.payload.assignmentId === "asg-9");
    expect(failed).toBeDefined();
    expect(failed?.payload.reason).toBe("摘要与任务要求不符");
    expect(failed?.payload.workerAgentId).toBe(worker.value.agentId);
  });

  it("progressTracker 收到 task:failed 后落 failed 状态（聚合前置条件）", () => {
    initProgressTracker();
    registerAssignment(assignment("asg-1"));
    expect(getProgress("asg-1")?.status).toBe("pending");

    publish(
      createEvent({
        eventType: EventType.TASK_FAILED,
        source: "AgentRuntime/reviewSubmission",
        traceId: "trace-1",
        payload: {
          taskId: "asg-1",
          assignmentId: "asg-1",
          reason: "评审未通过",
        },
      }),
    );

    const p = getProgress("asg-1");
    expect(p?.status).toBe("failed");
    expect(p?.failures).toBe(1);
  });

  it("无 assignmentId 的 task:failed 不改写任何子任务状态", () => {
    initProgressTracker();
    registerAssignment(assignment("asg-1"));

    publish(
      createEvent({
        eventType: EventType.TASK_FAILED,
        source: "Orchestrator/test",
        traceId: "trace-1",
        payload: { taskId: "task-1", reason: "汇总级失败" },
      }),
    );

    expect(getProgress("asg-1")?.status).toBe("pending");
  });
});

describe("REV-347 · 子任务台账的执行中状态（started_at 唯一写点）", () => {
  beforeEach(fullReset);

  it("驱动真正开跑前把派发态升级为 in_progress", async () => {
    repoMock.getSubtask.mockReturnValue({ status: "assigned" });
    initTaskDriver();

    publish(
      createEvent({
        eventType: EventType.TASK_ASSIGNED,
        source: "Orchestrator/executeDelegation",
        traceId: "trace-1",
        payload: {
          taskId: "task-1",
          assignmentId: "asg-1",
          agentId: "agent-worker-1",
          instruction: "x",
        },
      }),
    );
    await drainTaskDriver();

    expect(repoMock.updateSubtaskStatus).toHaveBeenCalledWith(
      "asg-1",
      "in_progress",
    );
  });

  it("台账里没有该子任务行时不写（DIRECT / 临时执行不该污染子任务表）", async () => {
    repoMock.getSubtask.mockReturnValue(undefined);
    initTaskDriver();

    publish(
      createEvent({
        eventType: EventType.TASK_ASSIGNED,
        source: "Orchestrator/executeDirect",
        traceId: "trace-1",
        payload: {
          taskId: "task-1",
          assignmentId: "task-1",
          agentId: "agent-worker-1",
          instruction: "x",
        },
      }),
    );
    await drainTaskDriver();

    expect(repoMock.updateSubtaskStatus).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("已终态的行不能被复活成执行中", () => {
    repoMock.getSubtask.mockReturnValue({ status: "failed" });
    markSubtaskStarted("asg-1");
    expect(repoMock.updateSubtaskStatus).not.toHaveBeenCalled();
  });

  it("REV-344 护栏：评审拒绝已写 failed 后，失败事件不再重复落台账", () => {
    repoMock.getSubtask.mockReturnValue({ status: "failed" });
    markSubtaskFailed("asg-1", "循环结束未提交评审");
    expect(repoMock.updateSubtaskStatus).not.toHaveBeenCalled();

    repoMock.getSubtask.mockReturnValue({ status: "assigned" });
    markSubtaskFailed("asg-2", "循环结束未提交评审");
    expect(repoMock.updateSubtaskStatus).toHaveBeenCalledTimes(1);
    expect(repoMock.updateSubtaskStatus).toHaveBeenCalledWith(
      "asg-2",
      "failed",
      { failureReason: "循环结束未提交评审", incrementFailureCount: true },
    );
  });
});
