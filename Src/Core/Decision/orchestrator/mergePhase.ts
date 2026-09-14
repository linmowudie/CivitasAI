/**
 * @module Decision/Orchestrator/mergePhase
 * @description
 * 合并阶段——Docs/03 §7A.2。
 * Orchestrator 的 [8] 合并与冲突预检测步骤。
 * 多 Agent 产物 → 确定性合并（不同文件直接拼装）；
 * 同文件冲突 → WriteGuard 拦截 → 交 S12 仲裁；
 * 不可自动合并 → 风险退出（escalate_human）。
 */

import type { Result } from '../../../Infra/types.js';
import { ok, err } from '../../../Infra/types.js';
import {
  getTaskWorkspaces,
  listOutputFiles,
  markMerged,
  markFailed,
  cleanAgentWorkspace,
  type AgentWorkspace,
} from '../../../Infra/Sandbox/workspaceIsolator.js';
import {
  mergeWorktrees,
  type MergeResult as WorktreeMergeResult,
} from '../../../Infra/Sandbox/gitWorktreeManager.js';
import { precheckConflicts, type ConflictReport, type FileConflict } from './conflictPrecheck.js';
import { EventType } from '../../../Services/EventBus/eventTypes.js';
import { createEvent, publish } from '../../../Services/EventBus/eventBus.js';

// ── 合并结果 ────────────────────────────────────────────────────────

export interface MergePhaseResult {
  taskId: string;
  traceId: string;
  status: 'success' | 'partial' | 'conflict' | 'failed';
  mergedAgents: string[];
  failedAgents: string[];
  conflictReport: ConflictReport;
  mergedFiles: string[];
  conflictingFiles: string[];
  mergedAt: number;
}

// ── 合并入口 ────────────────────────────────────────────────────────

/**
 * 执行合并阶段。
 * 流程：
 * 1. 冲突预检测
 * 2. 合并没有冲突的 Agent 产物
 * 3. 标记冲突的 Agent → 交 S12 仲裁
 * 4. 清理失败 Agent 的工作区
 */
export function executeMergePhase(params: {
  taskId: string;
  traceId: string;
  failedAgentIds?: string[];
}): Result<MergePhaseResult> {
  const { taskId, traceId } = params;
  const failedAgentIds = new Set(params.failedAgentIds ?? []);

  // [1] 冲突预检测
  const conflictResult = precheckConflicts({ taskId, traceId });
  if (!conflictResult.ok) return err(conflictResult.error);
  const conflictReport = conflictResult.value;

  // [2] 获取所有工作区
  const workspaces = getTaskWorkspaces(taskId);
  const mergedAgents: string[] = [];
  const failedAgents: string[] = [...failedAgentIds];
  const mergedFiles: string[] = [];
  const conflictingFiles: string[] = conflictReport.conflicts.map(c => c.file);

  // 冲突涉及的 Agent
  const conflictAgentIds = new Set<string>();
  for (const conflict of conflictReport.conflicts) {
    for (const agentId of conflict.agents) {
      conflictAgentIds.add(agentId);
    }
  }

  // [3] 合并无冲突的 Agent 产物
  for (const ws of workspaces) {
    // 跳过失败的 Agent
    if (failedAgentIds.has(ws.agentId)) {
      markFailed(ws.agentId);
      cleanAgentWorkspace(ws.agentId);
      continue;
    }

    // 跳过有冲突的 Agent（交 S12 仲裁）
    if (conflictAgentIds.has(ws.agentId)) {
      continue;
    }

    // 合并
    const filesResult = listOutputFiles(ws.agentId);
    if (filesResult.ok) {
      mergedFiles.push(...filesResult.value);
    }
    markMerged(ws.agentId);
    mergedAgents.push(ws.agentId);
  }

  // [4] 确定总体状态
  let status: MergePhaseResult['status'];
  if (conflictReport.hasConflicts) {
    status = 'conflict';
  } else if (failedAgents.length > 0 && mergedAgents.length === 0) {
    status = 'failed';
  } else if (failedAgents.length > 0) {
    status = 'partial';
  } else {
    status = 'success';
  }

  // [5] 发布合并事件
  publish(createEvent({
    eventType: EventType.TASK_COMPLETED,
    source: 'Decision/Orchestrator/mergePhase',
    traceId,
    payload: {
      taskId,
      status,
      mergedAgents,
      failedAgents: [...failedAgents],
      conflictCount: conflictReport.conflicts.length,
    },
  }));

  return ok({
    taskId,
    traceId,
    status,
    mergedAgents,
    failedAgents: [...failedAgents],
    conflictReport,
    mergedFiles,
    conflictingFiles,
    mergedAt: Date.now(),
  });
}

// ── 辅助：确定性合并（不同文件直接拼装）────────────────────────────

/**
 * 尝试确定性合并：不同 Agent 修改不同文件 → 直接拼装。
 * 返回合并后的文件列表和无法合并的冲突列表。
 */
export function deterministicMerge(params: {
  workspaces: AgentWorkspace[];
}): { mergedFiles: string[]; conflicts: FileConflict[] } {
  const fileOwner: Map<string, string> = new Map(); // file → agentId
  const mergedFiles: string[] = [];
  const conflicts: FileConflict[] = [];

  for (const ws of params.workspaces) {
    for (const file of ws.modifiedFiles) {
      const existingOwner = fileOwner.get(file);
      if (existingOwner && existingOwner !== ws.agentId) {
        // 冲突：多 Agent 修改同文件
        const existing = conflicts.find(c => c.file === file);
        if (existing) {
          existing.agents.push(ws.agentId);
        } else {
          conflicts.push({
            file,
            agents: [existingOwner, ws.agentId],
            severity: 'critical',
            resolution: 'arbitration',
          });
        }
      } else {
        fileOwner.set(file, ws.agentId);
        mergedFiles.push(file);
      }
    }
  }

  return { mergedFiles, conflicts };
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetMergePhase(): void {
  // 无状态，预留接口
}
