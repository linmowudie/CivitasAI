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
  TaskPlan,
  AggregatedResult,
  SubtaskResult,
} from '../types.js';
import { assessComplexity, type AssessmentInput } from '../complexityAssessor/complexityAssessor.js';
import { decideRoute } from '../routeDecision/routeDecision.js';
import { decomposeTask, type DecomposeInput } from '../TaskDecomposer/taskDecomposer.js';
import { createAgent } from '../../AgentRuntime/agentFactory.js';
import { assignTask } from '../../AgentRuntime/agentRuntime.js';
import { EventType } from '../../../Services/EventBus/eventTypes.js';
import type { DomainEvent, Subscription } from '../../../Services/EventBus/eventTypes.js';
import { createEvent, publish, subscribe } from '../../../Services/EventBus/eventBus.js';
import type { Result } from '../../../Infra/types.js';
import { ok, err } from '../../../Infra/types.js';
import { logger } from '../../../Infra/Logging/logger.js';
import { upsertTask, updateTaskRow } from '../../../Infra/Db/Repositories/taskRepository.js';

import { resetAggregator, aggregateResults } from './resultAggregator.js';
import { executeMergePhase } from './mergePhase.js';
import { dispatchSubtask } from './subtaskDispatcher.js';
import {
  initProgressTracker,
  registerAssignment,
  resetProgressTracker,
  getProgress,
  getAllProgress,
  updateProgress,
} from './progressTracker.js';

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
  directorModel: 'director-model',
  workerModel: 'worker-model',
  maxRetries: 2,
};

let config: OrchestratorConfig = { ...DEFAULT_CONFIG };

export function configureOrchestrator(partial: Partial<OrchestratorConfig>): void {
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
    subscribe(EventType.TASK_COMPLETED, (event) => handleAssignmentTerminal(event)),
    subscribe(EventType.TASK_FAILED, (event) => handleAssignmentTerminal(event)),
  );
  initialized = true;
}

function handleAssignmentTerminal(event: DomainEvent): void {
  const assignmentId = event.payload.assignmentId as string | undefined;
  if (!assignmentId) return; // 非子任务级事件（如 mergePhase 汇总事件）不触发

  for (const [taskId, plan] of activePlans) {
    if (!plan.assignments.some(a => a.assignmentId === assignmentId)) continue;
    if (allAssignmentsTerminal(plan)) {
      const result = finalizeOrchestration(taskId);
      if (!result.ok) {
        logger.warn('编排自动聚合失败', {
          source: 'Orchestrator/handleAssignmentTerminal',
          taskId,
          error: result.error,
        });
      }
    }
    return;
  }
}

/** 计划内全部子任务是否已进入终态（completed / failed） */
function allAssignmentsTerminal(plan: TaskPlan): boolean {
  if (plan.assignments.length === 0) return false;
  const progressById = new Map(getAllProgress().map(p => [p.assignmentId, p]));
  return plan.assignments.every(a => {
    const p = progressById.get(a.assignmentId);
    return !!p && (p.status === 'completed' || p.status === 'failed');
  });
}

/**
 * 编排收尾：聚合子任务结果 + 合并工作区（FE-050 聚合链路）。
 *
 * 触发：① 事件驱动（全部子任务终态时自动调用）；② 调用方显式调用。
 * 完成后计划出册、tasks 行回写终态，并发布不含 assignmentId 的汇总事件。
 */
