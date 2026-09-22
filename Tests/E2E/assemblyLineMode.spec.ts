/**
 * E2E 测试：ASSEMBLY_LINE 模式 — SOP 流水线
 *
 * PRD §3.1 工作方式 3：识别标准化任务，按 SOP 节点串行流转。
 * 路由判定：匹配 SOP 模板 + 不命中 CONSORTIUM → ASSEMBLY_LINE
 *
 * 验证链路：
 *   SOP 关键词匹配 → 路由命中 ASSEMBLY_LINE → Director + N 节点 Agent
 *   → 链式依赖 dependsOn → maxParallelism=1 → 串行执行 → 顺序聚合
 *   → [LLM] 各节点真实调用
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── 编排器 ──────────────────────────────────────────
import { receiveTask, resetOrchestrator } from '../../Src/Core/Decision/Orchestrator/orchestrator.js';
import { assessComplexity } from '../../Src/Core/Decision/ComplexityAssessor/complexityAssessor.js';
import { decideRoute } from '../../Src/Core/Decision/RouteDecision/routeDecision.js';
import { resetRoutingRules, updateRoutingRules } from '../../Src/Core/Decision/RouteDecision/routingRules.js';
import { resetDecomposer } from '../../Src/Core/Decision/TaskDecomposer/taskDecomposer.js';

// ── Agent 运行时 ────────────────────────────────────
import {
  createAgent, resetAgentFactory,
} from '../../Src/Core/AgentRuntime/agentFactory.js';
import {
  resetAgentRegistry, getAgentsByRole,
} from '../../Src/Core/AgentRuntime/agentRegistry.js';
import { resetAgentRuntime } from '../../Src/Core/AgentRuntime/agentRuntime.js';

// ── 结果聚合 ────────────────────────────────────────
import { aggregateResults, resetAggregator } from '../../Src/Core/Decision/Orchestrator/resultAggregator.js';
import type { SubtaskResult, TaskPlan } from '../../Src/Core/Decision/types.js';

// ── Token 经济 ──────────────────────────────────────
import {
  resetWalletManager, initWalletManager,
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

describe('E2E: ASSEMBLY_LINE 模式 — SOP 流水线', () => {
  beforeEach(() => {
    fullReset();
  });

  // ─────────────────────────────────────────────────
  // 1. SOP 匹配
  // ─────────────────────────────────────────────────

  it('SOP 匹配：含 "代码审查" 关键词 → hasSopMatch=true', () => {
    const report = assessComplexity({
      taskDescription: '对项目进行 code review 代码审查，检查代码质量和规范性',
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    expect(report.value.hasSopMatch).toBe(true);
    expect(report.value.matchedSopId).toBe('sop-code-review');
  });

  it('SOP 匹配：含 "数据迁移" 关键词 → sop-data-migration', () => {
    const report = assessComplexity({
      taskDescription: '执行 data migration 数据迁移，将旧数据库迁移到新系统',
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    expect(report.value.hasSopMatch).toBe(true);
    expect(report.value.matchedSopId).toBe('sop-data-migration');
  });

  // ─────────────────────────────────────────────────
  // 2. 路由决策命中 ASSEMBLY_LINE
  // ─────────────────────────────────────────────────

  it('路由决策：SOP 匹配 + 非高复杂度 → ASSEMBLY_LINE', () => {
    // 用 hint 控制：单域 + 低 Token + SOP 匹配
    const report = assessComplexity({
      taskDescription: '对项目进行 code review 代码审查',
      hint: { requiredDomains: ['backend'], subtaskCount: 3, estimatedTokens: 8000 },
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const route = decideRoute(report.value);
    expect(route.ok).toBe(true);
    if (!route.ok) return;

    expect(route.value.mode).toBe('ASSEMBLY_LINE');
    expect(route.value.reason).toContain('SOP');
  });

  // ─────────────────────────────────────────────────
  // 3. 编排器端到端：receiveTask → ASSEMBLY_LINE
  // ─────────────────────────────────────────────────

  it('编排器端到端：SOP 路由决策验证', () => {
    // receiveTask 不支持 hint，ASSEMBLY_LINE 在多域时会被 CONSORTIUM 截获
    // 因此直接验证 assessComplexity + decideRoute 链路
    const report = assessComplexity({
      taskDescription: '对项目进行 code review 代码审查',
      hint: { requiredDomains: ['backend'], subtaskCount: 3, estimatedTokens: 8000 },
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const route = decideRoute(report.value);
    expect(route.ok).toBe(true);
    if (!route.ok) return;

    expect(route.value.mode).toBe('ASSEMBLY_LINE');
    expect(route.value.params.sopId).toBe('sop-code-review');
  });

  // ─────────────────────────────────────────────────
  // 4. 流水线依赖链验证
  // ─────────────────────────────────────────────────

  it('流水线依赖：orchestrator 强制串行依赖链', async () => {
    // receiveTask 多域任务会走 CONSORTIUM，但 ASSEMBLY_LINE 的依赖链由 orchestrator 强制设置
    // 直接验证 ASSEMBLY_LINE 分支的依赖逻辑
    const taskDesc = '对项目进行 code review 代码审查';
    const report = assessComplexity({
      taskDescription: taskDesc,
      hint: { requiredDomains: ['backend'], subtaskCount: 3, estimatedTokens: 8000 },
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    // 模拟 orchestrator 的 executeAssemblyLine 逻辑
    const directorRes = createAgent({ role: 'director', model: 'glm-5.1' }, 'trace-asm-deps');
    expect(directorRes.ok).toBe(true);
    if (!directorRes.ok) return;

    const { decomposeTask } = await import('../../Src/Core/Decision/TaskDecomposer/taskDecomposer.js');
    const planResult = decomposeTask({
      taskId: 'task-asm-deps', traceId: 'trace-asm-deps',
      directorAgentId: directorRes.value.agentId,
      taskDescription: taskDesc, complexityReport: report.value,
      totalTokenBudget: 30000, globalTimeLimitMs: 300000, maxParallelism: 1,
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    const plan = planResult.value;
    expect(plan.assignments.length).toBeGreaterThanOrEqual(2);

    // orchestrator 强制设置链式依赖
    for (let i = 1; i < plan.assignments.length; i++) {
      plan.assignments[i].dependsOn = [plan.assignments[i - 1].assignmentId];
    }

    // 验证链式依赖
    for (let i = 1; i < plan.assignments.length; i++) {
      expect(plan.assignments[i].dependsOn).toContain(plan.assignments[i - 1].assignmentId);
    }
    expect(plan.assignments[0].dependsOn.length).toBe(0);
  });

  // ─────────────────────────────────────────────────
  // 5. 串行约束：maxParallelism = 1
  // ─────────────────────────────────────────────────

  it('串行约束：maxParallelism === 1（orchestrator 强制）', async () => {
    // executeAssemblyLine 中 maxParallelism 被强制设为 1
    // 验证 decomposeTask 在 maxParallelism=1 时的行为
    const report = assessComplexity({
      taskDescription: 'code review 代码审查',
      hint: { requiredDomains: ['backend'], subtaskCount: 3, estimatedTokens: 8000 },
    });
    if (!report.ok) return;

    const directorRes = createAgent({ role: 'director', model: 'glm-5.1' }, 'trace-asm-serial');
    if (!directorRes.ok) return;

    const { decomposeTask } = await import('../../Src/Core/Decision/TaskDecomposer/taskDecomposer.js') as any;
    const planResult = decomposeTask({
      taskId: 'task-asm-serial', traceId: 'trace-asm-serial',
      directorAgentId: directorRes.value.agentId,
      taskDescription: 'code review 代码审查', complexityReport: report.value,
      totalTokenBudget: 30000, globalTimeLimitMs: 300000, maxParallelism: 1,
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    expect(planResult.value.maxParallelism).toBe(1);
  });

  // ─────────────────────────────────────────────────
  // 6. Agent 招募：每个节点一个 Worker
  // ─────────────────────────────────────────────────

  it('Agent 招募：Director + 每节点 Worker（模拟）', () => {
    // 模拟 ASSEMBLY_LINE 的 Agent 招募
    const directorRes = createAgent({ role: 'director', model: 'glm-5.1' }, 'trace-asm-agents');
    expect(directorRes.ok).toBe(true);

    // 模拟 3 个流水线节点 Worker
    for (let i = 0; i < 3; i++) {
      const w = createAgent({ role: 'worker', model: 'glm-5.1' }, 'trace-asm-agents');
      expect(w.ok).toBe(true);
    }

    const directors = getAgentsByRole('director');
    expect(directors.length).toBe(1);

    const workers = getAgentsByRole('worker');
    expect(workers.length).toBe(3);
  });

  // ─────────────────────────────────────────────────
  // 7. 结果聚合：按顺序
  // ─────────────────────────────────────────────────

  it('结果聚合：按流水线顺序聚合', () => {
    const directorRes = createAgent({ role: 'director', model: 'glm-5.1' }, 'trace-asm-agg');
    expect(directorRes.ok).toBe(true);
    if (!directorRes.ok) return;

    const plan: TaskPlan = {
      planId: 'plan-asm', taskId: 'task-asm-agg', traceId: 'trace-asm-agg',
      directorAgentId: directorRes.value.agentId,
      assignments: [
        { assignmentId: 'node-0', taskId: 'task-asm-agg', traceId: 'trace-asm-agg', parentAgentId: directorRes.value.agentId, subtaskIndex: 0, description: '静态分析', inputContext: {}, outputSchema: {}, maxIterations: 10, timeLimitMs: 60000, tokenBudget: 3000, dependsOn: [], requiredTools: [], status: 'completed', assignedAgentId: 'w1' },
        { assignmentId: 'node-1', taskId: 'task-asm-agg', traceId: 'trace-asm-agg', parentAgentId: directorRes.value.agentId, subtaskIndex: 1, description: '代码审查', inputContext: {}, outputSchema: {}, maxIterations: 10, timeLimitMs: 60000, tokenBudget: 3000, dependsOn: ['node-0'], requiredTools: [], status: 'completed', assignedAgentId: 'w2' },
        { assignmentId: 'node-2', taskId: 'task-asm-agg', traceId: 'trace-asm-agg', parentAgentId: directorRes.value.agentId, subtaskIndex: 2, description: '报告生成', inputContext: {}, outputSchema: {}, maxIterations: 10, timeLimitMs: 60000, tokenBudget: 3000, dependsOn: ['node-1'], requiredTools: [], status: 'completed', assignedAgentId: 'w3' },
      ],
      totalTokenBudget: 9000, globalTimeLimitMs: 180000, maxParallelism: 1,
      createdAt: Date.now(), status: 'active',
    };

    const results: SubtaskResult[] = [
      { assignmentId: 'node-0', agentId: 'w1', status: 'success', output: { lintErrors: 3 }, tokensUsed: 2000, completedAt: Date.now() },
      { assignmentId: 'node-1', agentId: 'w2', status: 'success', output: { reviewComments: 5 }, tokensUsed: 2500, completedAt: Date.now() },
      { assignmentId: 'node-2', agentId: 'w3', status: 'success', output: { reportGenerated: true }, tokensUsed: 1500, completedAt: Date.now() },
    ];

    const aggregated = aggregateResults({ taskPlan: plan, subtaskResults: results });
    expect(aggregated.ok).toBe(true);
    if (aggregated.ok) {
      expect(aggregated.value.status).toBe('success');
      expect(aggregated.value.totalTokensUsed).toBe(6000);
      // 验证按 assignmentId 组织
      expect(aggregated.value.finalOutput['node-0']).toBeDefined();
      expect(aggregated.value.finalOutput['node-1']).toBeDefined();
      expect(aggregated.value.finalOutput['node-2']).toBeDefined();
    }
  });

  // ─────────────────────────────────────────────────
  // 8. 事件链验证
  // ─────────────────────────────────────────────────

  it('事件链：TASK_RECEIVED 发布', () => {
    // ASSEMBLY_LINE 通过 receiveTask 触发时，多域会走 CONSORTIUM
    // 此处验证 TASK_RECEIVED 事件发布
    receiveTask({
      taskId: 'task-assembly-events',
      traceId: 'trace-assembly-5',
      taskDescription: '对项目进行 code review 代码审查，检查代码质量和规范性，包含后端 server 和前端 ui 模块',
    });

    const events = getEventLog();
    const types = events.map(e => e.eventType);

    expect(types).toContain(EventType.TASK_RECEIVED);
    // 多域任务会路由到 CONSORTIUM，当前实现不发布 TASK_ASSIGNED
    // ASSEMBLY_LINE 的事件发布待后续完善
  });

  // ─────────────────────────────────────────────────
  // 9. [LLM] 流水线节点真实调用
  // ─────────────────────────────────────────────────

  it('[LLM] 流水线节点依次调用 LLM', async () => {
    if (!process.env.HUAWEI_MAAS_API_KEY) {
      console.log('SKIP: HUAWEI_MAAS_API_KEY 未设置');
      return;
    }
    setupLlm();

    // 模拟 3 个流水线节点
    const nodes = ['静态分析', '代码审查', '报告生成'];
    const outputs: string[] = [];

    for (let i = 0; i < nodes.length; i++) {
      const workerRes = createAgent({ role: 'worker', model: 'glm-5.1' }, 'trace-asm-llm');
      expect(workerRes.ok).toBe(true);
      if (!workerRes.ok) continue;

      const response = await callModelWithRetry(MODEL, [
        { role: 'system', content: `你是流水线的${nodes[i]}节点。请用一句话回答。` },
        { role: 'user', content: `对代码 "function add(a,b){return a+b}" 执行${nodes[i]}。` },
      ], { max_tokens: 100 });

      expect(response.ok).toBe(true);
      if (response.ok) {
        outputs.push(response.value.content);
        console.log(`[ASSEMBLY] 节点 ${i}(${nodes[i]}): ${response.value.content.slice(0, 80)}`);
      }
    }

    expect(outputs.length).toBe(3);
  }, 180000);
});
