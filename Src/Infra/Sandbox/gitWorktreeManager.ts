/**
 * @module Sandbox/gitWorktreeManager
 * @description
 * Git Worktree 管理器——Docs/03 §7A.1。
 * 为每个 Agent 创建独立分支/worktree，实现代码任务级别的隔离。
 * Phase 0-2：内存模拟（不依赖真实 Git）；Phase 3 接真实 git worktree。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── Worktree 描述 ───────────────────────────────────────────────────

export interface WorktreeEntry {
  worktreeId: string;
  agentId: string;
  taskId: string;
  branchName: string;
  baseBranch: string;
  status: 'created' | 'committed' | 'merged' | 'conflict' | 'cleaned';
  createdAt: number;
  committedFiles: string[];     // 已提交的文件列表
  commitMessage?: string;
}

// ── 合并结果 ────────────────────────────────────────────────────────

export interface MergeResult {
  success: boolean;
  mergedBranches: string[];
  conflicts: MergeConflict[];
  mergedAt: number;
}

export interface MergeConflict {
  file: string;
  branches: string[];           // 冲突的分支列表
  agents: string[];             // 冲突的 Agent 列表
  resolution: 'pending' | 'arbitration' | 'manual' | 'auto';
}

// ── 内部状态 ────────────────────────────────────────────────────────

const worktrees: Map<string, WorktreeEntry> = new Map(); // worktreeId → entry
const branchFiles: Map<string, Map<string, string>> = new Map(); // branch → (file → content)
let worktreeCounter = 0;
let baseBranch = 'main';

// ── 配置 ────────────────────────────────────────────────────────────

export function initGitWorktreeManager(config: { baseBranch?: string } = {}): void {
  baseBranch = config.baseBranch ?? 'main';
  // 初始化 base branch 的文件映射
  if (!branchFiles.has(baseBranch)) {
    branchFiles.set(baseBranch, new Map());
  }
}

// ── 创建 Worktree ───────────────────────────────────────────────────

/**
 * 为 Agent 创建独立 worktree（分支）。
 * Phase 0-2：内存模拟，每个分支有独立的文件映射。
 */
export function createWorktree(params: {
  agentId: string;
  taskId: string;
  baseBranch?: string;
}): Result<WorktreeEntry> {
  const branch = params.baseBranch ?? baseBranch;
  if (!branchFiles.has(branch)) {
    return err(`基础分支 ${branch} 不存在`);
  }

  const worktreeId = `wt-${++worktreeCounter}`;
  const branchName = `agent-${params.agentId}-task-${params.taskId}`;

  // 从 base branch 克隆文件（模拟 worktree 创建）
  const baseFiles = branchFiles.get(branch)!;
  const newFiles = new Map(baseFiles);
  branchFiles.set(branchName, newFiles);

  const entry: WorktreeEntry = {
    worktreeId,
    agentId: params.agentId,
    taskId: params.taskId,
    branchName,
    baseBranch: branch,
    status: 'created',
    createdAt: Date.now(),
    committedFiles: [],
  };

  worktrees.set(worktreeId, entry);
  return ok(entry);
}

// ── 文件操作（在 worktree 内）───────────────────────────────────────

/**
 * 在 worktree 中写入文件。
 */
export function writeFileInWorktree(worktreeId: string, filePath: string, content: string): Result<void> {
  const entry = worktrees.get(worktreeId);
  if (!entry) return err(`Worktree ${worktreeId} 不存在`);
  if (entry.status === 'cleaned') return err(`Worktree ${worktreeId} 已清理`);

  const files = branchFiles.get(entry.branchName);
  if (!files) return err(`分支 ${entry.branchName} 文件映射不存在`);

  files.set(filePath, content);
  if (!entry.committedFiles.includes(filePath)) {
    entry.committedFiles.push(filePath);
  }
  return ok(undefined);
}

/**
 * 读取 worktree 中的文件。
 */
export function readFileFromWorktree(worktreeId: string, filePath: string): Result<string> {
  const entry = worktrees.get(worktreeId);
  if (!entry) return err(`Worktree ${worktreeId} 不存在`);

  const files = branchFiles.get(entry.branchName);
  if (!files) return err(`分支 ${entry.branchName} 文件映射不存在`);

  const content = files.get(filePath);
  if (content === undefined) return err(`文件 ${filePath} 不存在于 ${entry.branchName}`);
  return ok(content);
}

