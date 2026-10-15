/**
 * @module Decision/Orchestrator/orchestrator
 * @description
 * 编排器主入口——Docs/Agent/03 §3.1。
 * 端到端编排流程：接收任务 → 复杂度评估 → 路由决策 → 任务拆解 → Agent 招募 → 执行 → 结果聚合。
 *
 * 构建顺序（Docs/Agent/13 §S10）：先 DELEGATION → 再 ASSEMBLY_LINE → 最后 CONSORTIUM。
 */

import type {
  OrchestrationResult,
  ComplexityReport,
  RouteDecisionResult,
  RoutingMode,
  TaskPlan,
  TaskAssignment,
  AggregatedResult,
  SubtaskResult,
} from "../types.js";
import {
  assessComplexity,
  type AssessmentInput,
} from "../complexityAssessor/complexityAssessor.js";
import { decideRoute, forceRoute } from "../routeDecision/routeDecision.js";
import {
  decomposeTask,
  type DecomposeInput,
} from "../TaskDecomposer/taskDecomposer.js";
import { createAgent } from "../../AgentRuntime/agentFactory.js";
import {
  assignTask,
  handleAgentEvent,
} from "../../AgentRuntime/agentRuntime.js";
import { unregisterAgent } from "../../AgentRuntime/agentRegistry.js";
import { EventType } from "../../../Services/EventBus/eventTypes.js";
import type {
  DomainEvent,
  Subscription,
} from "../../../Services/EventBus/eventTypes.js";
import {
  createEvent,
  publish,
  subscribe,
} from "../../../Services/EventBus/eventBus.js";
import type { Result } from "../../../Infra/types.js";
import { ok, err } from "../../../Infra/types.js";
import { logger } from "../../../Infra/Logging/logger.js";
import {
  upsertTask,
  updateTaskRow,
} from "../../../Infra/Db/Repositories/taskRepository.js";

import { resetAggregator, aggregateResults } from "./resultAggregator.js";
import { executeMergePhase } from "./mergePhase.js";
import { dispatchSubtask, markSubtaskFailed } from "./subtaskDispatcher.js";
import {
  initProgressTracker,
  registerAssignment,
  resetProgressTracker,
  getProgress,
  getAllProgress,
  updateProgress,
  TRACKER_THRESHOLDS,
} from "./progressTracker.js";
import {
  registerDispatchPlan,
  releaseDispatchPlan,
  type PendingDispatch,
} from "./dispatchGate.js";

// ── 编排器配置 ──────────────────────────────────────────────────────

export interface OrchestratorConfig {
  defaultTokenBudget: number;
  defaultTimeLimitMs: number;
  directorModel: string;
  workerModel: string;
  maxRetries: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  defaultTokenBudget: 30000,
  defaultTimeLimitMs: 5 * 60 * 1000, // 5 分钟
  directorModel: "director-model",
  workerModel: "worker-model",
  maxRetries: 2,
};

let config: OrchestratorConfig = { ...DEFAULT_CONFIG };

export function configureOrchestrator(
  partial: Partial<OrchestratorConfig>,
): void {
  config = { ...config, ...partial };
}

// ── 活跃编排计划（FE-050：等待三链路接线后聚合）────────────────────────

const activePlans: Map<string, TaskPlan> = new Map(); // taskId → plan
const subscriptions: Subscription[] = [];
let initialized = false;

/**
 * 初始化编排事件订阅（幂等）：子任务全部进入终态后自动触发聚合。
 *
 * 订阅 TASK_COMPLETED / TASK_FAILED；子任务级事件的 payload 需携带 `assignmentId`
 * （评审通过时由 `reviewSubmission` 发布，见 AgentRuntime FE-050 对齐）。
 */
export function initOrchestrator(): void {
  if (initialized) return;
  subscriptions.push(
    subscribe(EventType.TASK_COMPLETED, (event) =>
      handleAssignmentTerminal(event),
    ),
    subscribe(EventType.TASK_FAILED, (event) =>
      handleAssignmentTerminal(event),
    ),
  );
  initialized = true;
}

