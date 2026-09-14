/**
 * @module Decision/Orchestrator/orchestrator
 * @description
 * 编排器主入口——Docs/03 §3.1。
 * 端到端编排流程：接收任务 → 复杂度评估 → 路由决策 → 任务拆解 → Agent 招募 → 执行 → 结果聚合。
 *
 * 构建顺序（Docs/14 §S10）：先 DELEGATION → 再 ASSEMBLY_LINE → 最后 CONSORTIUM。
 */

import type {
  OrchestrationResult,
  TaskPlan,
  SubtaskResult,
  RoutingMode,
  ComplexityReport,
  RouteDecisionResult,
} from '../types.js';
import { assessComplexity, type AssessmentInput } from '../ComplexityAssessor/complexityAssessor.js';
import { decideRoute } from '../RouteDecision/routeDecision.js';
import { decomposeTask, type DecomposeInput } from '../TaskDecomposer/taskDecomposer.js';
import {
  initProgressTracker,
  registerAssignment,
  detectAllAnomalies,
  resetProgressTracker,
} from './progressTracker.js';
import { aggregateResults, resetAggregator } from './resultAggregator.js';
import { createAgent } from '../../AgentRuntime/agentFactory.js';
import { assignTask, getAgent } from '../../AgentRuntime/agentRuntime.js';
import { EventType } from '../../../Services/EventBus/eventTypes.js';
import { createEvent, publish } from '../../../Services/EventBus/eventBus.js';
import type { Result } from '../../../Infra/types.js';
import { ok, err } from '../../../Infra/types.js';

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

  // 初始化进度追踪器
  initProgressTracker();

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
  report: ComplexityReport,
  route: RouteDecisionResult,
  startedAt: number,
): Result<OrchestrationResult> {
  // Director 直接执行——创建 Director Agent
  const directorResult = createAgent({ role: 'director', model: config.directorModel }, params.traceId);
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
  route: RouteDecisionResult,
  startedAt: number,
): Result<OrchestrationResult> {
  // 创建 Director
  const directorResult = createAgent({ role: 'director', model: config.directorModel }, params.traceId);
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
    if (!workerResult.ok) continue;
    const worker = workerResult.value;
    recruitedAgents.push(worker.agentId);

    // 分配任务
    assignment.assignedAgentId = worker.agentId;
    assignment.status = 'assigned';
    assignTask(worker.agentId, assignment.assignmentId, params.traceId);

    // 注册进度追踪
    registerAssignment(assignment);

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

  // 激活任务计划
  taskPlan.status = 'active';

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
  route: RouteDecisionResult,
  startedAt: number,
): Result<OrchestrationResult> {
  // 创建 Director
  const directorResult = createAgent({ role: 'director', model: config.directorModel }, params.traceId);
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
    taskPlan.assignments[i].dependsOn = [taskPlan.assignments[i - 1].assignmentId];
  }

  // 招募流水线节点 Agent
  for (const assignment of taskPlan.assignments) {
    const nodeResult = createAgent({ role: 'worker', model: config.workerModel }, params.traceId);
    if (!nodeResult.ok) continue;
    assignment.assignedAgentId = nodeResult.value.agentId;
    assignment.status = 'assigned';
    registerAssignment(assignment);
  }

  taskPlan.status = 'active';

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
  route: RouteDecisionResult,
  startedAt: number,
): Result<OrchestrationResult> {
  // 创建 Director
  const directorResult = createAgent({ role: 'director', model: config.directorModel }, params.traceId);
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
    if (!partnerResult.ok) continue;
    assignment.assignedAgentId = partnerResult.value.agentId;
    assignment.status = 'assigned';
    registerAssignment(assignment);
  }

  taskPlan.status = 'active';

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
}