/**
 * 列出 worktree 中修改的文件。
 */
export function listModifiedFiles(worktreeId: string): Result<string[]> {
  const entry = worktrees.get(worktreeId);
  if (!entry) return err(`Worktree ${worktreeId} 不存在`);
  return ok([...entry.committedFiles]);
}

// ── 提交 ────────────────────────────────────────────────────────────

export function commitWorktree(worktreeId: string, message: string): Result<void> {
  const entry = worktrees.get(worktreeId);
  if (!entry) return err(`Worktree ${worktreeId} 不存在`);
  entry.status = 'committed';
  entry.commitMessage = message;
  return ok(undefined);
}

// ── 冲突检测 ────────────────────────────────────────────────────────

/**
 * 检测多个 worktree 之间的文件冲突。
 * 同文件被多个分支修改 → 冲突。
 */
export function detectConflicts(worktreeIds: string[]): MergeConflict[] {
  const fileModifiers: Map<string, Array<{ branch: string; agentId: string }>> = new Map();

  for (const wtId of worktreeIds) {
    const entry = worktrees.get(wtId);
    if (!entry || entry.committedFiles.length === 0) continue;

    for (const file of entry.committedFiles) {
      const modifiers = fileModifiers.get(file) ?? [];
      modifiers.push({ branch: entry.branchName, agentId: entry.agentId });
      fileModifiers.set(file, modifiers);
    }
  }

  // 找出被多个分支修改的文件
  const conflicts: MergeConflict[] = [];
  for (const [file, modifiers] of fileModifiers) {
    if (modifiers.length > 1) {
      conflicts.push({
        file,
        branches: modifiers.map(m => m.branch),
        agents: modifiers.map(m => m.agentId),
        resolution: 'pending',
      });
    }
  }

  return conflicts;
}

// ── 合并 ────────────────────────────────────────────────────────────

/**
 * 将多个 worktree 合并到 base branch。
 * 无冲突 → 自动合并；有冲突 → 标记为 pending，交 S12 仲裁。
 */
export function mergeWorktrees(worktreeIds: string[]): Result<MergeResult> {
  const conflicts = detectConflicts(worktreeIds);
  const mergedBranches: string[] = [];

  // 标记冲突分支
  for (const conflict of conflicts) {
    conflict.resolution = 'arbitration'; // 交 S12 仲裁
    for (const wtId of worktreeIds) {
      const entry = worktrees.get(wtId);
      if (entry && conflict.agents.includes(entry.agentId)) {
        entry.status = 'conflict';
      }
    }
  }

  // 合并没有冲突的分支
  const targetFiles = branchFiles.get(baseBranch);
  if (!targetFiles) return err(`基础分支 ${baseBranch} 不存在`);

  for (const wtId of worktreeIds) {
    const entry = worktrees.get(wtId);
    if (!entry) continue;
    if (entry.status === 'conflict') continue;

    const sourceFiles = branchFiles.get(entry.branchName);
    if (!sourceFiles) continue;

    // 合入文件
    for (const [file, content] of sourceFiles) {
      targetFiles.set(file, content);
    }

    entry.status = 'merged';
    mergedBranches.push(entry.branchName);
  }

  return ok({
    success: conflicts.length === 0,
    mergedBranches,
    conflicts,
    mergedAt: Date.now(),
  });
}

// ── 清理 ────────────────────────────────────────────────────────────

export function cleanWorktree(worktreeId: string): Result<void> {
  const entry = worktrees.get(worktreeId);
  if (!entry) return ok(undefined);

  branchFiles.delete(entry.branchName);
  entry.status = 'cleaned';
  return ok(undefined);
}

export function getWorktree(worktreeId: string): WorktreeEntry | undefined {
  const e = worktrees.get(worktreeId);
  return e ? { ...e, committedFiles: [...e.committedFiles] } : undefined;
}

export function getAgentWorktree(agentId: string): WorktreeEntry | undefined {
  for (const e of worktrees.values()) {
    if (e.agentId === agentId) return { ...e, committedFiles: [...e.committedFiles] };
  }
  return undefined;
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetGitWorktreeManager(): void {
  worktrees.clear();
  branchFiles.clear();
  worktreeCounter = 0;
  baseBranch = 'main';
}