function handleAssignmentTerminal(event: DomainEvent): void {
  const assignmentId = event.payload.assignmentId as string | undefined;
  if (!assignmentId) return; // 非子任务级事件（如 mergePhase 汇总事件）不触发

  // REV-344：失败侧要同步子任务台账。评审拒绝的台账由 `agent.submit_review` 工具自己写
  // （带评审意见，且发生在发布事件之后），这里再写一次会把 failure_count 双计，故排除该来源。
  if (
    event.eventType === EventType.TASK_FAILED &&
    event.source !== "AgentRuntime/reviewSubmission"
  ) {
    const reason =
      typeof event.payload.reason === "string"
        ? event.payload.reason
        : "子任务失败";
    markSubtaskFailed(assignmentId, reason);
  }

  for (const [taskId, plan] of activePlans) {
    if (!plan.assignments.some((a) => a.assignmentId === assignmentId))
      continue;
    if (allAssignmentsTerminal(plan)) {
      const result = finalizeOrchestration(taskId);
      if (!result.ok) {
        logger.warn("编排自动聚合失败", {
          source: "Orchestrator/handleAssignmentTerminal",
          taskId,
          error: result.error,
        });
      }
    }
    return;
  }
}

/**
 * P1-9 修复（控制论审查）：**两段式派发**。
 *
 * 修复前三种"多子任务"模式（DELEGATION / ASSEMBLY_LINE / CONSORTIUM）都在
 * `for (const assignment of taskPlan.assignments)` 里**无条件同步派发全部子任务**：
 *  - `dependsOn` 被计算出来后无人消费 → 依赖序不成立；
 *  - `maxParallelism` 同理 → `maxParallelism: 1` 的流水线与扇出无差别
 *    （"流水线不是流水线，是扇出"）；
 *  - 四种路由模式对真实动力学的唯一差别是创建的 Agent 角色名 → 控制增益 ≈ 0。
 *
 * 现在的语义：
 *  1. **招募阶段（立即完成）**：为每个子任务创建 Agent，写入 `assignedAgentId`——
 *     Agent 拓扑在编排返回时即可见（监控/审计/产品语义不受影响）；
 *  2. **派发阶段（受闸门约束）**：`assignTask`（ready→running）+ 落库 + 发布
 *     `TASK_ASSIGNED` 由 `dispatchGate` 按 `dependsOn` 拓扑序与 `maxParallelism`
 *     并发上限释放——**真正启动 Loop 的那一步被依赖序与并发上限约束**。
 *
 * 附带修复：`assignTask(...)` 的 `Result` 此前在三处被忽略——状态机拒绝即静默；
 * 现在失败会留痕（`logger.warn`）。
 */
