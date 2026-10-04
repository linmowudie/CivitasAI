/**
 * FE-050 · 编排三链路端到端（2026-10-04，派发 → 评审 → 聚合）
 *
 * 三条链路按统一 ID 空间串联：`subtask_id` = `assignmentId` =
 * Agent `lastTaskId` = 评审 `taskId`。
 *
 *  1. 派发链路：receiveTask → 三模式（DELEGATION / ASSEMBLY_LINE / CONSORTIUM）
 *     全部落库（tasks 行 + sessions 基座 + subtasks 派发），Agent 真实指派（ready → running）；
 *  2. 评审链路：agent.submit_review 实装 —— 提交（awaitingApproval）→
 *     独立 Reviewer 创建/复用（Maker-Checker 分离）→ 规则审核 → subtasks 台账回写；
 *  3. 聚合链路：最后一个子任务终态 → TASK_COMPLETED(assignmentId) 事件驱动
 *     finalizeOrchestration → aggregateResults → tasks 行回写终态、计划出册。
 *
 * 修复前的三处断链（本文件为回归护栏）：
 *  - tasks / subtasks 表无写入方（任务书只存在内存，重启即丢）；
 *  - submit_review 为 NOT_IMPLEMENTED 桩，且生产代码无 reviewer 创建点；
 *  - mergePhase / aggregateResults 零调用（结果永不聚合）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

// ── DB ────────────────────────────────────────────────
import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { getTaskRow } from '../../Src/Infra/Db/Repositories/taskRepository.js';
import { getSubtask, listSubtasksByTask } from '../../Src/Infra/Db/Repositories/subtaskRepository.js';

// ── 编排链路 ──────────────────────────────────────────
import {
  receiveTask, resetOrchestrator, finalizeOrchestration,
} from '../../Src/Core/Decision/orchestrator/orchestrator.js';
import { updateProgress, resetProgressTracker } from '../../Src/Core/Decision/orchestrator/progressTracker.js';
import { resetAggregator } from '../../Src/Core/Decision/orchestrator/resultAggregator.js';
import { resetDecomposer } from '../../Src/Core/Decision/TaskDecomposer/taskDecomposer.js';
import { resetAssessor } from '../../Src/Core/Decision/complexityAssessor/complexityAssessor.js';
import { updateRoutingRules, resetRoutingRules } from '../../Src/Core/Decision/routeDecision/routingRules.js';

// ── AgentRuntime ──────────────────────────────────────
import { resetAgentRegistry, getAgent, getAgentsByRole } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import { resetAgentFactory } from '../../Src/Core/AgentRuntime/agentFactory.js';
import { resetAgentRuntime, getPendingReview, submitForReview } from '../../Src/Core/AgentRuntime/agentRuntime.js';
import { resetReviewer, ensureReviewerAgent, performReview } from '../../Src/Services/ReviewerAgent/reviewerAgent.js';
import { markSubtaskReviewed } from '../../Src/Core/Decision/orchestrator/subtaskDispatcher.js';

// ── 工具层 / 事件 / 钱包 / 属主 ───────────────────────
import { clearRegistry, executeTool } from '../../Src/Tools/Registry/toolRegistry.js';
import { registerBuiltinTools } from '../../Src/Tools/builtinLoader.js';
import { configureToolServicePorts } from '../../Src/Tools/Registry/toolServicePorts.js';
import { resetEventBus, initEventBus } from '../../Src/Services/EventBus/eventBus.js';
import { resetWalletManager, initWalletManager } from '../../Src/Services/TokenEconomy/walletManager.js';
import { setActiveOwner } from '../../Src/Services/AccountScope/activeAccount.js';

// ── 测试基础设施 ──────────────────────────────────────

const DIR = resolve(import.meta.dirname, '../../Data/_test_orch_pipelines');
const OWNER = 'alice';

function initDb(): void {
  closeDatabase(); clearMigrations();
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  initDatabase({
    mainPath: join(DIR, 'm.db'), eventsPath: join(DIR, 'e.db'), memoryPath: join(DIR, 'mm.db'),
    walMode: true, busyTimeoutMs: 5000,
  });
  initMigrations();
  const up = migrateUp();
  expect(up.ok, up.ok ? '' : String(up.error)).toBe(true);
}

function fullReset(): void {
  resetEventBus();
  initEventBus();
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  resetAgentRegistry();
  resetAgentFactory();
  resetAgentRuntime();
  resetOrchestrator();
  resetProgressTracker();
  resetAggregator();
  resetDecomposer();
  resetAssessor();
  resetRoutingRules();
  resetReviewer();
  clearRegistry();
  registerBuiltinTools();
  setActiveOwner(OWNER);
  // 分层修正（2026-10-04）：agent.submit_review 经端口注入评审链路服务（Tools 不可直连 Services/Core）
  configureToolServicePorts({
    review: { submitForReview, ensureReviewerAgent, performReview, markSubtaskReviewed },
  });
}

/** 事件为异步分发（EventBus Promise 化）：等待微任务/事件循环跑完再断言 */
const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

