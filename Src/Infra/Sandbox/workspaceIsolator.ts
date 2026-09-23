/**
 * @module Sandbox/workspaceIsolator
 * @description
 * Agent 工作区隔离器——Docs/03 §7A.1。
 * 为每个 Agent 创建隔离目录：Data/Workspace/{session}/{taskId}/{agentId}/。
 * 五级隔离策略：只读无隔离 / 目录隔离 / Git worktree / 乐观锁 / 沙箱草稿。
 */

import { join } from 'node:path';
import { mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 隔离级别（Docs/03 §7A.1 表格）──────────────────────────────────

export type IsolationLevel =
  | 'none'           // 只读，无隔离
  | 'directory'      // 目录隔离（默认）
  | 'git_worktree'   // Git worktree（代码任务）
  | 'optimistic_lock' // 乐观锁（共享数据）
  | 'sandbox_draft'; // 沙箱草稿（不可逆副作用）

// ── Agent 工作区描述 ────────────────────────────────────────────────

export interface AgentWorkspace {
  agentId: string;
  taskId: string;
  sessionKey: string;
  isolationLevel: IsolationLevel;
  workspaceDir: string;       // 完整路径
  outputDir: string;          // 产物输出目录
  createdAt: number;
  status: 'active' | 'merged' | 'failed' | 'cleaned';
  modifiedFiles: string[];    // 修改过的文件列表
}

// ── 内部状态 ────────────────────────────────────────────────────────

const workspaces: Map<string, AgentWorkspace> = new Map(); // agentId → workspace
let dataRoot = 'Data';

// ── 配置 ────────────────────────────────────────────────────────────

export function initWorkspaceIsolator(config: { dataRoot?: string } = {}): void {
  dataRoot = config.dataRoot ?? 'Data';
}

// ── 创建隔离工作区 ──────────────────────────────────────────────────

/**
 * 为 Agent 创建隔离目录。
 * 路径：{dataRoot}/Workspace/{sessionKey}/{taskId}/{agentId}/
 */
export function createIsolatedWorkspace(params: {
  agentId: string;
  taskId: string;
  sessionKey: string;
  isolationLevel?: IsolationLevel;
}): Result<AgentWorkspace> {
  const level = params.isolationLevel ?? 'directory';
  const workspaceDir = join(
    dataRoot, 'Workspace',
    params.sessionKey, params.taskId, params.agentId,
  );
  const outputDir = join(workspaceDir, 'output');

  try {
    // 创建目录
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    const workspace: AgentWorkspace = {
      agentId: params.agentId,
      taskId: params.taskId,
      sessionKey: params.sessionKey,
      isolationLevel: level,
      workspaceDir,
      outputDir,
      createdAt: Date.now(),
      status: 'active',
      modifiedFiles: [],
    };

    workspaces.set(params.agentId, workspace);
    return ok(workspace);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`创建隔离工作区失败: ${msg}`);
  }
}

// ── 记录文件修改 ────────────────────────────────────────────────────

/**
 * 记录 Agent 修改了哪些文件（用于冲突检测）。
 */
export function recordFileModification(agentId: string, filePath: string): Result<void> {
  const ws = workspaces.get(agentId);
  if (!ws) return err(`Agent ${agentId} 无隔离工作区`);
  if (!ws.modifiedFiles.includes(filePath)) {
    ws.modifiedFiles.push(filePath);
  }
  return ok(undefined);
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getAgentWorkspace(agentId: string): AgentWorkspace | undefined {
  const ws = workspaces.get(agentId);
  return ws ? { ...ws, modifiedFiles: [...ws.modifiedFiles] } : undefined;
}

export function getAllWorkspaces(): AgentWorkspace[] {
  return [...workspaces.values()].map(ws => ({
    ...ws,
    modifiedFiles: [...ws.modifiedFiles],
  }));
}

export function getTaskWorkspaces(taskId: string): AgentWorkspace[] {
  return getAllWorkspaces().filter(ws => ws.taskId === taskId);
}

// ── 产物收集 ────────────────────────────────────────────────────────

/**
 * 获取 Agent 产物目录中的所有文件。
 */
export function listOutputFiles(agentId: string): Result<string[]> {
  const ws = workspaces.get(agentId);
  if (!ws) return err(`Agent ${agentId} 无隔离工作区`);
  if (!existsSync(ws.outputDir)) return ok([]);

  const files: string[] = [];
  collectFiles(ws.outputDir, files);
  return ok(files);
}

function collectFiles(dir: string, result: string[]): void {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      collectFiles(fullPath, result);
    } else {
      result.push(fullPath);
    }
  }
}

// ── 隔离验证 ────────────────────────────────────────────────────────

/**
 * 验证 Agent 是否只在自己的目录内操作。
 * 检查是否有越界访问。
 */
export function validateIsolation(agentId: string, accessedPath: string): Result<boolean> {
  const ws = workspaces.get(agentId);
  if (!ws) return err(`Agent ${agentId} 无隔离工作区`);

  // 检查路径是否在 Agent 工作区内
  const normalizedAccess = accessedPath.replace(/\\/g, '/');
  const normalizedWs = ws.workspaceDir.replace(/\\/g, '/');

  if (!normalizedAccess.startsWith(normalizedWs)) {
    return err(`Agent ${agentId} 越界访问: ${accessedPath} 不在 ${ws.workspaceDir} 内`);
  }
  return ok(true);
}

// ── 清理 ────────────────────────────────────────────────────────────

/**
 * 清理 Agent 工作区（标记为 cleaned）。
 * 单 Agent 失败时调用，不污染其他 Agent 产物。
 */
export function cleanAgentWorkspace(agentId: string): Result<void> {
  const ws = workspaces.get(agentId);
  if (!ws) return ok(undefined); // 不存在也成功

  try {
    if (existsSync(ws.workspaceDir)) {
      rmSync(ws.workspaceDir, { recursive: true, force: true });
    }
    ws.status = 'cleaned';
    return ok(undefined);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`清理工作区失败: ${msg}`);
  }
}

/**
 * 标记工作区为已合并。
 */
export function markMerged(agentId: string): Result<void> {
  const ws = workspaces.get(agentId);
  if (!ws) return err(`Agent ${agentId} 无隔离工作区`);
  ws.status = 'merged';
  return ok(undefined);
}

/**
 * 标记工作区为失败。
 */
export function markFailed(agentId: string): Result<void> {
  const ws = workspaces.get(agentId);
  if (!ws) return err(`Agent ${agentId} 无隔离工作区`);
  ws.status = 'failed';
  return ok(undefined);
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetWorkspaceIsolator(): void {
  workspaces.clear();
  dataRoot = 'Data';
}