function activatePlanWithGate(
  taskId: string,
  taskPlan: TaskPlan,
  params: {
    taskId: string;
    traceId: string;
    parentAgentId: string;
    source: string;
  },
  makeAgent: () => Result<{ agentId: string }>,
): void {
  // ① 招募阶段：一次性把 Agent 建齐（拓扑立即可见）
  const agentByAssignment = new Map<string, string>();
  const recruitFailed = new Set<string>();
  for (const assignment of taskPlan.assignments) {
    const agentResult = makeAgent();
    if (!agentResult.ok) {
      recruitFailed.add(assignment.assignmentId);
      logger.warn("子任务招募失败", {
        source: params.source,
        assignmentId: assignment.assignmentId,
        error: agentResult.error,
      });
      continue;
    }
    agentByAssignment.set(assignment.assignmentId, agentResult.value.agentId);
    assignment.assignedAgentId = agentResult.value.agentId;
  }

  const markFailed = (assignmentId: string, reason: string): void => {
    const assignment = taskPlan.assignments.find(
      (a) => a.assignmentId === assignmentId,
    );
    if (assignment) assignment.status = "failed";
    registerAssignment(assignment ?? ({ assignmentId } as TaskAssignment));
    updateProgress(assignmentId, null, { status: "failed" });
    logger.warn("子任务未派发即失败", {
      source: params.source,
      assignmentId,
      reason,
    });
  };

  // ② 派发阶段：受闸门约束
  const items: PendingDispatch[] = taskPlan.assignments.map((assignment) => ({
    assignmentId: assignment.assignmentId,
    dependsOn: [...(assignment.dependsOn ?? [])],
    onBlocked: (reason: string) => markFailed(assignment.assignmentId, reason),
    dispatch: () => {
      if (recruitFailed.has(assignment.assignmentId)) {
        markFailed(assignment.assignmentId, "招募失败");
        return;
      }
      const agentId = agentByAssignment.get(assignment.assignmentId);
      if (!agentId) {
        markFailed(assignment.assignmentId, "无可用 Agent");
        return;
      }

      assignment.status = "assigned";
      const assignResult = assignTask(
        agentId,
        assignment.assignmentId,
        params.traceId,
      );
      if (!assignResult.ok) {
        logger.warn("指派被状态机拒绝（此前该 Result 被静默丢弃）", {
          source: params.source,
          agentId,
          assignmentId: assignment.assignmentId,
          error: assignResult.error,
        });
      }

      // 注册进度追踪 + 子任务派发落库（subtasks 表）
      registerAssignment(assignment);
      dispatchSubtask(assignment);

      publish(
        createEvent({
          eventType: EventType.TASK_ASSIGNED,
          source: params.source,
          traceId: params.traceId,
          payload: {
            taskId: params.taskId,
            assignmentId: assignment.assignmentId,
            agentId,
            parentAgentId: params.parentAgentId,
            // REV-338：携带任务书，使后台执行驱动能用真实指令起 Loop
            instruction: assignment.description,
            maxIterations: assignment.maxIterations,
            tokenBudget: assignment.tokenBudget,
            timeLimitMs: assignment.timeLimitMs,
          },
        }),
      );
    },
  }));

  taskPlan.status = "active";
  activePlans.set(taskId, taskPlan);
  registerDispatchPlan(taskId, items, taskPlan.maxParallelism);
}

/** 计划内全部子任务是否已进入终态（completed / failed） */
function allAssignmentsTerminal(plan: TaskPlan): boolean {
  if (plan.assignments.length === 0) return false;
  const progressById = new Map(
    getAllProgress().map((p) => [p.assignmentId, p]),
  );
  return plan.assignments.every((a) => {
    const p = progressById.get(a.assignmentId);
    return !!p && (p.status === "completed" || p.status === "failed");
  });
}

/** 当前驻留的编排计划数（慢环监视 / 诊断用） */
export function getActivePlanCount(): number {
  return activePlans.size;
}

/**
 * P1-10 修复（控制论审查）：**活跃计划 TTL 看门狗**。
 *
 * 修复背景：`activePlans` 是模块级 Map，某子任务永不 `submitForReview` 时
 * 计划**永久驻留**、`tasks` 行停在 `running`，且既无看门狗也无告警——
 * 慢环（跨任务编排）完全开环。
 *
 * 判定口径：计划的"静默时长" = 其**最久未更新**的子任务进度距今的时长
 * （`progressTracker.lastProgressAt`，无需额外簿记）。超期即：
 *  1. 全部子任务已终态 → 直接聚合收尾；
 *  2. 仍有子任务在跑 → 逐个发布 `TASK_FAILED`（携带 assignmentId），
 *     由既有终态链路把子任务与任务行落终态并触发聚合。
 *
 * @returns 本次处理的计划数
 */
