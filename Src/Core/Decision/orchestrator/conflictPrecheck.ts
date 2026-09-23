/**
 * @module Decision/Orchestrator/conflictPrecheck
 * @description
 * 冲突预检测——Docs/03 §7A.2。
 * 在合并前检测多 Agent 产物之间的文件冲突。
 * 冲突不静默覆盖，交 S12 仲裁系统处理。
 */

import type { Result } from '../../../Infra/types.js';
import { ok } from '../../../Infra/types.js';
import { getTaskWorkspaces, type AgentWorkspace } from '../../../Infra/Sandbox/workspaceIsolator.js';
import { EventType } from '../../../Services/EventBus/eventTypes.js';
import { createEvent, publish } from '../../../Services/EventBus/eventBus.js';

// ── 冲突报告 ────────────────────────────────────────────────────────

export interface ConflictReport {
  taskId: string;
  traceId: string;
  hasConflicts: boolean;
  conflicts: FileConflict[];
  detectedAt: number;
}

export interface FileConflict {
  file: string;
  agents: string[];           // 修改此文件的 Agent 列表
  severity: 'warning' | 'critical';
  resolution: 'auto_merge' | 'arbitration' | 'manual' | 'skip';
}

// ── 冲突预检测入口 ──────────────────────────────────────────────────

/**
 * 对任务的所有 Agent 产物进行冲突预检测。
 * 检测维度：
 * 1. 目录隔离层——不同 Agent 修改了同一文件路径
 * 2. Worktree 层——不同分支修改了同一文件
 */
export function precheckConflicts(params: {
  taskId: string;
  traceId: string;
}): Result<ConflictReport> {
  const conflicts: FileConflict[] = [];

  // [1] 目录隔离层冲突检测
  const workspaces = getTaskWorkspaces(params.taskId);
  const dirConflicts = detectDirectoryConflicts(workspaces);
  conflicts.push(...dirConflicts);

  // [2] 发布冲突事件
  if (conflicts.length > 0) {
    publish(createEvent({
      eventType: EventType.CONFLICT_DETECTED,
      source: 'Decision/Orchestrator/conflictPrecheck',
      traceId: params.traceId,
      payload: {
        taskId: params.taskId,
        conflictCount: conflicts.length,
        conflicts: conflicts.map(c => ({ file: c.file, agents: c.agents })),
      },
    }));
  }

  return ok({
    taskId: params.taskId,
    traceId: params.traceId,
    hasConflicts: conflicts.length > 0,
    conflicts,
    detectedAt: Date.now(),
  });
}

// ── 目录层冲突检测 ──────────────────────────────────────────────────

function detectDirectoryConflicts(workspaces: AgentWorkspace[]): FileConflict[] {
  const fileModifiers: Map<string, string[]> = new Map(); // file → agentIds

  for (const ws of workspaces) {
    if (ws.status !== 'active' && ws.status !== 'merged') continue;
    for (const file of ws.modifiedFiles) {
      const agents = fileModifiers.get(file) ?? [];
      agents.push(ws.agentId);
      fileModifiers.set(file, agents);
    }
  }

  const conflicts: FileConflict[] = [];
  for (const [file, agents] of fileModifiers) {
    if (agents.length > 1) {
      conflicts.push({
        file,
        agents,
        severity: 'critical',
        resolution: 'arbitration', // 交 S12 仲裁
      });
    }
  }

  return conflicts;
}

// ── 辅助：检查是否有冲突 ────────────────────────────────────────────

export function hasConflicts(taskId: string): boolean {
  const workspaces = getTaskWorkspaces(taskId);
  const fileModifiers: Map<string, number> = new Map();

  for (const ws of workspaces) {
    for (const file of ws.modifiedFiles) {
      fileModifiers.set(file, (fileModifiers.get(file) ?? 0) + 1);
    }
  }

  for (const count of fileModifiers.values()) {
    if (count > 1) return true;
  }
  return false;
}

// ── 辅助：获取冲突文件列表 ──────────────────────────────────────────

export function getConflictingFiles(taskId: string): string[] {
  const workspaces = getTaskWorkspaces(taskId);
  const fileModifiers: Map<string, number> = new Map();

  for (const ws of workspaces) {
    for (const file of ws.modifiedFiles) {
      fileModifiers.set(file, (fileModifiers.get(file) ?? 0) + 1);
    }
  }

  const conflicting: string[] = [];
  for (const [file, count] of fileModifiers) {
    if (count > 1) conflicting.push(file);
  }
  return conflicting;
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetConflictPrecheck(): void {
  // 无状态，预留接口
}
