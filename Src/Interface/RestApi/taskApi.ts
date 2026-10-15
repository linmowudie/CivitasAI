/**
 * @module Interface/RestApi/taskApi
 * @description
 * 任务 API——Docs/Client/01 §2.2。
 * 任务提交 / 查询 / 详情 / 取消。前端全部走服务接口，无直连 Infra。
 * F0.5：POST 触发 orchestrator.receiveTask()；DELETE 取消任务。
 */

import { v4 as uuidv4 } from "uuid";

import { receiveTask } from "../../Core/Decision/orchestrator/orchestrator.js";
import type { RoutingMode } from "../../Core/Decision/types.js";
import {
  getTaskRow,
  updateTaskRow,
} from "../../Infra/Db/Repositories/taskRepository.js";

import { json, apiError, registerRoute } from "./router.js";

// ── 任务提交 ────────────────────────────────────────────────────────

// 任务存储（Phase 0-2 内存；Phase 3 持久化）
const tasks: Map<string, TaskRecord> = new Map();

/**
 * 编排器当前**真的有执行分支**的工作方式。
 * LITIGATION / REGULATION 在 `RoutingMode` 里存在，但 orchestrator 的 switch
 * 仍落到 default（S12 未实现）——不能让界面选了个只会失败的模式。
 */
export const SUBMITTABLE_MODES: readonly RoutingMode[] = [
  "DIRECT",
  "DELEGATION",
  "ASSEMBLY_LINE",
  "CONSORTIUM",
];

export function isSubmittableMode(value: unknown): value is RoutingMode {
  return (
    typeof value === "string" &&
    (SUBMITTABLE_MODES as readonly string[]).includes(value)
  );
}

export interface TaskRecord {
  taskId: string;
  traceId: string;
  description: string;
  status: "submitted" | "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
  result?: string;
  /** 用户指定的工作方式；缺省表示交给复杂度评估自动决定 */
  routingMode?: RoutingMode;
}

