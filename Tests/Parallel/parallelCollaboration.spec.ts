/**
 * S11 并行协作与工作区隔离测试——Gate G11 验证
 *
 * 覆盖：
 * - WorkspaceIsolator（Agent 目录级隔离）
 * - GitWorktreeManager（Git worktree 管理）
 * - ConflictPrecheck（冲突预检测）
 * - MergePhase（合并阶段 + 确定性合并）
 * - Gate G11 综合验证
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── WorkspaceIsolator ─────────────────────────────────
import {
  initWorkspaceIsolator, createIsolatedWorkspace, getAgentWorkspace,
  getTaskWorkspaces, recordFileModification, validateIsolation,
  cleanAgentWorkspace, markMerged, markFailed, listOutputFiles,
  getAllWorkspaces, resetWorkspaceIsolator,
} from '../../Src/Infra/Sandbox/workspaceIsolator.js';

// ── GitWorktreeManager ─────────────────────────────────
import {
  initGitWorktreeManager, createWorktree, writeFileInWorktree,
  readFileFromWorktree, listModifiedFiles, commitWorktree,
  detectConflicts, mergeWorktrees, cleanWorktree, getWorktree,
  getAgentWorktree, resetGitWorktreeManager,
} from '../../Src/Infra/Sandbox/gitWorktreeManager.js';

// ── ConflictPrecheck ───────────────────────────────────
import {
  precheckConflicts, hasConflicts, getConflictingFiles,
  resetConflictPrecheck,
} from '../../Src/Core/Decision/Orchestrator/conflictPrecheck.js';

// ── MergePhase ─────────────────────────────────────────
import {
  executeMergePhase, deterministicMerge, resetMergePhase,
} from '../../Src/Core/Decision/Orchestrator/mergePhase.js';

// ── EventBus（重置用）──────────────────────────────────
import { resetEventBus, initEventBus } from '../../Src/Services/EventBus/eventBus.js';

// ── 辅助 ──────────────────────────────────────────────

function fullReset() {
  resetEventBus();
  initEventBus();
  resetWorkspaceIsolator();
  initWorkspaceIsolator({ dataRoot: '/tmp/test-data' });
  resetGitWorktreeManager();
  initGitWorktreeManager();
  resetConflictPrecheck();
  resetMergePhase();
}

// ═══════════════════════════════════════════════════════
// 1. WorkspaceIsolator
// ═══════════════════════════════════════════════════════

describe('S11 · WorkspaceIsolator', () => {
  beforeEach(fullReset);

  it('创建隔离工作区：每个 Agent 独立目录', () => {
    const r1 = createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    const r2 = createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.workspaceDir).not.toBe(r2.value.workspaceDir);
      expect(r1.value.workspaceDir).toContain('a1');
      expect(r2.value.workspaceDir).toContain('a2');
    }
  });

  it('记录文件修改 + 查询', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    recordFileModification('a1', 'src/index.ts');
    recordFileModification('a1', 'src/utils.ts');

    const ws = getAgentWorkspace('a1');
    expect(ws).toBeDefined();
    expect(ws?.modifiedFiles).toContain('src/index.ts');
    expect(ws?.modifiedFiles).toContain('src/utils.ts');
  });

  it('隔离验证：越界访问被拒', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    const ws = getAgentWorkspace('a1');
    expect(ws).toBeDefined();

    // 合法路径
    const valid = validateIsolation('a1', ws!.workspaceDir + '/output/file.ts');
    expect(valid.ok).toBe(true);

    // 越界路径
    const invalid = validateIsolation('a1', '/etc/passwd');
    expect(invalid.ok).toBe(false);
  });

  it('任务工作区查询：返回同任务所有 Agent', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a3', taskId: 't2', sessionKey: 's1' });

    const taskWs = getTaskWorkspaces('t1');
    expect(taskWs.length).toBe(2);
  });

  it('清理失败 Agent 工作区不污染其他 Agent', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });

    // 清理 a1
    cleanAgentWorkspace('a1');
    const ws1 = getAgentWorkspace('a1');
    expect(ws1?.status).toBe('cleaned');

    // a2 不受影响
    const ws2 = getAgentWorkspace('a2');
    expect(ws2?.status).toBe('active');
  });

  it('标记合并/失败状态', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });

    markMerged('a1');
    markFailed('a2');

    expect(getAgentWorkspace('a1')?.status).toBe('merged');
    expect(getAgentWorkspace('a2')?.status).toBe('failed');
  });
});

// ═══════════════════════════════════════════════════════
// 2. GitWorktreeManager
// ═══════════════════════════════════════════════════════

describe('S11 · GitWorktreeManager', () => {
  beforeEach(fullReset);

  it('创建 worktree：每个 Agent 独立分支', () => {
    const r1 = createWorktree({ agentId: 'a1', taskId: 't1' });
    const r2 = createWorktree({ agentId: 'a2', taskId: 't1' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.branchName).not.toBe(r2.value.branchName);
    }
  });

  it('文件写入隔离：不同 worktree 独立', () => {
    const wt1 = createWorktree({ agentId: 'a1', taskId: 't1' });
    const wt2 = createWorktree({ agentId: 'a2', taskId: 't1' });
    if (!wt1.ok || !wt2.ok) return;

    writeFileInWorktree(wt1.value.worktreeId, 'src/a.ts', 'content-a');
    writeFileInWorktree(wt2.value.worktreeId, 'src/b.ts', 'content-b');

    const read1 = readFileFromWorktree(wt1.value.worktreeId, 'src/a.ts');
    const read2 = readFileFromWorktree(wt2.value.worktreeId, 'src/b.ts');
    expect(read1.ok).toBe(true);
    expect(read2.ok).toBe(true);
    if (read1.ok) expect(read1.value).toBe('content-a');
    if (read2.ok) expect(read2.value).toBe('content-b');

    // a1 看不到 a2 的文件
    const crossRead = readFileFromWorktree(wt1.value.worktreeId, 'src/b.ts');
    expect(crossRead.ok).toBe(false);
  });

  it('冲突检测：同文件多分支修改', () => {
    const wt1 = createWorktree({ agentId: 'a1', taskId: 't1' });
    const wt2 = createWorktree({ agentId: 'a2', taskId: 't1' });
    if (!wt1.ok || !wt2.ok) return;

    // 两个 Agent 修改同一文件
    writeFileInWorktree(wt1.value.worktreeId, 'src/shared.ts', 'version-a');
    writeFileInWorktree(wt2.value.worktreeId, 'src/shared.ts', 'version-b');

    const conflicts = detectConflicts([wt1.value.worktreeId, wt2.value.worktreeId]);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].file).toBe('src/shared.ts');
    expect(conflicts[0].agents.length).toBe(2);
  });

  it('无冲突：不同文件修改', () => {
    const wt1 = createWorktree({ agentId: 'a1', taskId: 't1' });
    const wt2 = createWorktree({ agentId: 'a2', taskId: 't1' });
    if (!wt1.ok || !wt2.ok) return;

    writeFileInWorktree(wt1.value.worktreeId, 'src/a.ts', 'content-a');
    writeFileInWorktree(wt2.value.worktreeId, 'src/b.ts', 'content-b');

    const conflicts = detectConflicts([wt1.value.worktreeId, wt2.value.worktreeId]);
    expect(conflicts.length).toBe(0);
  });

  it('合并无冲突 worktree', () => {
    const wt1 = createWorktree({ agentId: 'a1', taskId: 't1' });
    const wt2 = createWorktree({ agentId: 'a2', taskId: 't1' });
    if (!wt1.ok || !wt2.ok) return;

    writeFileInWorktree(wt1.value.worktreeId, 'src/a.ts', 'content-a');
    writeFileInWorktree(wt2.value.worktreeId, 'src/b.ts', 'content-b');

    const result = mergeWorktrees([wt1.value.worktreeId, wt2.value.worktreeId]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
      expect(result.value.mergedBranches.length).toBe(2);
      expect(result.value.conflicts.length).toBe(0);
    }
  });

  it('合并有冲突 worktree → 标记仲裁', () => {
    const wt1 = createWorktree({ agentId: 'a1', taskId: 't1' });
    const wt2 = createWorktree({ agentId: 'a2', taskId: 't1' });
    if (!wt1.ok || !wt2.ok) return;

    writeFileInWorktree(wt1.value.worktreeId, 'src/shared.ts', 'version-a');
    writeFileInWorktree(wt2.value.worktreeId, 'src/shared.ts', 'version-b');

    const result = mergeWorktrees([wt1.value.worktreeId, wt2.value.worktreeId]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.conflicts.length).toBe(1);
      expect(result.value.conflicts[0].resolution).toBe('arbitration');
    }
  });

  it('4 个 Worker 并行改同一仓库 → 各自 worktree', () => {
    const worktrees = [];
    for (let i = 1; i <= 4; i++) {
      const wt = createWorktree({ agentId: `w${i}`, taskId: 't1' });
      expect(wt.ok).toBe(true);
      if (wt.ok) worktrees.push(wt.value);
    }

    // 每个 Worker 修改不同文件
    for (let i = 0; i < worktrees.length; i++) {
      writeFileInWorktree(worktrees[i].worktreeId, `src/module${i + 1}.ts`, `content-${i + 1}`);
    }

    // 无冲突
    const conflicts = detectConflicts(worktrees.map(w => w.worktreeId));
    expect(conflicts.length).toBe(0);

    // 全部合并成功
    const mergeResult = mergeWorktrees(worktrees.map(w => w.worktreeId));
    expect(mergeResult.ok).toBe(true);
    if (mergeResult.ok) {
      expect(mergeResult.value.success).toBe(true);
      expect(mergeResult.value.mergedBranches.length).toBe(4);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 3. ConflictPrecheck
// ═══════════════════════════════════════════════════════

describe('S11 · ConflictPrecheck', () => {
  beforeEach(fullReset);

  it('无冲突：不同 Agent 修改不同文件', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });
    recordFileModification('a1', 'src/a.ts');
    recordFileModification('a2', 'src/b.ts');

    const result = precheckConflicts({ taskId: 't1', traceId: 'tr1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hasConflicts).toBe(false);
      expect(result.value.conflicts.length).toBe(0);
    }
  });

  it('有冲突：同文件被多 Agent 修改', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });
    recordFileModification('a1', 'src/shared.ts');
    recordFileModification('a2', 'src/shared.ts');

    const result = precheckConflicts({ taskId: 't1', traceId: 'tr1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hasConflicts).toBe(true);
      expect(result.value.conflicts.length).toBe(1);
      expect(result.value.conflicts[0].agents).toContain('a1');
      expect(result.value.conflicts[0].agents).toContain('a2');
      expect(result.value.conflicts[0].resolution).toBe('arbitration');
    }
  });

  it('hasConflicts / getConflictingFiles', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });
    recordFileModification('a1', 'src/shared.ts');
    recordFileModification('a2', 'src/shared.ts');

    expect(hasConflicts('t1')).toBe(true);
    expect(getConflictingFiles('t1')).toContain('src/shared.ts');
  });
});

// ═══════════════════════════════════════════════════════
// 4. MergePhase
// ═══════════════════════════════════════════════════════

describe('S11 · MergePhase', () => {
  beforeEach(fullReset);

  it('确定性合并：不同文件直接拼装', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });
    recordFileModification('a1', 'src/a.ts');
    recordFileModification('a2', 'src/b.ts');

    const workspaces = getTaskWorkspaces('t1');
    const result = deterministicMerge({ workspaces });
    expect(result.mergedFiles.length).toBe(2);
    expect(result.conflicts.length).toBe(0);
  });

  it('确定性合并：同文件冲突 → arbitration', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });
    recordFileModification('a1', 'src/shared.ts');
    recordFileModification('a2', 'src/shared.ts');

    const workspaces = getTaskWorkspaces('t1');
    const result = deterministicMerge({ workspaces });
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].resolution).toBe('arbitration');
  });

  it('合并阶段：无冲突 → success', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });
    recordFileModification('a1', 'src/a.ts');
    recordFileModification('a2', 'src/b.ts');

    const result = executeMergePhase({ taskId: 't1', traceId: 'tr1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('success');
      expect(result.value.mergedAgents.length).toBe(2);
      expect(result.value.conflictingFiles.length).toBe(0);
    }
  });

  it('合并阶段：有冲突 → conflict', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });
    recordFileModification('a1', 'src/shared.ts');
    recordFileModification('a2', 'src/shared.ts');

    const result = executeMergePhase({ taskId: 't1', traceId: 'tr1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('conflict');
      expect(result.value.conflictingFiles).toContain('src/shared.ts');
    }
  });

  it('合并阶段：失败 Agent 不污染其他 Agent', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });
    recordFileModification('a1', 'src/a.ts');
    recordFileModification('a2', 'src/b.ts');

    const result = executeMergePhase({
      taskId: 't1', traceId: 'tr1',
      failedAgentIds: ['a2'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('partial');
      expect(result.value.mergedAgents).toContain('a1');
      expect(result.value.failedAgents).toContain('a2');
    }
  });
});

// ═══════════════════════════════════════════════════════
// 5. Gate G11 综合验证
// ═══════════════════════════════════════════════════════

describe('S11 · Gate G11 综合验证', () => {
  beforeEach(fullReset);

  it('G11-1: 4 Worker 并行改同一仓库 → 各自 worktree → 验证后合并', () => {
    // 创建 4 个 Agent 的 worktree
    const worktreeIds: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const wt = createWorktree({ agentId: `w${i}`, taskId: 't1' });
      expect(wt.ok).toBe(true);
      if (wt.ok) {
        worktreeIds.push(wt.value.worktreeId);
        // 每个 Worker 修改不同文件
        writeFileInWorktree(wt.value.worktreeId, `src/module${i}.ts`, `code-${i}`);
        commitWorktree(wt.value.worktreeId, `Worker ${i} changes`);
      }
    }

    // 无冲突 → 全部合并
    const mergeResult = mergeWorktrees(worktreeIds);
    expect(mergeResult.ok).toBe(true);
    if (mergeResult.ok) {
      expect(mergeResult.value.success).toBe(true);
      expect(mergeResult.value.mergedBranches.length).toBe(4);
    }
  });

  it('G11-2: 同文件冲突 → 检出并交仲裁，不静默覆盖', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });
    recordFileModification('a1', 'src/shared.ts');
    recordFileModification('a2', 'src/shared.ts');

    // 冲突预检测
    const precheck = precheckConflicts({ taskId: 't1', traceId: 'tr1' });
    expect(precheck.ok).toBe(true);
    if (precheck.ok) {
      expect(precheck.value.hasConflicts).toBe(true);
      expect(precheck.value.conflicts[0].resolution).toBe('arbitration');
    }

    // 合并阶段：冲突 → 不静默覆盖
    const mergeResult = executeMergePhase({ taskId: 't1', traceId: 'tr1' });
    expect(mergeResult.ok).toBe(true);
    if (mergeResult.ok) {
      expect(mergeResult.value.status).toBe('conflict');
      expect(mergeResult.value.conflictingFiles).toContain('src/shared.ts');
      // 冲突 Agent 不被合并
      expect(mergeResult.value.mergedAgents.length).toBe(0);
    }
  });

  it('G11-3: 单 Agent 失败不污染其他 Agent 产物', () => {
    createIsolatedWorkspace({ agentId: 'a1', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a2', taskId: 't1', sessionKey: 's1' });
    createIsolatedWorkspace({ agentId: 'a3', taskId: 't1', sessionKey: 's1' });
    recordFileModification('a1', 'src/a.ts');
    recordFileModification('a2', 'src/b.ts');
    recordFileModification('a3', 'src/c.ts');

    // a2 失败
    const result = executeMergePhase({
      taskId: 't1', traceId: 'tr1',
      failedAgentIds: ['a2'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mergedAgents).toContain('a1');
      expect(result.value.mergedAgents).toContain('a3');
      expect(result.value.mergedAgents).not.toContain('a2');
      expect(result.value.failedAgents).toContain('a2');

      // a1 和 a3 的工作区状态正常
      expect(getAgentWorkspace('a1')?.status).toBe('merged');
      expect(getAgentWorkspace('a3')?.status).toBe('merged');
      // a2 被清理
      expect(getAgentWorkspace('a2')?.status).toBe('cleaned');
    }
  });
});
