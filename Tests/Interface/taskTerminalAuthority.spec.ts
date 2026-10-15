/**
 * P1-7b · 任务/Agent 终态权威（REV-333 成功侧 / REV-334 / REV-336）
 *
 * 三条口径（Docs/Dev §16.3 验收标准）：
 *  ③ 派发成功 ≠ 执行完成：任务在编排真正收尾前不得显示"已完成"，
 *     且任务面板视图与 `tasks` 行只剩一个真相来源（表是终态权威）；
 *  ④ DIRECT 成功任务的 `tasks` 行必须落终态，而不是永远 `running`；
 *  ⑤ 编排收尾必须回收本次 Agent：`agents` 表不得留下
 *     `status=running` 且 `destroyed_at IS NULL` 的幽灵行。
 *
 * 驱动方式与 `Tests/Decision/orchestrationPipelines.spec.ts` 一致：
 * 派发后由测试发布子任务级 `TASK_COMPLETED(assignmentId)` 事件把计划推进到终态，
 * 真实 LLM 循环不在此文件范围内（那条链路的回归在 pipelines / realAgent 里）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { existsSync, rmSync, mkdirSync } from "node:fs";

// ── DB ────────────────────────────────────────────────
import { initDatabase, closeDatabase } from "../../Src/Infra/Db/database.js";
import {
  initMigrations,
  clearMigrations,
  migrateUp,
} from "../../Src/Infra/Db/migrations.js";
import { getTaskRow } from "../../Src/Infra/Db/Repositories/taskRepository.js";
import {
  loadAgents,
  countLiveAgentsByTrace,
} from "../../Src/Infra/Db/Repositories/agentRepository.js";
import { listSubtasksByTask } from "../../Src/Infra/Db/Repositories/subtaskRepository.js";

// ── 编排链路 ──────────────────────────────────────────
import {
  receiveTask,
  resetOrchestrator,
} from "../../Src/Core/Decision/orchestrator/orchestrator.js";
import { resetProgressTracker } from "../../Src/Core/Decision/orchestrator/progressTracker.js";
import { resetAggregator } from "../../Src/Core/Decision/orchestrator/resultAggregator.js";
import { resetDecomposer } from "../../Src/Core/Decision/TaskDecomposer/taskDecomposer.js";
import { resetAssessor } from "../../Src/Core/Decision/complexityAssessor/complexityAssessor.js";
import {
  updateRoutingRules,
  resetRoutingRules,
} from "../../Src/Core/Decision/routeDecision/routingRules.js";

// ── AgentRuntime ──────────────────────────────────────
import {
  resetAgentRegistry,
  getAgent,
} from "../../Src/Core/AgentRuntime/agentRegistry.js";
import { resetAgentFactory } from "../../Src/Core/AgentRuntime/agentFactory.js";
import { resetAgentRuntime } from "../../Src/Core/AgentRuntime/agentRuntime.js";
import { resetReviewer } from "../../Src/Services/ReviewerAgent/reviewerAgent.js";

// ── 事件 / 钱包 / 属主 / 工具 ─────────────────────────
import {
  resetEventBus,
  initEventBus,
  publish,
  createEvent,
  getEventLog,
} from "../../Src/Services/EventBus/eventBus.js";
import { EventType } from "../../Src/Services/EventBus/eventTypes.js";
import {
  resetWalletManager,
  initWalletManager,
} from "../../Src/Services/TokenEconomy/walletManager.js";
import { setActiveOwner } from "../../Src/Services/AccountScope/activeAccount.js";
import { clearRegistry } from "../../Src/Tools/Registry/toolRegistry.js";
import { registerBuiltinTools } from "../../Src/Tools/builtinLoader.js";

// ── 被测：任务 API 视图层 ─────────────────────────────
import {
  submitTask,
  listTasks,
  getTask,
  cancelTask,
  resetTaskApi,
} from "../../Src/Interface/RestApi/taskApi.js";

const DIR = resolve(import.meta.dirname, "../../Data/_test_task_terminal");
const OWNER = "alice";

/** 双域独立任务（backend + frontend → 拆解为 2 个子任务） */
const DELEGATION_DESC = "开发独立的后端 server 和前端 ui 模块";
/** 单句解释类任务（DIRECT 强控下走自指派路径） */
const DIRECT_DESC = "用一句话解释什么是函数";

function initDb(): void {
  closeDatabase();
  clearMigrations();
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  initDatabase({
    mainPath: join(DIR, "m.db"),
    eventsPath: join(DIR, "e.db"),
    memoryPath: join(DIR, "mm.db"),
    walMode: true,
    busyTimeoutMs: 5000,
  });
  initMigrations();
  const up = migrateUp();
  expect(up.ok, up.ok ? "" : String(up.error)).toBe(true);
}

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
  resetReviewer();
  clearRegistry();
  registerBuiltinTools();
  resetTaskApi();
  setActiveOwner(OWNER);
}