/** DELEGATION 强控规则：禁 CONSORTIUM / SOP，放宽耦合容忍度（2 域 × coupling 0.4 命中） */
function forceDelegationRules(): void {
  updateRoutingRules({
    consortiumTokenThreshold: 999999,
    consortiumDomainThreshold: 99,
    assemblyLineSopRequired: false,
    delegationMaxCouplingScore: 0.5,
  });
}

/** 双域独立任务（backend + frontend，无跨域关键词 → coupling 0.4 → 2 个子任务） */
const DELEGATION_DESC = '开发独立的后端 server 和前端 ui 模块';

beforeEach(() => { initDb(); fullReset(); });
afterEach(() => {
  closeDatabase(); clearMigrations();
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════
// 1. 派发链路（subtasks 落库 + Agent 真实指派）
// ═══════════════════════════════════════════════════════

describe('FE-050 · 派发链路', () => {
  it('★ DELEGATION 全链落库：tasks 行 + sessions 基座 + subtasks 派发 + Agent 指派', () => {
    forceDelegationRules();
    const result = receiveTask({
      taskId: 'task-dispatch-1',
      traceId: 'trace-dispatch-1',
      taskDescription: DELEGATION_DESC,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.routingMode).toBe('DELEGATION');
    const plan = result.value.taskPlan!;
    expect(plan.assignments.length).toBe(2);

    // [1] tasks 行落库（修复前：tasks 表全仓无写入方）
    const taskRow = getTaskRow('task-dispatch-1')!;
    expect(taskRow).toBeDefined();
    expect(taskRow.status).toBe('running');
    expect(taskRow.route_mode).toBe('DELEGATION');
    expect(taskRow.trace_id).toBe('trace-dispatch-1');
    expect(taskRow.user_request).toContain('后端');
    expect(taskRow.started_at).toBeTruthy();

    // [2] sessions 运行基座行（FK 链：subtasks.task_id → tasks.session_key → sessions）
    const sessionRow = getMainDb()
      .prepare('SELECT * FROM sessions WHERE session_key = ?')
      .get('run-trace-dispatch-1') as { status: string } | undefined;
    expect(sessionRow).toBeDefined();
    expect(sessionRow!.status).toBe('active');

    // [3] subtasks 派发（修复前：subtasks 表无派发器）
    const rows = listSubtasksByTask('task-dispatch-1');
    expect(rows.length).toBe(2);
    const byId = new Map(rows.map(r => [r.subtask_id, r]));
    for (const assignment of plan.assignments) {
      const row = byId.get(assignment.assignmentId);
      expect(row, `子任务 ${assignment.assignmentId} 未落库`).toBeDefined();
      expect(row!.task_id).toBe('task-dispatch-1');
      expect(row!.status).toBe('assigned');
      expect(row!.assigned_agent_id).toBeTruthy();
      expect(row!.assigned_agent_id).toBe(assignment.assignedAgentId);
      expect(row!.token_budget).toBe(assignment.tokenBudget);
      expect(row!.max_iterations).toBe(assignment.maxIterations);
    }

    // [4] Agent 真实指派：ready → running，lastTaskId 对齐统一 ID 空间
    const workers = getAgentsByRole('worker');
    expect(workers.length).toBe(2);
    for (const worker of workers) {
      expect(worker.status).toBe('running');
      expect(plan.assignments.some(a => a.assignmentId === worker.lastTaskId)).toBe(true);
    }
  });

  it('★ ASSEMBLY_LINE 节点被真实指派（修复前流水线 Agent 停在 ready 从未执行）', () => {
    updateRoutingRules({ consortiumTokenThreshold: 999999, consortiumDomainThreshold: 99 });
    const result = receiveTask({
      taskId: 'task-asm-1',
      traceId: 'trace-asm-1',
      taskDescription: '对代码进行 code review 审查：检查后端 api 接口 server 与前端 ui 页面组件',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.routingMode).toBe('ASSEMBLY_LINE');
    const plan = result.value.taskPlan!;
    expect(plan.assignments.length).toBe(2);

    // 流水线依赖链：后一节点依赖前一节点
    for (let i = 1; i < plan.assignments.length; i++) {
      expect(plan.assignments[i]!.dependsOn).toEqual([plan.assignments[i - 1]!.assignmentId]);
    }

    // 修复前缺陷：流水线节点从未 assignTask（Agent 全部停在 ready）
    const workers = getAgentsByRole('worker');
    expect(workers.length).toBe(2);
    for (const worker of workers) {
      expect(worker.status).toBe('running');
    }

    // subtasks 落库与 Agent 一一对应
    const rows = listSubtasksByTask('task-asm-1');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.status).toBe('assigned');
      expect(row.assigned_agent_id).toBeTruthy();
      expect(workers.some(w => w.agentId === row.assigned_agent_id)).toBe(true);
    }
  });

  it('★ CONSORTIUM 攻坚 Partner 被真实指派（修复前攻坚 Partner 停在 ready 从未执行）', () => {
    // 默认规则：2 域 ≥ consortiumDomainThreshold(2) → CONSORTIUM
    const result = receiveTask({
      taskId: 'task-con-1',
      traceId: 'trace-con-1',
      taskDescription: '开发后端 server api 接口和前端 ui 页面组件',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.routingMode).toBe('CONSORTIUM');
    const plan = result.value.taskPlan!;
    expect(plan.assignments.length).toBe(2);

    const partners = getAgentsByRole('partner');
    expect(partners.length).toBe(2);
    for (const partner of partners) {
      expect(partner.status).toBe('running');
    }

    const rows = listSubtasksByTask('task-con-1');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.status).toBe('assigned');
      expect(partners.some(p => p.agentId === row.assigned_agent_id)).toBe(true);
    }
  });

  it('落库按属主隔离：bob 查不到 alice 的编排痕迹', () => {
    forceDelegationRules();
    receiveTask({ taskId: 'task-iso-1', traceId: 'trace-iso-1', taskDescription: DELEGATION_DESC });
    expect(getTaskRow('task-iso-1')).toBeDefined();

    setActiveOwner('bob');
    expect(getTaskRow('task-iso-1')).toBeUndefined();
    expect(listSubtasksByTask('task-iso-1').length).toBe(0);

    setActiveOwner(OWNER);
    expect(getTaskRow('task-iso-1')).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════
// 2. 评审链路（submit_review 实装 + 独立 Reviewer）
// ═══════════════════════════════════════════════════════

describe('FE-050 · 评审链路', () => {
  const TASK_ID = 'task-review-1';
  const TRACE_ID = 'trace-review-1';

  it('★ 提交 → 独立 Reviewer → 台账回写全链', async () => {
    forceDelegationRules();
    const result = receiveTask({ taskId: TASK_ID, traceId: TRACE_ID, taskDescription: DELEGATION_DESC });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.value.taskPlan!;
    const first = listSubtasksByTask(TASK_ID).find(r => r.subtask_id === plan.assignments[0]!.assignmentId)!;
    const workerId = first.assigned_agent_id!;
    expect(getAgent(workerId)!.status).toBe('running');

    const exec = await executeTool('agent.submit_review', {
      taskId: first.subtask_id,
      summary: '后端模块开发完成（含单元测试）',
    }, {
      operationId: 'op-review-1',
      agentId: workerId,
      agentRole: 'worker',
      traceId: TRACE_ID,
    });
    await flushAsync();

    expect(exec.status).toBe('success');
    const content = JSON.parse(String(exec.content)) as {
      reviewId: string; taskId: string; status: string; reviewerAgentId: string; comment?: string;
    };
    expect(content.status).toBe('accepted');
    expect(content.reviewId).toMatch(/^review-/);
    expect(content.taskId).toBe(first.subtask_id);

    // 独立 Reviewer 真实创建（修复前：生产代码无 reviewer 创建点）
    const reviewers = getAgentsByRole('reviewer');
    expect(reviewers.length).toBe(1);
    expect(reviewers[0]!.traceId).toBe(TRACE_ID);
    expect(content.reviewerAgentId).toBe(reviewers[0]!.agentId);
    expect(reviewers[0]!.agentId).not.toBe(workerId); // Maker-Checker 分离

    // Worker：评审通过 → running → ready；待审批标记清除
    expect(getAgent(workerId)!.status).toBe('ready');
    expect(getAgent(workerId)!.awaitingApproval).toBe(false);

    // subtasks 台账回写（统一 ID 空间：评审 taskId = subtask_id）
    const updated = getSubtask(first.subtask_id)!;
    expect(updated.status).toBe('completed');
    expect(updated.completed_at).toBeTruthy();

    // 待审记录闭环
    const review = getPendingReview(first.subtask_id)!;
    expect(review.status).toBe('accepted');
    expect(review.reviewId).toBe(content.reviewId);
  });

  it('★ Reviewer 按 trace 复用：多子任务连续提交不重复创建', async () => {
    forceDelegationRules();
    const result = receiveTask({ taskId: TASK_ID, traceId: TRACE_ID, taskDescription: DELEGATION_DESC });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.value.taskPlan!;

    for (const assignment of plan.assignments) {
      const row = listSubtasksByTask(TASK_ID).find(r => r.subtask_id === assignment.assignmentId)!;
      const exec = await executeTool('agent.submit_review', {
        taskId: assignment.assignmentId,
        summary: `子任务 ${assignment.subtaskIndex + 1} 完成`,
      }, {
        operationId: `op-review-${assignment.subtaskIndex}`,
        agentId: row.assigned_agent_id!,
        agentRole: 'worker',
        traceId: TRACE_ID,
      });
      expect(exec.status).toBe('success');
      await flushAsync();
    }

    expect(getAgentsByRole('reviewer').length).toBe(1);
    for (const assignment of plan.assignments) {
      expect(getSubtask(assignment.assignmentId)!.status).toBe('completed');
    }
  });

  it('★ 非执行级角色 → ROLE_FORBIDDEN（requiredRoles 硬校验）', async () => {
    const denied = await executeTool('agent.submit_review', {
      taskId: 'whatever', summary: '无权限提交',
    }, {
      operationId: 'op-denied',
      agentId: 'agent-prime_director-1',
      agentRole: 'prime_director',
      traceId: TRACE_ID,
    });
    expect(denied.status).toBe('error');
    expect(denied.error?.code).toBe('ROLE_FORBIDDEN');
  });
});

// ═══════════════════════════════════════════════════════
// 3. 聚合链路（finalizeOrchestration 事件驱动）
// ═══════════════════════════════════════════════════════

describe('FE-050 · 聚合链路', () => {
  const TASK_ID = 'task-agg-1';
  const TRACE_ID = 'trace-agg-1';

  it('★ 全部子任务通过评审 → 事件驱动自动聚合 → tasks 行回写终态 + 计划出册', async () => {
    forceDelegationRules();
    const result = receiveTask({ taskId: TASK_ID, traceId: TRACE_ID, taskDescription: DELEGATION_DESC });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.value.taskPlan!;
    expect(plan.assignments.length).toBe(2);

    // 逐个提交评审：第二次提交触发 TASK_COMPLETED(assignmentId) → 全部终态 → finalize
    for (const assignment of plan.assignments) {
      const row = listSubtasksByTask(TASK_ID).find(r => r.subtask_id === assignment.assignmentId)!;
      const exec = await executeTool('agent.submit_review', {
        taskId: assignment.assignmentId,
        summary: '完成',
      }, {
        operationId: `op-agg-${assignment.subtaskIndex}`,
        agentId: row.assigned_agent_id!,
        agentRole: 'worker',
        traceId: TRACE_ID,
      });
      expect(exec.status).toBe('success');
      await flushAsync();
    }

    // tasks 行回写终态（修复前：mergePhase/aggregateResults 零调用，结果永不聚合）
    const taskRow = getTaskRow(TASK_ID)!;
    expect(taskRow.status).toBe('completed');
    expect(taskRow.completed_at).toBeTruthy();

    const finalResult = JSON.parse(taskRow.final_result!) as Record<string, unknown>;
    expect(finalResult._summary).toEqual({ total: 2, success: 2, failed: 0, partial: 0 });
    expect(finalResult[plan.assignments[0]!.assignmentId]).toBeDefined();
    expect(finalResult[plan.assignments[1]!.assignmentId]).toBeDefined();

    // 计划已出册：重复聚合被拒绝（防汇总事件回路重入）
    expect(finalizeOrchestration(TASK_ID).ok).toBe(false);
  });

  it('★ 子任务失败 → 聚合判 failed 回写；无活跃计划拒绝聚合', () => {
    forceDelegationRules();
    const result = receiveTask({ taskId: TASK_ID, traceId: TRACE_ID, taskDescription: DELEGATION_DESC });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.value.taskPlan!;

    // 模拟执行失败：直接置终态（不经评审链路）
    for (const assignment of plan.assignments) {
      updateProgress(assignment.assignmentId, null, { status: 'failed' });
    }

    const agg = finalizeOrchestration(TASK_ID);
    expect(agg.ok).toBe(true);
    if (agg.ok) expect(agg.value.status).toBe('failed');

    const taskRow = getTaskRow(TASK_ID)!;
    expect(taskRow.status).toBe('failed');
    const finalResult = JSON.parse(taskRow.final_result!) as { _summary: Record<string, number> };
    expect(finalResult._summary.failed).toBe(2);

    expect(finalizeOrchestration(TASK_ID).ok).toBe(false);          // 已出册
    expect(finalizeOrchestration('task-nonexistent').ok).toBe(false); // 从未注册
  });
});
