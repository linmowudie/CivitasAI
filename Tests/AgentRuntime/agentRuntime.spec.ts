/**
 * S9 单 Agent 端到端测试——Gate G9 验证
 *
 * 覆盖：
 * - StateMachine（6 态转换规则）
 * - AgentRegistry（注册/查询/更新）
 * - AgentFactory（创建 + 钱包分配）
 * - AgentRuntime（submitForReview + reviewSubmission）
 * - Gate G9 综合验证
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── StateMachine ─────────────────────────────────────
import {
  transition, canTransition, getAvailableEvents, getNextStates,
} from '../../Src/Core/AgentRuntime/stateMachine.js';

// ── AgentRegistry ────────────────────────────────────
import {
  registerAgent, getAgent, getAllAgents, getAgentsByStatus,
  getReadyWorkers, updateAgentStatus, getAgentCount,
  getStatusSummary, resetAgentRegistry,
} from '../../Src/Core/AgentRuntime/agentRegistry.js';

// ── AgentFactory ─────────────────────────────────────
import {
  createAgent, createAgentBatch, resetAgentFactory,
} from '../../Src/Core/AgentRuntime/agentFactory.js';

// ── AgentRuntime ─────────────────────────────────────
import {
  submitForReview, reviewSubmission, isTaskApproved,
  getPendingReviewCount, assignTask, handleAgentEvent,
  resetAgentRuntime,
} from '../../Src/Core/AgentRuntime/agentRuntime.js';

// ── ReviewerAgent ────────────────────────────────────
import { performReview, resetReviewer } from '../../Src/Services/ReviewerAgent/reviewerAgent.js';

// ── EventBus（重置用）────────────────────────────────
import { resetEventBus, initEventBus } from '../../Src/Services/EventBus/eventBus.js';

// ── WalletManager（重置用）───────────────────────────
import { resetWalletManager, initWalletManager } from '../../Src/Services/TokenEconomy/walletManager.js';

// ── 辅助 ─────────────────────────────────────────────

function fullReset() {
  resetEventBus();
  initEventBus();
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  resetAgentRegistry();
  resetAgentFactory();
  resetAgentRuntime();
  resetReviewer();
}

// ═══════════════════════════════════════════════════════
// 1. StateMachine
// ═══════════════════════════════════════════════════════

describe('S9 · StateMachine', () => {
  it('合法转换：creating → ready → running → ready', () => {
    const r1 = transition('creating', { type: 'INIT_COMPLETE' });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value).toBe('ready');

    const r2 = transition('ready', { type: 'TASK_ASSIGNED', taskId: 't1' });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toBe('running');

    const r3 = transition('running', { type: 'TASK_COMPLETED' });
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.value).toBe('ready');
  });

  it('合法转换：running → suspended → running', () => {
    const r1 = transition('running', { type: 'SUSPEND', reason: '律师函' });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value).toBe('suspended');

    const r2 = transition('suspended', { type: 'RESTORE' });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toBe('running');
  });

  it('非法转换：creating → running → 拒绝', () => {
    const r = transition('creating', { type: 'TASK_ASSIGNED', taskId: 't1' });
    expect(r.ok).toBe(false);
  });

  it('非法转换：destroyed → 任何 → 拒绝', () => {
    const r = transition('destroyed', { type: 'INIT_COMPLETE' });
    expect(r.ok).toBe(false);
  });

  it('canTransition 查询', () => {
    expect(canTransition('ready', { type: 'TASK_ASSIGNED', taskId: 't1' })).toBe(true);
    expect(canTransition('ready', { type: 'SUSPEND', reason: '' })).toBe(false);
  });

  it('getAvailableEvents', () => {
    const events = getAvailableEvents('running');
    expect(events).toContain('TASK_COMPLETED');
    expect(events).toContain('SUSPEND');
    expect(events).toContain('EXPEL');
  });

  it('getNextStates', () => {
    const next = getNextStates('running');
    expect(next).toContain('ready');
    expect(next).toContain('suspended');
    expect(next).toContain('expelled');
  });
});

// ═══════════════════════════════════════════════════════
// 2. AgentFactory
// ═══════════════════════════════════════════════════════

describe('S9 · AgentFactory', () => {
  beforeEach(fullReset);

  it('创建 Worker：自动分配钱包 + ready 状态', () => {
    const result = createAgent({ role: 'worker', model: 'gpt-4o' }, 'trace-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('ready');
      expect(result.value.role).toBe('worker');
      expect(result.value.walletId).toBeDefined();
    }
    expect(getAgentCount()).toBe(1);
  });

  it('批量创建', () => {
    const result = createAgentBatch({ role: 'worker', model: 'gpt-4o', count: 3 }, 'trace-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(3);
      expect(getAgentCount()).toBe(3);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 3. AgentRuntime · Gate G9
// ═══════════════════════════════════════════════════════

describe('S9 · AgentRuntime', () => {
  beforeEach(fullReset);

  it('任务分配：ready → running', () => {
    const agent = createAgent({ role: 'worker', model: 'gpt-4o' }, 'trace-1');
    expect(agent.ok).toBe(true);
    if (!agent.ok) return;

    const assign = assignTask(agent.value.agentId, 'task-1', 'trace-1');
    expect(assign.ok).toBe(true);
    if (assign.ok) {
      expect(assign.value.status).toBe('running');
      expect(assign.value.lastTaskId).toBe('task-1');
    }
  });

  it('G9-1: Worker 不可自行宣告完成——必须 submitForReview', () => {
    // 创建 Worker + 分配任务
    const worker = createAgent({ role: 'worker', model: 'gpt-4o' }, 'trace-1');
    if (!worker.ok) return;
    assignTask(worker.value.agentId, 'task-1', 'trace-1');

    // Worker 提交审核（不是自行完成）
    const submit = submitForReview({
      taskId: 'task-1',
      workerAgentId: worker.value.agentId,
      payload: { result: 'done' },
    });
    expect(submit.ok).toBe(true);
    if (submit.ok) expect(submit.value.status).toBe('submitted');

    // 此时任务尚未被审核通过
    expect(isTaskApproved('task-1')).toBe(false);
    expect(getPendingReviewCount()).toBe(1);
  });

  it('G9-2: Director 侧永远不会标记成功（未审核时）', () => {
    const worker = createAgent({ role: 'worker', model: 'gpt-4o' }, 'trace-1');
    if (!worker.ok) return;
    assignTask(worker.value.agentId, 'task-1', 'trace-1');

    // 未调用 submitForReview → 永远不通过
    expect(isTaskApproved('task-1')).toBe(false);

    // 调用了 submitForReview 但未经审核 → 仍不通过
    submitForReview({
      taskId: 'task-1',
      workerAgentId: worker.value.agentId,
      payload: { result: 'done' },
    });
    expect(isTaskApproved('task-1')).toBe(false);
  });

  it('G9-3: Reviewer 审核通过后 Worker 回到 ready', () => {
    // 创建 Worker + Reviewer
    const worker = createAgent({ role: 'worker', model: 'gpt-4o' }, 'trace-1');
    const reviewer = createAgent({ role: 'reviewer', model: 'gpt-4o' }, 'trace-1');
    if (!worker.ok || !reviewer.ok) return;

    // 分配任务 + Worker 提交
    assignTask(worker.value.agentId, 'task-1', 'trace-1');
    submitForReview({
      taskId: 'task-1',
      workerAgentId: worker.value.agentId,
      payload: { result: 'done' },
    });

    // Reviewer 审核通过
    const review = reviewSubmission({
      taskId: 'task-1',
      reviewerAgentId: reviewer.value.agentId,
      accepted: true,
      comment: 'LGTM',
    });
    expect(review.ok).toBe(true);
    if (review.ok) {
      expect(review.value.status).toBe('accepted');
    }

    // 任务已审核通过
    expect(isTaskApproved('task-1')).toBe(true);

    // Worker 回到 ready
    const updatedWorker = getAgent(worker.value.agentId);
    expect(updatedWorker?.status).toBe('ready');
    expect(updatedWorker?.awaitingApproval).toBe(false);
  });

  it('Reviewer 审核拒绝 → Worker 继续工作', () => {
    const worker = createAgent({ role: 'worker', model: 'gpt-4o' }, 'trace-1');
    const reviewer = createAgent({ role: 'reviewer', model: 'gpt-4o' }, 'trace-1');
    if (!worker.ok || !reviewer.ok) return;

    assignTask(worker.value.agentId, 'task-1', 'trace-1');
    submitForReview({
      taskId: 'task-1',
      workerAgentId: worker.value.agentId,
      payload: { result: 'incomplete' },
    });

    // 审核拒绝
    const review = reviewSubmission({
      taskId: 'task-1',
      reviewerAgentId: reviewer.value.agentId,
      accepted: false,
      comment: '需要更多工作',
    });
    expect(review.ok).toBe(true);
    if (review.ok) expect(review.value.status).toBe('rejected');

    // Worker 不回到 ready（仍在 running）
    const updatedWorker = getAgent(worker.value.agentId);
    expect(updatedWorker?.status).toBe('running');
    expect(updatedWorker?.consecutiveFailures).toBe(1);
  });

  it('performReview（ReviewerAgent 集成）', () => {
    const worker = createAgent({ role: 'worker', model: 'gpt-4o' }, 'trace-1');
    const reviewer = createAgent({ role: 'reviewer', model: 'gpt-4o' }, 'trace-1');
    if (!worker.ok || !reviewer.ok) return;

    assignTask(worker.value.agentId, 'task-1', 'trace-1');
    submitForReview({
      taskId: 'task-1',
      workerAgentId: worker.value.agentId,
      payload: { result: 'done' },
    });

    const result = performReview({
      taskId: 'task-1',
      reviewerAgentId: reviewer.value.agentId,
    });
    expect(result.ok).toBe(true);
    expect(isTaskApproved('task-1')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 4. Gate G9 综合验证
// ═══════════════════════════════════════════════════════

describe('S9 · Gate G9 综合验证', () => {
  beforeEach(fullReset);

  it('G9-complete: Worker 完整生命周期', () => {
    // 1. 创建 Worker + Reviewer
    const worker = createAgent({ role: 'worker', model: 'gpt-4o' }, 'trace-1');
    const reviewer = createAgent({ role: 'reviewer', model: 'gpt-4o' }, 'trace-1');
    expect(worker.ok).toBe(true);
    expect(reviewer.ok).toBe(true);
    if (!worker.ok || !reviewer.ok) return;

    // 2. 初始状态 = ready
    expect(worker.value.status).toBe('ready');

    // 3. 分配任务 → running
    assignTask(worker.value.agentId, 'task-1', 'trace-1');
    expect(getAgent(worker.value.agentId)?.status).toBe('running');

    // 4. Worker 提交审核
    submitForReview({
      taskId: 'task-1',
      workerAgentId: worker.value.agentId,
      payload: { artifacts: ['file1.ts'] },
    });
    expect(getAgent(worker.value.agentId)?.awaitingApproval).toBe(true);

    // 5. 未审核前 → 任务未通过
    expect(isTaskApproved('task-1')).toBe(false);

    // 6. Reviewer 审核通过
    performReview({
      taskId: 'task-1',
      reviewerAgentId: reviewer.value.agentId,
    });

    // 7. 任务已通过 + Worker 回到 ready
    expect(isTaskApproved('task-1')).toBe(true);
    expect(getAgent(worker.value.agentId)?.status).toBe('ready');
    expect(getAgent(worker.value.agentId)?.awaitingApproval).toBe(false);
  });

  it('G9: 挂起 + 恢复流程', () => {
    const worker = createAgent({ role: 'worker', model: 'gpt-4o' }, 'trace-1');
    if (!worker.ok) return;
    assignTask(worker.value.agentId, 'task-1', 'trace-1');

    // 挂起（律师函）
    const suspend = handleAgentEvent(worker.value.agentId, { type: 'SUSPEND', reason: '律师函' });
    expect(suspend.ok).toBe(true);
    expect(getAgent(worker.value.agentId)?.status).toBe('suspended');

    // 恢复
    const restore = handleAgentEvent(worker.value.agentId, { type: 'RESTORE' });
    expect(restore.ok).toBe(true);
    expect(getAgent(worker.value.agentId)?.status).toBe('running');
  });

  it('G9: 状态摘要统计', () => {
    createAgent({ role: 'worker', model: 'gpt-4o' }, 'trace-1');
    createAgent({ role: 'worker', model: 'gpt-4o' }, 'trace-1');
    createAgent({ role: 'reviewer', model: 'gpt-4o' }, 'trace-1');

    const summary = getStatusSummary();
    expect(summary.ready).toBe(3);
    expect(summary.running).toBe(0);
  });
});