export function finalizeOrchestration(taskId: string): Result<AggregatedResult> {
  const plan = activePlans.get(taskId);
  if (!plan) return err(`任务 ${taskId} 无活跃编排计划，无法聚合`);

  // [1] 从进度追踪器收集子任务结果（SubtaskResult[]）
  const subtaskResults: SubtaskResult[] = [];
  for (const assignment of plan.assignments) {
    const p = getProgress(assignment.assignmentId);
    if (!p) continue;
    subtaskResults.push({
      assignmentId: assignment.assignmentId,
      agentId: p.agentId || assignment.assignedAgentId || '',
      status: p.status === 'completed' ? 'success' : p.status === 'failed' ? 'failed' : 'partial',
      output: { description: assignment.description, lastOutput: p.lastOutput ?? '' },
      tokensUsed: p.tokensUsed,
      completedAt: p.lastProgressAt,
    });
  }

  // [2] 聚合
  const aggResult = aggregateResults({ taskPlan: plan, subtaskResults });
  if (!aggResult.ok) return aggResult;

  // [3] 合并阶段（工作区产物合并 + 冲突预检；无工作区/合并失败不阻断聚合）
  const failedAgentIds = subtaskResults
    .filter(r => r.status === 'failed' && r.agentId)
    .map(r => r.agentId);
  const mergeResult = executeMergePhase({ taskId, traceId: plan.traceId, failedAgentIds });
  if (!mergeResult.ok) {
    logger.warn('编排合并阶段失败（聚合结果不受阻）', {
      source: 'Orchestrator/finalizeOrchestration',
      taskId,
      error: mergeResult.error,
    });
  }

  // [4] 终态：计划出册 + 任务行回写
  const finalStatus = aggResult.value.status === 'failed' ? 'failed' as const : 'completed' as const;
  plan.status = finalStatus;
  activePlans.delete(taskId);
  updateTaskRow(taskId, {
    status: finalStatus,
    finalResult: JSON.stringify(aggResult.value.finalOutput),
    completedAt: Date.now(),
  });

  // 汇总事件（payload 不含 assignmentId，避免事件回路重入聚合）
  publish(createEvent({
    eventType: EventType.TASK_COMPLETED,
    source: 'Orchestrator/finalizeOrchestration',
    traceId: plan.traceId,
    payload: {
      taskId,
      status: finalStatus,
      subtaskCount: subtaskResults.length,
      totalTokensUsed: aggResult.value.totalTokensUsed,
    },
  }));

  return aggResult;
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
}): Result<OrchestrationResult> {
  const startedAt = Date.now();

  // 初始化进度追踪器 + 编排事件订阅（FE-050，幂等）
  initProgressTracker();
  initOrchestrator();

  // [1] 复杂度评估
  const assessInput: AssessmentInput = { taskDescription: params.taskDescription };
  const assessResult = assessComplexity(assessInput);
  if (!assessResult.ok) return assessResult;
  const report = assessResult.value;

  // 发布任务接收事件
  publish(createEvent({
    eventType: EventType.TASK_RECEIVED,
    source: 'Orchestrator/receiveTask',
    traceId: params.traceId,
    payload: { taskId: params.taskId, estimatedTokens: report.estimatedTokens },
  }));

  // [2] 路由决策
  const routeResult = decideRoute(report);
  if (!routeResult.ok) return routeResult;
  const route = routeResult.value;

  // FE-050：任务落库（此前 tasks 表无写入方；subtasks 派发的外键依赖）
  upsertTask({
    taskId: params.taskId,
    traceId: params.traceId,
    userRequest: params.taskDescription,
    routeMode: route.mode,
    estimatedTokens: report.estimatedTokens,
    requiredDomains: report.requiredDomains,
    couplingScore: report.couplingScore,
    status: 'running',
    createdAt: startedAt,
  });

  // [3] 根据路由模式执行
  switch (route.mode) {
    case 'DIRECT':
      return executeDirect(params, report, route, startedAt);
    case 'DELEGATION':
      return executeDelegation(params, report, route, startedAt);
    case 'ASSEMBLY_LINE':
      return executeAssemblyLine(params, report, route, startedAt);
    case 'CONSORTIUM':
      return executeConsortium(params, report, route, startedAt);
    default:
      return err(`路由模式 ${route.mode} 尚未实现（S12）`);
  }
}

// ── DIRECT 模式 ─────────────────────────────────────────────────────

