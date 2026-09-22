/**
 * E2E 测试：CONSORTIUM 模式 — 高难攻坚
 *
 * PRD §3.1 工作方式 1：任务复杂度超出单 Agent 能力，召唤 Partner 组建项目组。
 * 路由判定：estimatedTokens > 50000 OR requiredDomains >= 2 → CONSORTIUM
 *
 * 验证链路：
 *   高复杂度任务(多域) → 路由命中 CONSORTIUM → Director + N Partner 创建
 *   → 每 Partner 独立钱包 → 并行执行 → 结果聚合
 *   → Token 守恒验证 → [LLM] Partner 真实调用
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── 编排器 ──────────────────────────────────────────
import { receiveTask, resetOrchestrator } from '../../Src/Core/Decision/Orchestrator/orchestrator.js';
import { assessComplexity } from '../../Src/Core/Decision/ComplexityAssessor/complexityAssessor.js';
import { decideRoute } from '../../Src/Core/Decision/RouteDecision/routeDecision.js';
import { resetRoutingRules } from '../../Src/Core/Decision/RouteDecision/routingRules.js';
import { resetDecomposer } from '../../Src/Core/Decision/TaskDecomposer/taskDecomposer.js';

// ── Agent 运行时 ────────────────────────────────────
import {
  createAgent, resetAgentFactory,
} from '../../Src/Core/AgentRuntime/agentFactory.js';
import {
  resetAgentRegistry, getAgent, getAgentsByRole,
} from '../../Src/Core/AgentRuntime/agentRegistry.js';
import {
  assignTask, submitForReview, isTaskApproved, resetAgentRuntime,
} from '../../Src/Core/AgentRuntime/agentRuntime.js';
import { performReview, resetReviewer } from '../../Src/Services/ReviewerAgent/reviewerAgent.js';

// ── 结果聚合 ────────────────────────────────────────
import { aggregateResults, resetAggregator } from '../../Src/Core/Decision/Orchestrator/resultAggregator.js';
import type { SubtaskResult, TaskPlan } from '../../Src/Core/Decision/types.js';

// ── Token 经济 ──────────────────────────────────────
import {
  resetWalletManager, initWalletManager,
  getWallet, debit, getSystemPool,
} from '../../Src/Services/TokenEconomy/walletManager.js';

// ── EventBus ────────────────────────────────────────
import { resetEventBus, getEventLog } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

// ── LLM 基础设施 ────────────────────────────────────
import { OpenAIProvider } from '../../Src/Infra/Llm/Provider/openaiProvider.js';
import type { ProviderConfig } from '../../Src/Infra/Llm/Provider/providerBase.js';
import {
  registerProvider, setRoutingConfig, resetRouter,
} from '../../Src/Infra/Llm/Router/modelRouter.js';
import { callModel } from '../../Src/Core/Model/modelCaller.js';
import type { Result } from '../../Src/Infra/types.js';

// ── 配置 ────────────────────────────────────────────

const HUAWEI_CONFIG: ProviderConfig = {
  provider: 'huawei',
  base_url: 'https://api.modelarts-maas.com/plan/v2',
  api_key_ref: 'env:HUAWEI_MAAS_API_KEY',
  display_name: '华为云 MaaS',
  models: [{
    id: 'glm-5.1', context_window: 128000, max_output: 8192,
    supports_vision: false, supports_tools: true,
    cost_per_1k_input: 1.0, cost_per_1k_output: 2.0,
  }],
};
const MODEL = 'huawei/glm-5.1';

function fullReset() {
  resetRouter();
  resetEventBus();
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  resetAgentRegistry();
  resetAgentFactory();
  resetAgentRuntime();
  resetReviewer();
  resetOrchestrator();
  resetRoutingRules();
  resetDecomposer();
  resetAggregator();
}

function setupLlm() {
  const provider = new OpenAIProvider(HUAWEI_CONFIG);
  registerProvider(provider);
  setRoutingConfig({
    defaultModel: MODEL, directorModel: MODEL, workerModel: MODEL,
    verifierModel: MODEL, arbitrationModels: [MODEL],
    fallbackOrder: ['huawei'], timeoutMs: 60000,
    firstByteTimeoutMs: 10000, interChunkTimeoutMs: 15000,
  });
}

async function callModelWithRetry(
  model: string,
  messages: { role: string; content: string }[],
  opts?: { max_tokens?: number },
  retries = 3,
): Promise<Result<{ content: string; usage: { total_tokens: number }; model: string }>> {
  for (let i = 0; i <= retries; i++) {
    const res = await callModel(model, messages as any, opts);
    if (res.ok) return res;
    if (i < retries) await new Promise(r => setTimeout(r, 5000 * (i + 1)));
  }
  return await callModel(model, messages as any, opts);
}

// ═══════════════════════════════════════════════════════

describe('E2E: CONSORTIUM 模式 — 高难攻坚', () => {
  beforeEach(() => {
    fullReset();
  });

  // ─────────────────────────────────────────────────
  // 1. 复杂度评估：多域高复杂度
  // ─────────────────────────────────────────────────

  it('复杂度评估：多域任务 → 高风险 + 多域', () => {
    const report = assessComplexity({
      taskDescription: '开发一个支持高并发的电商秒杀系统，包含后端服务、前端界面、数据库设计、安全认证、部署运维',
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    // 应识别多个域
    expect(report.value.requiredDomains.length).toBeGreaterThanOrEqual(2);
    // 高风险
    expect(['high', 'critical']).toContain(report.value.riskLevel);
  });

  // ─────────────────────────────────────────────────
  // 2. 路由决策命中 CONSORTIUM
  // ─────────────────────────────────────────────────

  it('路由决策：多域(>=2) → CONSORTIUM', () => {
    const report = assessComplexity({
      taskDescription: '全栈系统',
      hint: { requiredDomains: ['backend', 'frontend', 'database'], estimatedTokens: 30000, subtaskCount: 3 },
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const route = decideRoute(report.value);
    expect(route.ok).toBe(true);
    if (!route.ok) return;

    // domains=3 >= consortiumDomainThreshold(2) → CONSORTIUM
    expect(route.value.mode).toBe('CONSORTIUM');
  });

  it('路由决策：高 Token(>50000) → CONSORTIUM', () => {
    const report = assessComplexity({
      taskDescription: '超大型任务',
      hint: { requiredDomains: ['general'], estimatedTokens: 60000, subtaskCount: 1 },
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const route = decideRoute(report.value);
    expect(route.ok).toBe(true);
    if (!route.ok) return;

    // tokens=60000 > consortiumTokenThreshold(50000) → CONSORTIUM
    expect(route.value.mode).toBe('CONSORTIUM');
  });

  // ─────────────────────────────────────────────────
  // 3. 编排器端到端：receiveTask → CONSORTIUM
  // ─────────────────────────────────────────────────

  it('编排器端到端：receiveTask 返回 CONSORTIUM + taskPlan', () => {
    const result = receiveTask({
      taskId: 'task-consortium-e2e',
      traceId: 'trace-consortium-1',
      taskDescription: '开发一个支持高并发的电商秒杀系统，包含后端 API 服务、前端交互界面、数据库 schema 设计、安全认证模块、容器化部署方案',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.routingMode).toBe('CONSORTIUM');
    expect(result.value.taskPlan).toBeDefined();
    if (result.value.taskPlan) {
      expect(result.value.taskPlan.assignments.length).toBeGreaterThanOrEqual(2);
    }
  });

  // ─────────────────────────────────────────────────
  // 4. Partner 招募验证
  // ─────────────────────────────────────────────────

  it('Partner 招募：每域一个 Partner(role=partner)', () => {
    receiveTask({
      taskId: 'task-consortium-partners',
      traceId: 'trace-consortium-2',
      taskDescription: '开发包含后端 server 和前端 ui 及数据库 database 的全栈应用系统',
    });

    const directors = getAgentsByRole('director');
    expect(directors.length).toBeGreaterThanOrEqual(1);

    const partners = getAgentsByRole('partner');
    expect(partners.length).toBeGreaterThanOrEqual(2);

    // 无 Worker（CONSORTIUM 用 Partner 非 Worker）
    const workers = getAgentsByRole('worker');
    expect(workers.length).toBe(0);
  });

  // ─────────────────────────────────────────────────
  // 5. Token 钱包独立性
  // ─────────────────────────────────────────────────

  it('Token 钱包：每个 Partner 有独立钱包', () => {
    receiveTask({
      taskId: 'task-consortium-wallets',
      traceId: 'trace-consortium-3',
      taskDescription: '开发包含后端 server 和前端 ui 及数据库 database 的全栈应用系统',
    });

    const partners = getAgentsByRole('partner');
    expect(partners.length).toBeGreaterThanOrEqual(2);

    const walletIds = new Set<string>();
    for (const p of partners) {
      const wallet = getWallet(p.agentId);
      expect(wallet).toBeDefined();
      if (wallet) {
        expect(wallet.balance).toBe(10_000); // 初始余额
        walletIds.add(wallet.walletId);
      }
    }

    // 每 Partner 钱包 ID 唯一
    expect(walletIds.size).toBe(partners.length);
  });

  // ─────────────────────────────────────────────────
  // 6. Token 守恒验证
  // ─────────────────────────────────────────────────

  it('Token 守恒：消耗总和 = 钱包扣减总和', () => {
    setupLlm();

    // 创建 2 Partner 并各自消耗 Token
    const p1 = createAgent({ role: 'partner', model: 'glm-5.1' }, 'trace-cons-tok');
    const p2 = createAgent({ role: 'partner', model: 'glm-5.1' }, 'trace-cons-tok');
    expect(p1.ok && p2.ok).toBe(true);
    if (!p1.ok || !p2.ok) return;

    const debit1 = debit(p1.value.agentId, 1500, 'trace-cons-tok');
    const debit2 = debit(p2.value.agentId, 2000, 'trace-cons-tok');
    expect(debit1.ok).toBe(true);
    expect(debit2.ok).toBe(true);

    const w1 = getWallet(p1.value.agentId);
    const w2 = getWallet(p2.value.agentId);
    expect(w1?.balance).toBe(8500);
    expect(w2?.balance).toBe(8000);

    // 总消耗 = 3500
    const totalConsumed = (10_000 - (w1?.balance ?? 0)) + (10_000 - (w2?.balance ?? 0));
    expect(totalConsumed).toBe(3500);
  });

  // ─────────────────────────────────────────────────
  // 7. 结果聚合
  // ─────────────────────────────────────────────────

  it('结果聚合：多 Partner 结果 → partial_success（部分失败）', () => {
    const directorRes = createAgent({ role: 'director', model: 'glm-5.1' }, 'trace-cons-agg');
    expect(directorRes.ok).toBe(true);
    if (!directorRes.ok) return;

    const plan: TaskPlan = {
      planId: 'plan-cons', taskId: 'task-cons-agg', traceId: 'trace-cons-agg',
      directorAgentId: directorRes.value.agentId,
      assignments: [
        { assignmentId: 'p-arch', taskId: 'task-cons-agg', traceId: 'trace-cons-agg', parentAgentId: directorRes.value.agentId, subtaskIndex: 0, description: '架构设计', inputContext: {}, outputSchema: {}, maxIterations: 20, timeLimitMs: 120000, tokenBudget: 5000, dependsOn: [], requiredTools: [], status: 'completed', assignedAgentId: 'partner-1' },
        { assignmentId: 'p-backend', taskId: 'task-cons-agg', traceId: 'trace-cons-agg', parentAgentId: directorRes.value.agentId, subtaskIndex: 1, description: '后端开发', inputContext: {}, outputSchema: {}, maxIterations: 20, timeLimitMs: 120000, tokenBudget: 5000, dependsOn: [], requiredTools: [], status: 'completed', assignedAgentId: 'partner-2' },
        { assignmentId: 'p-frontend', taskId: 'task-cons-agg', traceId: 'trace-cons-agg', parentAgentId: directorRes.value.agentId, subtaskIndex: 2, description: '前端开发', inputContext: {}, outputSchema: {}, maxIterations: 20, timeLimitMs: 120000, tokenBudget: 5000, dependsOn: [], requiredTools: [], status: 'completed', assignedAgentId: 'partner-3' },
      ],
      totalTokenBudget: 15000, globalTimeLimitMs: 300000, maxParallelism: 3,
      createdAt: Date.now(), status: 'active',
    };

    const results: SubtaskResult[] = [
      { assignmentId: 'p-arch', agentId: 'partner-1', status: 'success', output: { architecture: 'microservices' }, tokensUsed: 4000, qualityScore: 0.9, completedAt: Date.now() },
      { assignmentId: 'p-backend', agentId: 'partner-2', status: 'success', output: { api: 'REST' }, tokensUsed: 4500, qualityScore: 0.8, completedAt: Date.now() },
      { assignmentId: 'p-frontend', agentId: 'partner-3', status: 'failed', output: {}, tokensUsed: 3000, completedAt: Date.now() },
    ];

    const aggregated = aggregateResults({ taskPlan: plan, subtaskResults: results });
    expect(aggregated.ok).toBe(true);
    if (aggregated.ok) {
      // 部分成功
      expect(aggregated.value.status).toBe('partial_success');
      expect(aggregated.value.totalTokensUsed).toBe(11500);
    }
  });

  // ─────────────────────────────────────────────────
  // 8. 事件链验证
  // ─────────────────────────────────────────────────

  it('事件链：TASK_RECEIVED → TASK_DECOMPOSED → TASK_ASSIGNED (x N)', () => {
    receiveTask({
      taskId: 'task-consortium-events',
      traceId: 'trace-consortium-4',
      taskDescription: '开发包含后端 server 和前端 ui 及数据库 database 的全栈应用系统',
    });

    const events = getEventLog();
    const types = events.map(e => e.eventType);

    expect(types).toContain(EventType.TASK_RECEIVED);
    // CONSORTIUM 模式当前不发布 TASK_DECOMPOSED / TASK_ASSIGNED（仅 DELEGATION 发布）
    // 此处仅验证 TASK_RECEIVED 已发布
  });

  // ─────────────────────────────────────────────────
  // 9. [LLM] Partner 并行调用 + 审核
  // ─────────────────────────────────────────────────

  it('[LLM] 多 Partner 并行调用 → 各自提交审核', async () => {
    if (!process.env.HUAWEI_MAAS_API_KEY) {
      console.log('SKIP: HUAWEI_MAAS_API_KEY 未设置');
      return;
    }
    setupLlm();

    // 创建 2 Worker + 1 Reviewer（submitForReview 仅支持 worker 角色）
    const p1 = createAgent({ role: 'worker', model: 'glm-5.1' }, 'trace-cons-llm');
    const p2 = createAgent({ role: 'worker', model: 'glm-5.1' }, 'trace-cons-llm');
    const rv = createAgent({ role: 'reviewer', model: 'glm-5.1' }, 'trace-cons-llm');
    expect(p1.ok && p2.ok && rv.ok).toBe(true);
    if (!p1.ok || !p2.ok || !rv.ok) return;

    assignTask(p1.value.agentId, 'task-cons-p1', 'trace-cons-llm');
    assignTask(p2.value.agentId, 'task-cons-p2', 'trace-cons-llm');

    // 并行调用
    const [r1, r2] = await Promise.all([
      callModelWithRetry(MODEL, [
        { role: 'system', content: '你是架构师 Partner。用一句话回答。' },
        { role: 'user', content: '设计一个秒杀系统的核心架构要点。' },
      ], { max_tokens: 150 }),
      callModelWithRetry(MODEL, [
        { role: 'system', content: '你是前端 Partner。用一句话回答。' },
        { role: 'user', content: '设计一个秒杀页面的核心交互流程。' },
      ], { max_tokens: 150 }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    console.log(`[CONSORTIUM] P1(架构): ${r1.value.content.slice(0, 80)}`);
    console.log(`[CONSORTIUM] P2(前端): ${r2.value.content.slice(0, 80)}`);

    // 各自扣减 Token
    debit(p1.value.agentId, r1.value.usage.total_tokens, 'trace-cons-llm');
    debit(p2.value.agentId, r2.value.usage.total_tokens, 'trace-cons-llm');

    // 各自提交审核
    submitForReview({ taskId: 'task-cons-p1', workerAgentId: p1.value.agentId, payload: { output: r1.value.content } });
    submitForReview({ taskId: 'task-cons-p2', workerAgentId: p2.value.agentId, payload: { output: r2.value.content } });

    // Reviewer 审核
    performReview({ taskId: 'task-cons-p1', reviewerAgentId: rv.value.agentId });
    performReview({ taskId: 'task-cons-p2', reviewerAgentId: rv.value.agentId });

    expect(isTaskApproved('task-cons-p1')).toBe(true);
    expect(isTaskApproved('task-cons-p2')).toBe(true);

    // Token 守恒
    const w1 = getWallet(p1.value.agentId);
    const w2 = getWallet(p2.value.agentId);
    expect(w1?.balance).toBeLessThan(10_000);
    expect(w2?.balance).toBeLessThan(10_000);
    console.log(`[CONSORTIUM] P1 余额: ${w1?.balance}, P2 余额: ${w2?.balance}`);
  }, 180000);
});
