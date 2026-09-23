/**
 * @module Decision/Orchestrator/resultAggregator
 * @description
 * 结果聚合器——Docs/03 §4.2 [6] + §7A.2。
 * 整合各子任务结果，生成最终交付物。
 * 支持确定性合并（不同文件直接拼装）+ 冲突检测。
 */

import type { SubtaskResult, AggregatedResult, TaskPlan } from '../types.js';
import type { Result } from '../../../Infra/types.js';
import { ok, err } from '../../../Infra/types.js';

// ── 聚合入口 ────────────────────────────────────────────────────────

/**
 * 聚合所有子任务结果。
 */
export function aggregateResults(params: {
  taskPlan: TaskPlan;
  subtaskResults: SubtaskResult[];
}): Result<AggregatedResult> {
  const { taskPlan, subtaskResults } = params;

  if (subtaskResults.length === 0) {
    return err('无子任务结果可聚合');
  }

  // 1. 计算总体状态
  const successCount = subtaskResults.filter(r => r.status === 'success').length;
  const failedCount = subtaskResults.filter(r => r.status === 'failed').length;
  const totalCount = subtaskResults.length;

  let overallStatus: AggregatedResult['status'];
  if (failedCount === totalCount) {
    overallStatus = 'failed';
  } else if (failedCount > 0 || successCount < totalCount) {
    overallStatus = 'partial_success';
  } else {
    overallStatus = 'success';
  }

  // 2. 合并输出
  const finalOutput = mergeOutputs(subtaskResults);

  // 3. 计算总 Token 消耗
  const totalTokensUsed = subtaskResults.reduce((sum, r) => sum + r.tokensUsed, 0);

  // 4. 检测冲突（§7A.2 合并阶段）
  detectConflicts(subtaskResults);

  return ok({
    taskId: taskPlan.taskId,
    traceId: taskPlan.traceId,
    status: overallStatus,
    subtaskResults: [...subtaskResults],
    finalOutput,
    totalTokensUsed,
    aggregatedAt: Date.now(),
  });
}

// ── 内部辅助 ────────────────────────────────────────────────────────

function mergeOutputs(results: SubtaskResult[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const result of results) {
    if (result.status === 'success' || result.status === 'partial') {
      // 按 assignmentId 组织输出
      merged[result.assignmentId] = result.output;
    } else if (result.status === 'failed') {
      errors.push(`Assignment ${result.assignmentId} (Agent ${result.agentId}) 失败`);
    }
  }

  if (errors.length > 0) {
    merged._errors = errors;
  }

  merged._summary = {
    total: results.length,
    success: results.filter(r => r.status === 'success').length,
    failed: results.filter(r => r.status === 'failed').length,
    partial: results.filter(r => r.status === 'partial').length,
  };

  return merged;
}

function detectConflicts(results: SubtaskResult[]): string[] {
  // Phase 0-2：简单检测——检查是否有多个结果修改了同一字段
  const conflicts: string[] = [];
  const fileModifications: Map<string, string[]> = new Map();

  for (const result of results) {
    if (result.status !== 'success') continue;
    const modifiedFiles = result.output.modifiedFiles as string[] | undefined;
    if (modifiedFiles) {
      for (const file of modifiedFiles) {
        const agents = fileModifications.get(file) ?? [];
        agents.push(result.agentId);
        fileModifications.set(file, agents);
      }
    }
  }

  // 检测同文件多 Agent 修改
  for (const [file, agents] of fileModifications) {
    if (agents.length > 1) {
      conflicts.push(`文件 ${file} 被多个 Agent 修改: ${agents.join(', ')}`);
    }
  }

  return conflicts;
}

// ── 质量评分计算（Docs/03 §7.7）────────────────────────────────────

/**
 * 计算质量分（用于 Token 分润）。
 * L1 pass率 x 0.4 + L2 pass率 x 0.3 + L3 rubric 加权得分 x 0.3
 */
export function calculateQualityScore(params: {
  l1PassRate: number;
  l2PassRate: number;
  l3RubricScore?: number;
}): number {
  const { l1PassRate, l2PassRate, l3RubricScore } = params;

  if (l3RubricScore !== undefined) {
    return l1PassRate * 0.4 + l2PassRate * 0.3 + l3RubricScore * 0.3;
  }
  // 无 L3（完全确定性任务）
  return l1PassRate * 0.6 + l2PassRate * 0.4;
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetAggregator(): void {
  // Phase 0-2 无状态，预留接口
}
