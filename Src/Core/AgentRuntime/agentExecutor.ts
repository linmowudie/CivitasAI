/**
 * @module AgentRuntime/agentExecutor
 * @description
 * Agent 任务执行入口（FE-072 实装）——把"已登记任务"的 Agent 真正驱动起来。
 *
 * 修复背景：`AgentRecruit`（及编排）创建的 Agent 登记 `lastTaskId` 后**无执行驱动**
 * （recruit 工具返回值自陈 `dispatch: 'pending'`——"派发执行由编排调度负责"，而该链路缺失）。
 * 现提供最小执行链路：构造 Loop 配置与状态 → `executeLoop` 真实执行 → 状态回写。
 *
 * 边界（诚实说明）：同步等待整轮 Loop 完成（REST 端点语义）；长任务/并发调度
 * 建议后续接异步任务队列（当前复用 middleware 注册与既有中断语义）。
 */

import { EventType } from "../../Services/EventBus/eventTypes.js";
import { createEvent, publish } from "../../Services/EventBus/eventBus.js";
import { createLoopConfig, getLoopLimits } from "../Loop/loopConfig.js";
import { createLoopState } from "../Loop/loopEngine.js";
import { executeLoop } from "../Loop/runIteration.js";
import {
  resolveModel,
  getRoutingConfig,
} from "../../Infra/Llm/Router/modelRouter.js";
import { logger } from "../../Infra/Logging/logger.js";
import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

import { assignTask, getPendingReview } from "./agentRuntime.js";
import { getAgent } from "./agentRegistry.js";
import {
  isOrchestrationKernelEnabled,
  runL1Dialogue,
} from "../Orchestration/l1Entry.js";

export interface AgentExecutionResult {
  agentId: string;
  loopId: string;
  traceId: string;
  exitReason?: string;
  iterations: number;
  tokensConsumed: number;
  output: string;
}

/**
 * 发布子任务失败终态事件（REV-339）。
 *
 * `payload.assignmentId` 是编排聚合与进度追踪器唯一的认领键（统一 ID 空间：
 * `subtask_id = assignmentId = agent.lastTaskId`）；缺它则事件被 `handleAssignmentTerminal`
 * 当作汇总事件丢弃，`tasks` 行停在 running、Agent 也不回收。
 */
function publishSubtaskFailure(
  assignmentId: string,
  agentId: string,
  traceId: string,
  reason: string,
): void {
  publish(
    createEvent({
      eventType: EventType.TASK_FAILED,
      source: "AgentRuntime/executeAssignedTask",
      traceId,
      payload: {
        taskId: assignmentId,
        assignmentId,
        workerAgentId: agentId,
        reason,
      },
    }),
  );
}

/**
 * 驱动指定 Agent 执行其已登记任务（或由 `instruction` 显式指定指令）。
 * @returns 执行结果；Agent 不存在/终态/配置非法时返回错误
 */