export function reapStalePlans(
  maxIdleMs: number = TRACKER_THRESHOLDS.stagnationTimeoutMs,
): number {
  const now = Date.now();
  const progressById = new Map(
    getAllProgress().map((p) => [p.assignmentId, p]),
  );
  let reaped = 0;

  for (const [taskId, plan] of [...activePlans]) {
    let oldest = Number.POSITIVE_INFINITY;
    for (const a of plan.assignments) {
      const p = progressById.get(a.assignmentId);
      if (p) oldest = Math.min(oldest, p.lastProgressAt);
    }
    // 无任何进度记录（刚入册）→ 视为刚开始，给一个完整 TTL 的宽限
    const idleMs = oldest === Number.POSITIVE_INFINITY ? 0 : now - oldest;
    if (idleMs < maxIdleMs) continue;

    if (allAssignmentsTerminal(plan)) {
      const result = finalizeOrchestration(taskId);
      if (result.ok) reaped += 1;
      continue;
    }

    logger.warn("编排计划静默超期，看门狗强制落终态", {
      source: "Orchestrator/reapStalePlans",
      taskId,
      idleMs,
      maxIdleMs,
      assignments: plan.assignments.length,
    });
    for (const a of plan.assignments) {
      const p = progressById.get(a.assignmentId);
      if (p && (p.status === "completed" || p.status === "failed")) continue;
      publish(
        createEvent({
          eventType: EventType.TASK_FAILED,
          source: "Orchestrator/reapStalePlans",
          traceId: a.traceId ?? "",
          payload: {
            assignmentId: a.assignmentId,
            agentId: a.assignedAgentId,
            taskId,
            reason: `编排看门狗：子任务静默超过 ${maxIdleMs}ms 未进展`,
          },
        }),
      );
    }
    reaped += 1;
  }
  return reaped;
}

/**
 * 编排收尾：聚合子任务结果 + 合并工作区（FE-050 聚合链路）。
 *
 * 触发：① 事件驱动（全部子任务终态时自动调用）；② 调用方显式调用。
 * 完成后计划出册、tasks 行回写终态，并发布不含 assignmentId 的汇总事件。
 */
export function finalizeOrchestration(
  taskId: string,
): Result<AggregatedResult> {
  const plan = activePlans.get(taskId);
  if (!plan) return err(`任务 ${taskId} 无活跃编排计划，无法聚合`);

  // [1] 从进度追踪器收集子任务结果（SubtaskResult[]）
  const subtaskResults: SubtaskResult[] = [];
  for (const assignment of plan.assignments) {
    const p = getProgress(assignment.assignmentId);
    if (!p) continue;
    subtaskResults.push({
      assignmentId: assignment.assignmentId,
      agentId: p.agentId || assignment.assignedAgentId || "",
      status:
        p.status === "completed"
          ? "success"
          : p.status === "failed"
            ? "failed"
            : "partial",
      output: {
        description: assignment.description,
        lastOutput: p.lastOutput ?? "",
      },
      tokensUsed: p.tokensUsed,
      completedAt: p.lastProgressAt,
    });
  }

  // [2] 聚合
  const aggResult = aggregateResults({ taskPlan: plan, subtaskResults });
  if (!aggResult.ok) return aggResult;

  // [3] 合并阶段（工作区产物合并 + 冲突预检；无工作区/合并失败不阻断聚合）
  const failedAgentIds = subtaskResults
    .filter((r) => r.status === "failed" && r.agentId)
    .map((r) => r.agentId);
  const mergeResult = executeMergePhase({
    taskId,
    traceId: plan.traceId,
    failedAgentIds,
  });
  if (!mergeResult.ok) {
    logger.warn("编排合并阶段失败（聚合结果不受阻）", {
      source: "Orchestrator/finalizeOrchestration",
      taskId,
      error: mergeResult.error,
    });
  }

  // [4] 终态：计划出册 + 任务行回写
  const finalStatus =
    aggResult.value.status === "failed"
      ? ("failed" as const)
      : ("completed" as const);
  plan.status = finalStatus;
  activePlans.delete(taskId);
  // P1-9：计划出册时同步释放派发闸门（避免闸门表随任务数单调增长）
  releaseDispatchPlan(taskId);
  updateTaskRow(taskId, {
    status: finalStatus,
    finalResult: JSON.stringify(aggResult.value.finalOutput),
    completedAt: Date.now(),
  });

  // [5] 回收本次编排创建的 Agent（Director + 各子任务执行者）
  //     此前编排结束后既不注销也不落终态，`agents` 表留下 status=running 且
  //     destroyed_at IS NULL 的"幽灵行"：每次重启被 hydrate 降级成 suspended 又装回内存，
  //     监控列表越用越长，`getReadyWorkers()` 还可能把上一任务的 Worker 当可用产能（REV-336）。
  releaseRunAgents(plan);

  // 汇总事件（payload 不含 assignmentId，避免事件回路重入聚合）
  publish(
    createEvent({
      eventType: EventType.TASK_COMPLETED,
      source: "Orchestrator/finalizeOrchestration",
      traceId: plan.traceId,
      payload: {
        taskId,
        status: finalStatus,
        subtaskCount: subtaskResults.length,
        totalTokensUsed: aggResult.value.totalTokensUsed,
      },
    }),
  );

  return aggResult;
}