function executeDirect(
  params: { taskId: string; traceId: string; taskDescription: string },
  _report: ComplexityReport,
  _route: RouteDecisionResult,
  startedAt: number,
): Result<OrchestrationResult> {
  // Director 直接执行——创建 Director Agent
  const directorResult = createAgent({ role: 'prime_director', model: config.directorModel }, params.traceId);
  if (!directorResult.ok) return directorResult;

  const director = directorResult.value;
  const assignResult = assignTask(director.agentId, params.taskId, params.traceId);
  if (!assignResult.ok) return assignResult;

  // Phase 0-2：DIRECT 模式仅标记任务已接收，实际执行由主循环驱动
  return ok({
    taskId: params.taskId,
    traceId: params.traceId,
    routingMode: 'DIRECT',
    startedAt,
    completedAt: Date.now(),
    status: 'success',
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
  const directorResult = createAgent({ role: 'prime_director', model: config.directorModel }, params.traceId);
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
  publish(createEvent({
    eventType: EventType.TASK_DECOMPOSED,
    source: 'Orchestrator/executeDelegation',
    traceId: params.traceId,
    payload: { taskId: params.taskId, subtaskCount: taskPlan.assignments.length },
  }));

  // 招募 Worker 并分配任务
  const recruitedAgents: string[] = [];
  for (const assignment of taskPlan.assignments) {
    const workerResult = createAgent({ role: 'worker', model: config.workerModel }, params.traceId);
    if (!workerResult.ok) {
      // 招募失败：标记子任务失败进入终态，避免计划悬挂无法聚合
      assignment.status = 'failed';
      registerAssignment(assignment);
      updateProgress(assignment.assignmentId, null, { status: 'failed' });
      continue;
    }
    const worker = workerResult.value;
    recruitedAgents.push(worker.agentId);

    // 分配任务
    assignment.assignedAgentId = worker.agentId;
    assignment.status = 'assigned';
    assignTask(worker.agentId, assignment.assignmentId, params.traceId);

    // 注册进度追踪
    registerAssignment(assignment);

    // FE-050：子任务派发落库（subtasks 表）
    dispatchSubtask(assignment);

    // 发布任务分配事件
    publish(createEvent({
      eventType: EventType.TASK_ASSIGNED,
      source: 'Orchestrator/executeDelegation',
      traceId: params.traceId,
      payload: {
        taskId: params.taskId,
        assignmentId: assignment.assignmentId,
        agentId: worker.agentId,
        parentAgentId: director.agentId,
      },
    }));
  }

  // 激活任务计划 + 注册活跃计划（FE-050：等待子任务终态后自动聚合）
  taskPlan.status = 'active';
  activePlans.set(params.taskId, taskPlan);

  // Phase 0-2：返回编排结果，实际执行由 Agent 主循环驱动
  return ok({
    taskId: params.taskId,
    traceId: params.traceId,
    routingMode: 'DELEGATION',
    taskPlan,
    startedAt,
    completedAt: Date.now(),
    status: 'success',
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
  const directorResult = createAgent({ role: 'prime_director', model: config.directorModel }, params.traceId);
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

  // 招募流水线节点 Agent
  for (const assignment of taskPlan.assignments) {
    const nodeResult = createAgent({ role: 'worker', model: config.workerModel }, params.traceId);
    if (!nodeResult.ok) {
      // 招募失败：标记子任务失败进入终态，避免计划悬挂无法聚合
      assignment.status = 'failed';
      registerAssignment(assignment);
      updateProgress(assignment.assignmentId, null, { status: 'failed' });
      continue;
    }
    const node = nodeResult.value;
    assignment.assignedAgentId = node.agentId;
    assignment.status = 'assigned';
    // FE-050：派发（ready → running）—— 修复前流水线节点从未被指派执行
    assignTask(node.agentId, assignment.assignmentId, params.traceId);

    // 注册进度追踪
    registerAssignment(assignment);

    // FE-050：子任务派发落库（subtasks 表）
    dispatchSubtask(assignment);

    // 发布任务分配事件
    publish(createEvent({
      eventType: EventType.TASK_ASSIGNED,
      source: 'Orchestrator/executeAssemblyLine',
      traceId: params.traceId,
      payload: {
        taskId: params.taskId,
        assignmentId: assignment.assignmentId,
        agentId: node.agentId,
        parentAgentId: director.agentId,
      },
    }));
  }

  taskPlan.status = 'active';
  activePlans.set(params.taskId, taskPlan);

  return ok({
    taskId: params.taskId,
    traceId: params.traceId,
    routingMode: 'ASSEMBLY_LINE',
    taskPlan,
    startedAt,
    completedAt: Date.now(),
    status: 'success',
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
  const directorResult = createAgent({ role: 'prime_director', model: config.directorModel }, params.traceId);
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

  // 招募 Partner（每个域一个 Partner）
  for (const assignment of taskPlan.assignments) {
    const partnerResult = createAgent({ role: 'partner', model: config.workerModel }, params.traceId);
    if (!partnerResult.ok) {
      // 招募失败：标记子任务失败进入终态，避免计划悬挂无法聚合
      assignment.status = 'failed';
      registerAssignment(assignment);
      updateProgress(assignment.assignmentId, null, { status: 'failed' });
      continue;
    }
    const partner = partnerResult.value;
    assignment.assignedAgentId = partner.agentId;
    assignment.status = 'assigned';
    // FE-050：派发（ready → running）—— 修复前攻坚 Partner 从未被指派执行
    assignTask(partner.agentId, assignment.assignmentId, params.traceId);

    // 注册进度追踪
    registerAssignment(assignment);

    // FE-050：子任务派发落库（subtasks 表）
    dispatchSubtask(assignment);

    // 发布任务分配事件
    publish(createEvent({
      eventType: EventType.TASK_ASSIGNED,
      source: 'Orchestrator/executeConsortium',
      traceId: params.traceId,
      payload: {
        taskId: params.taskId,
        assignmentId: assignment.assignmentId,
        agentId: partner.agentId,
        parentAgentId: director.agentId,
      },
    }));
  }

  taskPlan.status = 'active';
  activePlans.set(params.taskId, taskPlan);

  return ok({
    taskId: params.taskId,
    traceId: params.traceId,
    routingMode: 'CONSORTIUM',
    taskPlan,
    startedAt,
    completedAt: Date.now(),
    status: 'success',
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