export async function executeAssignedTask(params: {
  agentId: string;
  instruction?: string;
  model?: string;
  maxIterations?: number;
  tokenBudget?: number;
  timeLimitMs?: number;
  /**
   * 恢复续跑：从断点快照带回的对话内容（AG-BEN-RESUME / 崩溃恢复）。
   * 提供时 Loop 以该历史为起点继续，而不是重新从一句 instruction 开始。
   */
  chatMessages?: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_call_id?: string;
    tool_calls?: unknown;
  }>;
  /** 恢复续跑：断点轮次（用于说明与审计） */
  resumedFromIteration?: number;
}): Promise<Result<AgentExecutionResult>> {
  const agent = getAgent(params.agentId);
  if (!agent) return err(`Agent ${params.agentId} 不存在`);
  if (
    agent.status === "destroyed" ||
    agent.status === "expelled" ||
    agent.status === "suspended"
  ) {
    return err(`Agent ${params.agentId} 状态 ${agent.status}，不可执行`);
  }

  // FE-072：模型解析——agent.model 为占位符（'worker-model' 等）或未注册时，
  //   回退到 routing 的 worker/default 模型（历史数据与 orchestrator 占位都可驱动执行）
  let model = params.model ?? agent.model;
  if (!model || !resolveModel(model).ok) {
    const routing = getRoutingConfig();
    const fallback = routing?.workerModel || routing?.defaultModel;
    if (fallback && resolveModel(fallback).ok) {
      model = fallback;
    }
  }
  // 任务书墙钟时限（`subtasks.timeout_ms`）此前从未透传，Loop 一直按 DEFAULT 的 60s 跑，
  // 台账里的 150s 时限只是记录。越界时钳到 LOOP_LIMITS 合法窗口并留痕，不静默丢弃。
  let timeoutMs: number | undefined;
  if (params.timeLimitMs !== undefined && params.timeLimitMs > 0) {
    const limits = getLoopLimits();
    timeoutMs = Math.min(
      Math.max(params.timeLimitMs, limits.minTimeoutMs),
      limits.maxTimeoutMs,
    );
    if (timeoutMs !== params.timeLimitMs) {
      logger.warn("任务书时限超出 Loop 合法窗口，已按边界钳制", {
        source: "AgentRuntime/executeAssignedTask",
        agentId: params.agentId,
        requested: params.timeLimitMs,
        applied: timeoutMs,
      });
    }
  }

  const configResult = createLoopConfig({
    model,
    stream: false,
    ...(params.maxIterations !== undefined
      ? { max_iterations: params.maxIterations }
      : {}),
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    // REV-338 同源问题：任务书规定的 token 预算必须进 Loop，否则 `subtasks.token_budget`
    // 记 15000 而运行时按默认 100000 花费（本次取证实测单轮 20.8 万 token）。
    ...(params.tokenBudget !== undefined && params.tokenBudget >= 1
      ? { token_budget: params.tokenBudget }
      : {}),
  });
  if (!configResult.ok) return err(configResult.error);

  const loopId = `loop-exec-${params.agentId}-${Date.now()}`;
  // REV-340：复用 Agent 在册 traceId（recruit/编排 `assignTask` 时写入），无 trace 才新建。
  //   此前每次执行都造 `trace-exec-<time>`：评审侧 `ensureReviewerAgent(traceId)` 按 traceId
  //   复用 Reviewer，新 trace 必然新建一名 Reviewer Agent——同一 Worker 反复执行即在 `agents`
  //   表和监控列表留下一串无主 reviewer 行。
  const traceId = agent.traceId || `trace-exec-${Date.now().toString(36)}`;
  const assignedTaskId =
    agent.lastTaskId ?? `task-adhoc-${Date.now().toString(36)}`;

  // ready → running（未登记任务号时兜底生成，保证状态机可流转）
  if (agent.status === "ready") {
    assignTask(params.agentId, assignedTaskId, traceId);
  }

  const instruction =
    params.instruction ??
    (params.resumedFromIteration !== undefined
      ? `从第 ${params.resumedFromIteration} 轮断点继续执行未完成任务；保持原目标不变。`
      : `执行你被分配的任务（taskId=${assignedTaskId}）。` +
        "若任务详情不可见，请基于你的角色职责与已登记约束继续。");

  // ── P2 融合（flag 默认关闭）：L1 角色任务走**编排内核外层循环**；
  //    worker 不变；内层执行仍是 legacy runIteration。关闭时与旧行为完全一致。
  if (
    isOrchestrationKernelEnabled() &&
    (agent.role === "partner" || agent.role === "prime_director")
  ) {
    const orchestrated = await runL1Dialogue({
      agentId: params.agentId,
      traceId,
      task: instruction,
    });
    if (!orchestrated.ok) {
      return err(`编排内核执行失败：${orchestrated.error}`);
    }
    const outcome = orchestrated.value;
    logger.info("L1 任务经编排内核完成", {
      source: "AgentRuntime/executeAssignedTask",
      agentId: params.agentId,
      loopId: outcome.loopId,
      state: outcome.state,
      cycles: outcome.cycles,
    });
    return ok({
      agentId: params.agentId,
      loopId: outcome.loopId,
      traceId,
      exitReason: outcome.state === "domain_complete" ? "success" : "degraded",
      iterations: outcome.cycles,
      tokensConsumed: outcome.tokensConsumed,
      output: JSON.stringify({
        state: outcome.state,
        gaps: outcome.gaps,
        assemblyId: outcome.assemblyId,
      }),
    });
  }

  const loopState = createLoopState({
    loopId,
    agentId: params.agentId,
    traceId,
    config: configResult.value,
  });

  const result = await executeLoop(loopState, {
    userInput: instruction,
    sessionId: `agent-exec-${params.agentId}`,
    agentId: params.agentId,
    agentRole: agent.role,
    config: configResult.value,
    // 恢复续跑：有断点对话就以它为起点（真正"接着说"），否则从一句 instruction 开始
    chatMessages:
      params.chatMessages && params.chatMessages.length > 0
        ? (params.chatMessages as never)
        : [{ role: "user", content: instruction }],
    recentCallTimestamps: [],
    // ── P1-10：**进展信号发布方** ──
    // 修复前 `EventType.TASK_PROGRESS` 只有订阅方（progressTracker）没有发布方，
    // 于是 `currentIteration` / `tokensUsed` 恒为 0——停滞判定唯一可用的"进展"信号
    // 根本进不来。这里在每轮迭代完成时发布真实进展（带 assignmentId 与 tokensUsed）。
    onIterationComplete: (info) => {
      publish(
        createEvent({
          eventType: EventType.TASK_PROGRESS,
          source: "AgentRuntime/agentExecutor",
          traceId,
          payload: {
            assignmentId: assignedTaskId,
            agentId: params.agentId,
            iteration: info.iteration,
            tokensUsed: info.tokensConsumed,
          },
        }),
      );
    },
  });
  if (!result.ok) {
    // REV-339：Loop 失败同样要让子任务进终态，否则 `tasks` 行停在 running。
    publishSubtaskFailure(
      assignedTaskId,
      params.agentId,
      traceId,
      `Loop 执行失败: ${result.error}`,
    );
    return err(result.error);
  }

  // REV-339：核心规则是"Worker 不可自行宣告完成"——没有评审记录就没有通过的可能，
  // 该子任务按失败进终态。有评审记录时不在此重复发布（accepted→TASK_COMPLETED、
  // rejected→TASK_FAILED 已由 `reviewSubmission` 发出）。
  if (!getPendingReview(assignedTaskId)) {
    const last = result.value.iterations[result.value.iterations.length - 1];
    publishSubtaskFailure(
      assignedTaskId,
      params.agentId,
      traceId,
      `循环结束未提交评审（exitReason=${result.value.exitReason ?? "unknown"}` +
        ` iterations=${result.value.iterations.length}` +
        ` output=${String(last?.outputText ?? "").slice(0, 120)}）`,
    );
  }

  const last = result.value.iterations[result.value.iterations.length - 1];
  return ok({
    agentId: params.agentId,
    loopId,
    traceId,
    exitReason: result.value.exitReason,
    iterations: result.value.iterations.length,
    tokensConsumed: result.value.totalTokensConsumed,
    output: last?.outputText ?? "",
  });
}