/**
 * 回收一次编排创建的全部 Agent：Director + 每条任务书的执行者。
 *
 * 走状态机的 `DESTROY`（落 `status=destroyed` 并发布 `agent:destroyed`），再 `unregisterAgent`
 * 出内存并写 `destroyed_at`（软销毁保留审计痕迹，与既有销毁路径同构）。
 * 已不在内存 / 已处销毁态的实例只留痕不报错——回收是收尾动作，不能反过来打断任务终态。
 */
function releaseRunAgents(plan: TaskPlan): void {
  const agentIds = new Set<string>();
  if (plan.directorAgentId) agentIds.add(plan.directorAgentId);
  for (const assignment of plan.assignments) {
    if (assignment.assignedAgentId) agentIds.add(assignment.assignedAgentId);
  }

  const released: string[] = [];
  for (const agentId of agentIds) {
    const destroyed = handleAgentEvent(agentId, { type: "DESTROY" });
    const unregistered = unregisterAgent(agentId);
    if (destroyed.ok && unregistered.ok) {
      released.push(agentId);
    } else {
      logger.warn("编排收尾时 Agent 未能完整回收", {
        source: "Orchestrator/releaseRunAgents",
        taskId: plan.taskId,
        agentId,
        destroyError: destroyed.ok ? null : destroyed.error,
        unregisterError: unregistered.ok ? null : unregistered.error,
      });
    }
  }

  if (released.length > 0) {
    logger.info("编排收尾已回收 Agent", {
      source: "Orchestrator/releaseRunAgents",
      taskId: plan.taskId,
      count: released.length,
      agentIds: released,
    });
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────

/**
 * 接收任务并执行编排。
 * 端到端流程：评估 → 路由 → 拆解 → 招募 → 执行 → 聚合。
 */
export function receiveTask(params: {
  taskId: string;
  traceId: string;
  taskDescription: string;
  tokenBudget?: number;
  timeLimitMs?: number;
  /** 用户显式选择的工作方式；给定时按它编排，不再由复杂度自动决策 */
  forcedMode?: RoutingMode;
}): Result<OrchestrationResult> {
  const startedAt = Date.now();

  // 初始化进度追踪器 + 编排事件订阅（FE-050，幂等）
  initProgressTracker();
  initOrchestrator();

  // [1] 复杂度评估
  const assessInput: AssessmentInput = {
    taskDescription: params.taskDescription,
  };
  const assessResult = assessComplexity(assessInput);
  if (!assessResult.ok) {
    logger.error("复杂度评估失败，任务未进入编排", {
      source: "Orchestrator/receiveTask",
      stage: "assess",
      taskId: params.taskId,
      traceId: params.traceId,
      error: assessResult.error,
    });
    return assessResult;
  }
  const report = assessResult.value;

  // 发布任务接收事件
  publish(
    createEvent({
      eventType: EventType.TASK_RECEIVED,
      source: "Orchestrator/receiveTask",
      traceId: params.traceId,
      payload: {
        taskId: params.taskId,
        estimatedTokens: report.estimatedTokens,
      },
    }),
  );

  // [2] 路由决策
  const routeResult = params.forcedMode
    ? ok(forceRoute(params.forcedMode))
    : decideRoute(report);
  if (!routeResult.ok) {
    logger.error("路由决策失败，任务未进入编排", {
      source: "Orchestrator/receiveTask",
      stage: "route",
      taskId: params.taskId,
      traceId: params.traceId,
      error: routeResult.error,
    });
    return routeResult;
  }
  const route = routeResult.value;

  logger.info(
    params.forcedMode
      ? "路由决策由用户指定工作方式强制决定"
      : "路由决策由复杂度评估决定",
    {
      source: "Orchestrator/receiveTask",
      taskId: params.taskId,
      traceId: params.traceId,
      mode: route.mode,
      forced: !!params.forcedMode,
      reason: route.reason,
    },
  );

  // FE-050：任务落库（此前 tasks 表无写入方；subtasks 派发的外键依赖）
  upsertTask({
    taskId: params.taskId,
    traceId: params.traceId,
    userRequest: params.taskDescription,
    routeMode: route.mode,
    estimatedTokens: report.estimatedTokens,
    requiredDomains: report.requiredDomains,
    couplingScore: report.couplingScore,
    status: "running",
    createdAt: startedAt,
  });

  // [3] 根据路由模式执行
  const execResult = executeRouteMode(route, params, report, startedAt);
  if (!execResult.ok) {
    // 任务行已落库：失败必须同时留日志和回写终态，否则库里永远显示 running
    logger.error("编排执行失败", {
      source: "Orchestrator/receiveTask",
      stage: "execute",
      taskId: params.taskId,
      traceId: params.traceId,
      mode: route.mode,
      error: execResult.error,
    });
    updateTaskRow(params.taskId, {
      status: "failed",
      finalResult: execResult.error,
      completedAt: Date.now(),
    });
    return execResult;
  }
  return execResult;
}

/** [3] 路由模式分派（抽出以便 receiveTask 统一处理失败留痕） */
function executeRouteMode(
  route: RouteDecisionResult,
  params: { taskId: string; traceId: string; taskDescription: string },
  report: ComplexityReport,
  startedAt: number,
): Result<OrchestrationResult> {
  switch (route.mode) {
    case "DIRECT":
      return executeDirect(params, report, route, startedAt);
    case "DELEGATION":
      return executeDelegation(params, report, route, startedAt);
    case "ASSEMBLY_LINE":
      return executeAssemblyLine(params, report, route, startedAt);
    case "CONSORTIUM":
      return executeConsortium(params, report, route, startedAt);
    default:
      return err(`路由模式 ${route.mode} 尚未实现（S12）`);
  }
}

// ── DIRECT 模式 ─────────────────────────────────────────────────────

// DIRECT 的自指派轮次上限与拆解器给单条子任务的默认值一致（`taskDecomposer` 的 20），
// 不是新发明的数字——两处若要改必须一起改。
const DIRECT_MAX_ITERATIONS = 20;

function executeDirect(
  params: { taskId: string; traceId: string; taskDescription: string },
  _report: ComplexityReport,
  _route: RouteDecisionResult,
  startedAt: number,
): Result<OrchestrationResult> {
  // Director 直接执行——创建 Director Agent
  const directorResult = createAgent(
    { role: "prime_director", model: config.directorModel },
    params.traceId,
  );
  if (!directorResult.ok) return directorResult;

  const director = directorResult.value;
  const assignResult = assignTask(
    director.agentId,
    params.taskId,
    params.traceId,
  );
  if (!assignResult.ok) return assignResult;

  // DIRECT **不拆解**（返回值刻意不带 taskPlan），但必须登记一条"自指派任务书"：
  // 编排器只认 `activePlans` 里按 assignmentId 归属的任务书，Director 评审通过时发布的
  // `TASK_COMPLETED` 才会被接住。此前 DIRECT 什么都没登记，终态无人回写，
  // `tasks` 行便永远停在 running（REV-333 成功侧）。
  // 统一 ID 空间下 `assignmentId = taskId`，Director 的评审记录与任务天然同键。
  const assignment: TaskAssignment = {
    assignmentId: params.taskId,
    taskId: params.taskId,
    traceId: params.traceId,
    parentAgentId: director.agentId,
    subtaskIndex: 0,
    description: params.taskDescription,
    inputContext: {},
    outputSchema: {},
    maxIterations: DIRECT_MAX_ITERATIONS,
    timeLimitMs: config.defaultTimeLimitMs,
    tokenBudget: config.defaultTokenBudget,
    dependsOn: [],
    requiredTools: [],
    status: "assigned",
    assignedAgentId: director.agentId,
  };
  const plan: TaskPlan = {
    planId: `plan-${params.taskId}`,
    taskId: params.taskId,
    traceId: params.traceId,
    directorAgentId: director.agentId,
    assignments: [assignment],
    totalTokenBudget: config.defaultTokenBudget,
    globalTimeLimitMs: config.defaultTimeLimitMs,
    maxParallelism: 1,
    createdAt: startedAt,
    status: "active",
  };
  registerAssignment(assignment);
  activePlans.set(params.taskId, plan);

  // 已接收并指派完成——真正的终态由 Director 的评审结果经 finalizeOrchestration 回写
  return ok({
    taskId: params.taskId,
    traceId: params.traceId,
    routingMode: "DIRECT",
    startedAt,
    completedAt: Date.now(),
    status: "success",
  });
}

// ── DELEGATION 模式 ─────────────────────────────────────────────────

function executeDelegation(
  params: { taskId: string; traceId: string; taskDescription: string },
  report: ComplexityReport,
  _route: RouteDecisionResult,
  startedAt: number,
): Result<OrchestrationResult> {
  // 创建 Director
  const directorResult = createAgent(
    { role: "prime_director", model: config.directorModel },
    params.traceId,
  );
  if (!directorResult.ok) return directorResult;
  const director = directorResult.value;

  // 拆解任务
  const decomposeInput: DecomposeInput = {
    taskId: params.taskId,
    traceId: params.traceId,
    directorAgentId: director.agentId,
    taskDescription: params.taskDescription,
    complexityReport: report,
    totalTokenBudget: config.defaultTokenBudget,
    globalTimeLimitMs: config.defaultTimeLimitMs,
  };
  const planResult = decomposeTask(decomposeInput);
  if (!planResult.ok) return planResult;
  const taskPlan = planResult.value;

  // 发布任务拆解事件
  publish(
    createEvent({
      eventType: EventType.TASK_DECOMPOSED,
      source: "Orchestrator/executeDelegation",
      traceId: params.traceId,
      payload: {
        taskId: params.taskId,
        subtaskCount: taskPlan.assignments.length,
      },
    }),
  );

  // P1-9：招募 Worker 并按 dependsOn / maxParallelism 派发（不再是"无条件全量扇出"）
  activatePlanWithGate(
    params.taskId,
    taskPlan,
    {
      taskId: params.taskId,
      traceId: params.traceId,
      parentAgentId: director.agentId,
      source: "Orchestrator/executeDelegation",
    },
    () =>
      createAgent(
        { role: "worker", model: config.workerModel },
        params.traceId,
      ),
  );

  // Phase 0-2：返回编排结果，实际执行由 Agent 主循环驱动
  return ok({
    taskId: params.taskId,
    traceId: params.traceId,
    routingMode: "DELEGATION",
    taskPlan,
    startedAt,
    completedAt: Date.now(),
    status: "success",
  });
}

// ── ASSEMBLY_LINE 模式 ──────────────────────────────────────────────

function executeAssemblyLine(
  params: { taskId: string; traceId: string; taskDescription: string },
  report: ComplexityReport,
  _route: RouteDecisionResult,
  startedAt: number,
): Result<OrchestrationResult> {
  // 创建 Director
  const directorResult = createAgent(
    { role: "prime_director", model: config.directorModel },
    params.traceId,
  );
  if (!directorResult.ok) return directorResult;
  const director = directorResult.value;

  // 拆解为流水线节点（每个节点 = 一个 Agent）
  const decomposeInput: DecomposeInput = {
    taskId: params.taskId,
    traceId: params.traceId,
    directorAgentId: director.agentId,
    taskDescription: params.taskDescription,
    complexityReport: report,
    totalTokenBudget: config.defaultTokenBudget,
    globalTimeLimitMs: config.defaultTimeLimitMs,
    maxParallelism: 1, // 流水线串行
  };
  const planResult = decomposeTask(decomposeInput);
  if (!planResult.ok) return planResult;
  const taskPlan = planResult.value;

  // 流水线：每个节点依赖前一个
  for (let i = 1; i < taskPlan.assignments.length; i++) {
    const curr = taskPlan.assignments[i];
    const prev = taskPlan.assignments[i - 1];
    if (curr && prev) curr.dependsOn = [prev.assignmentId];
  }

  // P1-9：流水线节点按 dependsOn 串行释放（maxParallelism=1）——"流水线不再是扇出"
  activatePlanWithGate(
    params.taskId,
    taskPlan,
    {
      taskId: params.taskId,
      traceId: params.traceId,
      parentAgentId: director.agentId,
      source: "Orchestrator/executeAssemblyLine",
    },
    () =>
      createAgent(
        { role: "worker", model: config.workerModel },
        params.traceId,
      ),
  );

  return ok({
    taskId: params.taskId,
    traceId: params.traceId,
    routingMode: "ASSEMBLY_LINE",
    taskPlan,
    startedAt,
    completedAt: Date.now(),
    status: "success",
  });
}

// ── CONSORTIUM 模式 ─────────────────────────────────────────────────

function executeConsortium(
  params: { taskId: string; traceId: string; taskDescription: string },
  report: ComplexityReport,
  _route: RouteDecisionResult,
  startedAt: number,
): Result<OrchestrationResult> {
  // 创建 Director
  const directorResult = createAgent(
    { role: "prime_director", model: config.directorModel },
    params.traceId,
  );
  if (!directorResult.ok) return directorResult;
  const director = directorResult.value;

  // 拆解任务
  const decomposeInput: DecomposeInput = {
    taskId: params.taskId,
    traceId: params.traceId,
    directorAgentId: director.agentId,
    taskDescription: params.taskDescription,
    complexityReport: report,
    totalTokenBudget: config.defaultTokenBudget,
    globalTimeLimitMs: config.defaultTimeLimitMs,
  };
  const planResult = decomposeTask(decomposeInput);
  if (!planResult.ok) return planResult;
  const taskPlan = planResult.value;

  // P1-9：攻坚 Partner 按 dependsOn / maxParallelism 派发
  activatePlanWithGate(
    params.taskId,
    taskPlan,
    {
      taskId: params.taskId,
      traceId: params.traceId,
      parentAgentId: director.agentId,
      source: "Orchestrator/executeConsortium",
    },
    () =>
      createAgent(
        { role: "partner", model: config.workerModel },
        params.traceId,
      ),
  );

  return ok({
    taskId: params.taskId,
    traceId: params.traceId,
    routingMode: "CONSORTIUM",
    taskPlan,
    startedAt,
    completedAt: Date.now(),
    status: "success",
  });
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetOrchestrator(): void {
  config = { ...DEFAULT_CONFIG };
  resetProgressTracker();
  resetAggregator();
  activePlans.clear();
  for (const sub of subscriptions) sub.unsubscribe();
  subscriptions.length = 0;
  initialized = false;
}