const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

/** DELEGATION 强控规则（与 pipelines 回归同口径） */
function forceDelegationRules(): void {
  updateRoutingRules({
    consortiumTokenThreshold: 999999,
    consortiumDomainThreshold: 99,
    assemblyLineSopRequired: false,
    delegationMaxCouplingScore: 0.5,
  });
}

/** 把一个子任务/自指派推进到终态（真实链路由 agentRuntime 提交评审时发布） */
function markAssignmentCompleted(
  taskId: string,
  assignmentId: string,
  traceId: string,
): void {
  publish(
    createEvent({
      eventType: EventType.TASK_COMPLETED,
      source: "test/taskTerminalAuthority",
      traceId,
      payload: { taskId, assignmentId },
    }),
  );
}

beforeEach(() => {
  initDb();
  fullReset();
});
afterEach(() => {
  closeDatabase();
  clearMigrations();
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════
// ③ 派发 ≠ 完成：视图层在收尾前不得显示"已完成"
// ═══════════════════════════════════════════════════════

describe("P1-7b · 派发不等于完成（REV-334）", () => {
  it("★ DELEGATION 提交后：视图与任务行都是 running，result 标明 dispatched", async () => {
    forceDelegationRules();
    const task = submitTask({
      description: DELEGATION_DESC,
      routingMode: "DELEGATION",
    });
    await flushAsync(); // 让 queueMicrotask 里的 receiveTask 跑完

    const view = getTask(task.taskId)!;
    expect(view.status).toBe("running");

    const row = getTaskRow(task.taskId)!;
    expect(row.status).toBe("running");
    expect(row.completed_at ?? null).toBe(null);

    const dispatched = JSON.parse(view.result!) as Record<string, unknown>;
    expect(dispatched.status).toBe("dispatched");
    expect(dispatched.routingMode).toBe("DELEGATION");
    expect(dispatched.assignmentCount).toBe(2);

    // 修复前的症状：派发毫秒返回就把任务标成 completed，前端变绿而子任务还在跑
    expect(view.completedAt ?? undefined).toBeUndefined();
    expect(
      listTasks({ status: "completed" }).map((t) => t.taskId),
    ).not.toContain(task.taskId);
  });

  it("★ 全部子任务终态后：视图按任务行覆盖为 completed，列表筛选也能筛出", async () => {
    forceDelegationRules();
    const task = submitTask({
      description: DELEGATION_DESC,
      routingMode: "DELEGATION",
    });
    await flushAsync();

    const subtasks = listSubtasksByTask(task.taskId);
    expect(subtasks.length).toBe(2);

    // 只完成第一个子任务：仍不得显示完成
    markAssignmentCompleted(task.taskId, subtasks[0].subtask_id, task.traceId);
    await flushAsync();
    expect(getTask(task.taskId)!.status).toBe("running");

    markAssignmentCompleted(task.taskId, subtasks[1].subtask_id, task.traceId);
    await flushAsync();

    expect(getTaskRow(task.taskId)!.status).toBe("completed");
    // 内存缓存仍停在 running（它只是派发缓存），读时必须被表的终态覆盖
    const view = getTask(task.taskId)!;
    expect(view.status).toBe("completed");
    expect(view.completedAt).toBeTruthy();
    expect(listTasks({ status: "completed" }).map((t) => t.taskId)).toContain(
      task.taskId,
    );
    expect(listTasks({ status: "running" }).map((t) => t.taskId)).not.toContain(
      task.taskId,
    );
  });

  it("取消：任务行落 cancelled，终态后不可再取消", async () => {
    forceDelegationRules();
    const task = submitTask({
      description: DELEGATION_DESC,
      routingMode: "DELEGATION",
    });
    await flushAsync();

    const cancelled = cancelTask(task.taskId)!;
    expect(cancelled.status).toBe("cancelled");
    expect(getTaskRow(task.taskId)!.status).toBe("cancelled");
    expect(cancelTask(task.taskId)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// ④ DIRECT 有真实终态路径（不再是永远 running）
// ═══════════════════════════════════════════════════════

describe("P1-7b · DIRECT 终态（REV-333 成功侧）", () => {
  it("★ DIRECT 自指派注册进计划：收尾前 running，完成后任务行落 completed", async () => {
    const TASK_ID = "task-direct-terminal";
    const TRACE_ID = "trace-direct-terminal";

    const result = receiveTask({
      taskId: TASK_ID,
      traceId: TRACE_ID,
      taskDescription: DIRECT_DESC,
      forcedMode: "DIRECT",
    });
    expect(result.ok).toBe(true);
    // 对外返回值仍不含 taskPlan（DIRECT 不拆解，见 directExecution.spec）
    if (!result.ok) return;
    expect(result.value.routingMode).toBe("DIRECT");
    expect(result.value.taskPlan).toBeUndefined();

    expect(getTaskRow(TASK_ID)!.status).toBe("running");

    // 修复前：DIRECT 没有注册 assignment/plan，最后一个终态事件不触发 finalize，
    // tasks 行永远停在 running（§16.3 ④）。现在 assignmentId = taskId。
    markAssignmentCompleted(TASK_ID, TASK_ID, TRACE_ID);
    await flushAsync();

    const row = getTaskRow(TASK_ID)!;
    expect(row.status).toBe("completed");
    expect(row.completed_at).toBeTruthy();
    const finalResult = JSON.parse(row.final_result!) as Record<
      string,
      unknown
    >;
    expect(finalResult._summary).toEqual({
      total: 1,
      success: 1,
      failed: 0,
      partial: 0,
    });
  });

  it("DIRECT 未收到终态事件时不得自行落终态", async () => {
    const TASK_ID = "task-direct-pending";
    receiveTask({
      taskId: TASK_ID,
      traceId: "trace-direct-pending",
      taskDescription: DIRECT_DESC,
      forcedMode: "DIRECT",
    });
    await flushAsync();
    expect(getTaskRow(TASK_ID)!.status).toBe("running");
  });
});

// ═══════════════════════════════════════════════════════
// ⑤ 编排收尾回收 Agent（不留幽灵行）
// ═══════════════════════════════════════════════════════

describe("P1-7b · Agent 回收（REV-336）", () => {
  it("★ DIRECT 收尾后该 trace 无存活 Agent，内存注册表同步清空", async () => {
    const TASK_ID = "task-direct-reclaim";
    const TRACE_ID = "trace-direct-reclaim";

    receiveTask({
      taskId: TASK_ID,
      traceId: TRACE_ID,
      taskDescription: DIRECT_DESC,
      forcedMode: "DIRECT",
    });
    const director = loadAgents(false).find((a) => a.trace_id === TRACE_ID)!;
    expect(director).toBeTruthy();
    expect(countLiveAgentsByTrace(TRACE_ID)).toBe(1);

    markAssignmentCompleted(TASK_ID, TASK_ID, TRACE_ID);
    await flushAsync();

    expect(countLiveAgentsByTrace(TRACE_ID)).toBe(0);
    expect(getAgent(director.agent_id)).toBeUndefined();
    const rows = loadAgents().filter((a) => a.trace_id === TRACE_ID);
    for (const r of rows) {
      expect(r.destroyed_at, `agent ${r.agent_id} 留下幽灵行`).not.toBeNull();
      expect(r.status).not.toBe("running");
    }
  });

  it("★ DELEGATION 收尾后 Director + 全部 Worker 一并回收", async () => {
    forceDelegationRules();
    const TASK_ID = "task-deleg-reclaim";
    const TRACE_ID = "trace-deleg-reclaim";

    const result = receiveTask({
      taskId: TASK_ID,
      traceId: TRACE_ID,
      taskDescription: DELEGATION_DESC,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const live = loadAgents(false).filter((a) => a.trace_id === TRACE_ID);
    // Director + 2 个 Worker
    expect(live.length).toBe(3);

    for (const assignment of result.value.taskPlan!.assignments) {
      markAssignmentCompleted(TASK_ID, assignment.assignmentId, TRACE_ID);
      await flushAsync();
    }

    expect(getTaskRow(TASK_ID)!.status).toBe("completed");
    expect(countLiveAgentsByTrace(TRACE_ID)).toBe(0);
    const rows = loadAgents().filter((a) => a.trace_id === TRACE_ID);
    for (const r of rows) {
      expect(r.destroyed_at, `agent ${r.agent_id} 留下幽灵行`).not.toBeNull();
      expect(getAgent(r.agent_id)).toBeUndefined();
    }
  });

  it("回收是收尾动作，不得反过来打断任务终态（重复 finalize 只报错不改状态）", async () => {
    const TASK_ID = "task-direct-double";
    const TRACE_ID = "trace-direct-double";

    receiveTask({
      taskId: TASK_ID,
      traceId: TRACE_ID,
      taskDescription: DIRECT_DESC,
      forcedMode: "DIRECT",
    });
    markAssignmentCompleted(TASK_ID, TASK_ID, TRACE_ID);
    await flushAsync();

    // 汇总事件（payload 不含 assignmentId）不应触发重入收尾。
    // 注意：一次收尾在链路上会产生**两条**无 assignmentId 的 TASK_COMPLETED——
    // mergePhase（FE-050 既有行为）与 finalizeOrchestration 各一条，
    // 所以要按 source 断言"收尾只跑了一次"，而不是断言总条数为 1。
    const finalizes = getEventLog().filter(
      (e) =>
        e.eventType === EventType.TASK_COMPLETED &&
        e.source === "Orchestrator/finalizeOrchestration",
    );
    expect(finalizes.length).toBe(1);
    expect(countLiveAgentsByTrace(TRACE_ID)).toBe(0);
  });
});
