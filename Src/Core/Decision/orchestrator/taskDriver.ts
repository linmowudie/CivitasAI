/**
 * @module Decision/orchestrator/taskDriver
 * @description
 * 派发后台执行驱动（REV-338 实装，2026-10-09）。
 *
 * 修复背景：编排的 DELEGATION / ASSEMBLY_LINE / CONSORTIUM 三模式在 `receiveTask` 里
 * 完成"招募 + 指派 + 落库 + 发布 `task:assigned`"后即返回 `dispatched`，**全仓无 `task:assigned`
 * 订阅者**——Worker 从未被真正驱动，只能靠人工 `POST /api/agents/:agentId/execute` 补跑。
 * 后果链：子任务不产终态 → 编排不聚合 → `tasks` 行长停 running → Agent 不回收（REV-333/336）。
 *
 * 设计取舍（与用户已定的"提交后台任务并回执"语义一致）：
 * - **串行队列**：按派发入队顺序一次跑一个 Loop。ASSEMBLY_LINE 的节点顺序即发布顺序，
 *   串行天然保持流水线语义；DELEGATION 的并行产能在此换来可预测的预算与限流压力。
 * - **只认派发侧事件**：`payload.assignmentId` 是编排器发布独有字段（`AgentRuntime/assignTask`
 *   的同名事件不带），据此过滤避免同一指派被驱动两次。
 * - **显式装配**：由组合根 `main.ts` 调用 `initTaskDriver()`。放在 `initOrchestrator()` 里会让
 *   既有编排单测真实起 Loop，测试环境不应有网络副作用。
 * - 驱动失败只记日志不回抛：Loop 终态事件（REV-339 的 `task:failed`）已负责让计划收尾。
 */

import { EventType } from "../../../Services/EventBus/eventTypes.js";
import type {
  DomainEvent,
  Subscription,
} from "../../../Services/EventBus/eventTypes.js";
import { subscribe } from "../../../Services/EventBus/eventBus.js";
import { logger } from "../../../Infra/Logging/logger.js";
import { executeAssignedTask } from "../../AgentRuntime/agentExecutor.js";

import { markSubtaskStarted } from "./subtaskDispatcher.js";

let subscription: Subscription | null = null;
let tail: Promise<void> = Promise.resolve();
const driven = new Set<string>(); // assignmentId → 已入队（幂等护栏）

function enqueue(event: DomainEvent): void {
  const assignmentId = event.payload.assignmentId as string | undefined;
  const agentId = event.payload.agentId as string | undefined;
  if (!assignmentId || !agentId) return; // 非派发侧事件（assignTask / 汇总）不驱动
  if (driven.has(assignmentId)) return;
  driven.add(assignmentId);

  const instruction =
    typeof event.payload.instruction === "string"
      ? event.payload.instruction
      : undefined;
  // 任务书规定的迭代上限与 token 预算必须生效，否则 Worker 会跑默认 max_iterations，
  // 并且按 `LoopConfig` 默认 100000 花费——台账记 15000 却实花 416907（REV-338/345 取证）。
  const positiveNumber = (v: unknown): number | undefined =>
    typeof v === "number" && v > 0 ? v : undefined;
  const maxIterations = positiveNumber(event.payload.maxIterations);
  const tokenBudget = positiveNumber(event.payload.tokenBudget);
  const timeLimitMs = positiveNumber(event.payload.timeLimitMs);

  tail = tail.then(async () => {
    try {
      // 台账先转执行中：`in_progress` 是唯一写 `started_at` 的状态（REV-347），
      // 没有这一步，子任务只有"已派发 → 已终态"两格，实际耗时与超时判定都无从审计。
      markSubtaskStarted(assignmentId);
      const result = await executeAssignedTask({
        agentId,
        instruction,
        maxIterations,
        tokenBudget,
        timeLimitMs,
      });
      if (!result.ok) {
        logger.warn("后台执行驱动失败（子任务由 task:failed 收尾）", {
          source: "Orchestrator/taskDriver",
          agentId,
          assignmentId,
          error: result.error,
        });
      } else {
        logger.info("后台执行驱动完成", {
          source: "Orchestrator/taskDriver",
          agentId,
          assignmentId,
          exitReason: result.value.exitReason,
          iterations: result.value.iterations,
          tokensConsumed: result.value.tokensConsumed,
        });
      }
    } catch (e) {
      logger.error("后台执行驱动异常", {
        source: "Orchestrator/taskDriver",
        agentId,
        assignmentId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

/** 装配派发驱动（幂等） */
export function initTaskDriver(): Subscription {
  if (subscription) return subscription;
  subscription = subscribe(EventType.TASK_ASSIGNED, enqueue);
  logger.info("派发后台执行驱动已装配", { source: "Orchestrator/taskDriver" });
  return subscription;
}

/** 释放订阅并清空队列与幂等集（测试/关停用） */
export function resetTaskDriver(): void {
  if (subscription) {
    subscription.unsubscribe();
    subscription = null;
  }
  driven.clear();
  tail = Promise.resolve();
}

/** 等待当前队列排空（取证/关停用） */
export function drainTaskDriver(): Promise<void> {
  return tail;
}