/** 终态：到达后不再被任何一侧改写 */
const TERMINAL_STATUSES: ReadonlySet<TaskRecord["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** `tasks` 表的状态字面量 → 任务面板用的状态 */
const DB_STATUS_TO_RECORD: Record<string, TaskRecord["status"]> = {
  pending: "submitted",
  running: "running",
  in_progress: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * 用 `tasks` 表补齐终态——**表是终态权威，内存只是本进程的派发缓存**。
 *
 * 为什么：编排的终态只有一个写入口（`finalizeOrchestration` / 失败分支都回写表），
 * 而 `receiveTask` 的同步返回值只代表"派发到了哪一步"。此前这里按返回值直接标 completed，
 * 多 Agent 模式下几毫秒就变绿、子任务随后仍在跑（REV-334）；反过来表已是 running
 * 而内存说"已完成"也对不上。读时按表覆盖，两侧便只剩一个真相来源。
 * 库不可用（`getTaskRow` 返回 undefined）时如实保留内存视图，不猜测。
 */
function withAuthoritativeState(t: TaskRecord): TaskRecord {
  if (TERMINAL_STATUSES.has(t.status)) return { ...t };
  const row = getTaskRow(t.taskId);
  const status = row ? DB_STATUS_TO_RECORD[row.status] : undefined;
  if (!row || !status || !TERMINAL_STATUSES.has(status)) return { ...t };
  return {
    ...t,
    status,
    completedAt: row.completed_at ?? t.completedAt,
    result: row.final_result ?? t.result,
  };
}

/**
 * POST /api/tasks — 提交任务（F0.5：触发 orchestrator 执行）
 */
export function submitTask(params: {
  description: string;
  routingMode?: RoutingMode;
}): TaskRecord {
  const taskId = `task-${uuidv4().slice(0, 8)}`;
  const traceId = uuidv4();
  const task: TaskRecord = {
    taskId,
    traceId,
    description: params.description,
    status: "submitted",
    createdAt: Date.now(),
    routingMode: params.routingMode,
  };
  tasks.set(task.taskId, task);

  // 异步触发编排（不阻塞 HTTP 响应，执行结果由事件流反馈）
  queueMicrotask(() => {
    task.status = "running";
    const result = receiveTask({
      taskId,
      traceId,
      taskDescription: params.description,
      forcedMode: params.routingMode,
    });
    if (result.ok) {
      // **派发成功 ≠ 执行完成**：子任务/评审还在跑，终态由 `tasks` 表回写、
      // 前端经 `task:*` 事件重新拉取（见 withAuthoritativeState）。
      task.completedAt = undefined;
      task.result = JSON.stringify({
        status: "dispatched",
        routingMode: result.value.routingMode,
        ...(result.value.taskPlan
          ? { assignmentCount: result.value.taskPlan.assignments.length }
          : {}),
      });
    } else {
      task.status = "failed";
      task.completedAt = Date.now();
      task.result = result.error;
    }
  });

  return {
    taskId,
    traceId,
    description: params.description,
    status: "submitted",
    createdAt: task.createdAt,
    routingMode: task.routingMode,
  };
}

/**
 * GET /api/tasks — 查询任务列表
 */
export function listTasks(filter?: { status?: string }): TaskRecord[] {
  // 先套权威视图再筛选：反过来（先按内存状态筛）会把"内存还 running、库里已 completed"
  // 的任务在映射前就剔除掉，终态权威在这条路径上等于没生效。
  const viewed = [...tasks.values()].map(withAuthoritativeState);
  return filter?.status
    ? viewed.filter((t) => t.status === filter.status)
    : viewed;
}

/**
 * GET /api/tasks/:taskId — 查询任务详情
 */
export function getTask(taskId: string): TaskRecord | undefined {
  const t = tasks.get(taskId);
  return t ? withAuthoritativeState(t) : undefined;
}

/**
 * DELETE /api/tasks/:taskId — 取消任务（F0.5）
 *
 * 台账口径：取消只把任务行标成 `cancelled`，**不中断已在跑的 Loop**（Phase 0-2 无中断通道）。
 */
export function cancelTask(taskId: string): TaskRecord | undefined {
  const t = tasks.get(taskId);
  if (!t) return undefined;
  const current = withAuthoritativeState(t);
  if (TERMINAL_STATUSES.has(current.status)) return undefined; // 终态不可取消
  t.completedAt = Date.now();
  t.result = "cancelled_by_user";
  updateTaskRow(taskId, {
    status: "cancelled",
    finalResult: t.result,
    completedAt: t.completedAt,
  });
  const authoritative = withAuthoritativeState(t);
  // 表里已到终态就按表（并发下可能刚被 finalize 掉），库不可用时才退回本地台账
  t.status = TERMINAL_STATUSES.has(authoritative.status)
    ? authoritative.status
    : "cancelled";
  return { ...t };
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerTaskRoutes(): void {
  registerRoute("POST", "/api/tasks", async (req) => {
    const desc = req.body?.description as string;
    if (!desc) return apiError("description is required");

    const rawMode = req.body?.routingMode;
    const hasMode = rawMode !== undefined && rawMode !== null && rawMode !== "";
    if (hasMode && !isSubmittableMode(rawMode)) {
      return apiError(
        `routingMode 不可执行：${String(rawMode)}。可选 ${SUBMITTABLE_MODES.join(" / ")}；` +
          "LITIGATION / REGULATION 编排器尚未实现（S12）",
        400,
      );
    }

    const task = submitTask({
      description: desc,
      routingMode: isSubmittableMode(rawMode) ? rawMode : undefined,
    });
    return json(task, 201);
  });

  registerRoute("GET", "/api/tasks", async (req) => {
    const filter = req.query.status ? { status: req.query.status } : undefined;
    return json(listTasks(filter));
  });

  registerRoute("GET", "/api/tasks/:taskId", async (req) => {
    const taskId = req.params.taskId;
    if (!taskId) return apiError("taskId is required", 400);
    const task = getTask(taskId);
    if (!task) return apiError("Task not found", 404);
    return json(task);
  });

  // F0.5：取消任务
  registerRoute("DELETE", "/api/tasks/:taskId", async (req) => {
    const taskId = req.params.taskId;
    if (!taskId) return apiError("taskId is required", 400);
    const task = cancelTask(taskId);
    if (!task) return apiError("Task not found or already terminal", 404);
    return json(task);
  });
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetTaskApi(): void {
  tasks.clear();
}
