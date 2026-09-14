/**
 * @module Decision/TaskDecomposer
 * @description
 * 任务拆解器——Docs/03 §4.2。
 * 将复杂任务拆解为可分配的子任务，生成 TaskPlan。
 * Phase 0-2：基于规则的拆解；后续可接 LLM 拆解。
 */

import type { TaskPlan, TaskAssignment, ComplexityReport } from '../types.js';
import type { Result } from '../../../Infra/types.js';
import { ok, err } from '../../../Infra/types.js';

// ── 拆解输入 ────────────────────────────────────────────────────────

export interface DecomposeInput {
  taskId: string;
  traceId: string;
  directorAgentId: string;
  taskDescription: string;
  complexityReport: ComplexityReport;
  // 全局约束
  totalTokenBudget: number;
  globalTimeLimitMs: number;
  maxParallelism?: number;
}

// ── 拆解入口 ────────────────────────────────────────────────────────

let planCounter = 0;

/**
 * 将任务拆解为子任务计划。
 * Phase 0-2：按专业域均匀分配，后续可接 LLM 智能拆解。
 */
export function decomposeTask(input: DecomposeInput): Result<TaskPlan> {
  if (!input.taskDescription || input.taskDescription.trim().length === 0) {
    return err('任务描述不能为空');
  }
  if (input.totalTokenBudget <= 0) {
    return err('Token 预算必须大于 0');
  }

  const report = input.complexityReport;
  const subtaskCount = Math.max(report.subtaskCount, 1);

  // 生成子任务分配
  const assignments: TaskAssignment[] = [];
  const budgetPerSubtask = Math.floor(input.totalTokenBudget / subtaskCount);
  const timePerSubtask = Math.floor(input.globalTimeLimitMs / subtaskCount);

  for (let i = 0; i < subtaskCount; i++) {
    const domain = report.requiredDomains[i % report.requiredDomains.length];
    const assignment: TaskAssignment = {
      assignmentId: `assign-${input.taskId}-${i}`,
      taskId: input.taskId,
      traceId: input.traceId,
      parentAgentId: input.directorAgentId,
      subtaskIndex: i,
      description: generateSubtaskDescription(input.taskDescription, domain, i, subtaskCount),
      inputContext: {
        originalTask: input.taskDescription,
        domain,
        partIndex: i,
        totalParts: subtaskCount,
      },
      outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
      maxIterations: 20,
      timeLimitMs: timePerSubtask,
      tokenBudget: budgetPerSubtask,
      dependsOn: findDependencies(i, subtaskCount, report.couplingScore),
      requiredTools: getToolsForDomain(domain),
      status: 'pending',
    };
    assignments.push(assignment);
  }

  const plan: TaskPlan = {
    planId: `plan-${++planCounter}`,
    taskId: input.taskId,
    traceId: input.traceId,
    directorAgentId: input.directorAgentId,
    assignments,
    totalTokenBudget: input.totalTokenBudget,
    globalTimeLimitMs: input.globalTimeLimitMs,
    maxParallelism: input.maxParallelism ?? calculateMaxParallelism(subtaskCount, report.couplingScore),
    createdAt: Date.now(),
    status: 'draft',
  };

  return ok(plan);
}

// ── 内部辅助 ────────────────────────────────────────────────────────

function generateSubtaskDescription(
  originalTask: string,
  domain: string,
  index: number,
  total: number,
): string {
  // Phase 0-2：简单按域分配描述
  return `[${domain}] 子任务 ${index + 1}/${total}: ${originalTask.slice(0, 100)}...`;
}

function findDependencies(index: number, total: number, couplingScore: number): string[] {
  // 耦合度高时，后续子任务依赖前一个
  if (couplingScore > 0.6 && index > 0) {
    return [`assign-current-${index - 1}`]; // 占位，实际由 orchestrator 替换
  }
  // 低耦合时完全并行
  return [];
}

function getToolsForDomain(domain: string): string[] {
  const domainTools: Record<string, string[]> = {
    backend: ['file.read', 'file.write', 'shell.exec'],
    frontend: ['file.read', 'file.write'],
    database: ['file.read', 'file.write', 'shell.exec'],
    devops: ['file.read', 'shell.exec'],
    testing: ['file.read', 'shell.exec', 'code.eval'],
    security: ['file.read'],
    general: ['file.read', 'file.write'],
  };
  return domainTools[domain] ?? domainTools.general;
}

function calculateMaxParallelism(subtaskCount: number, couplingScore: number): number {
  // 耦合度高 → 降低并行度
  if (couplingScore > 0.7) return Math.max(Math.ceil(subtaskCount * 0.5), 1);
  if (couplingScore > 0.4) return Math.max(Math.ceil(subtaskCount * 0.7), 1);
  return subtaskCount; // 低耦合全并行
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetDecomposer(): void {
  planCounter = 0;
}
