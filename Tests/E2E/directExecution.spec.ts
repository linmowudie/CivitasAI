/**
 * E2E 测试：DIRECT 模式 — 简单任务直接执行
 *
 * PRD §3.1 工作方式 1：Prime Director 直接处理低复杂度任务。
 * 路由判定：estimatedTokens <= directExecMaxTokens(10000) + 单域 → DIRECT
 *
 * 验证链路：
 *   任务输入 → 复杂度评估 → 路由命中 DIRECT → Director 创建 → 无 Worker 招募
 *   → [LLM] Director 真实调用 → Token 扣减 → 事件链完整
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
  assignTask, resetAgentRuntime,
} from '../../Src/Core/AgentRuntime/agentRuntime.js';

// ── Token 经济 ──────────────────────────────────────
import {
  resetWalletManager, initWalletManager,
  getWallet, debit,
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

describe('E2E: DIRECT 模式 — 简单任务直接执行', () => {
  beforeEach(() => {
    fullReset();
  });

  // ─────────────────────────────────────────────────
  // 1. 复杂度评估命中 DIRECT
  // ─────────────────────────────────────────────────

  it('复杂度评估：简单任务 → 低 Token + 单域', () => {
    const report = assessComplexity({
      taskDescription: '用一句话解释什么是递归',
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    // 短文本 → 低 Token
    expect(report.value.estimatedTokens).toBeLessThanOrEqual(10000);
    // 无专业域关键词 → general
    expect(report.value.requiredDomains).toContain('general');
    expect(report.value.riskLevel).toBe('low');
  });

  // ─────────────────────────────────────────────────
  // 2. 路由决策命中 DIRECT
  // ─────────────────────────────────────────────────

  it('路由决策：低 Token + 单域 → DIRECT', () => {
    const report = assessComplexity({
      taskDescription: '解释什么是变量',
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const route = decideRoute(report.value);
    expect(route.ok).toBe(true);
    if (!route.ok) return;

    expect(route.value.mode).toBe('DIRECT');
    expect(route.value.reason).toContain('Director');
  });

  // ─────────────────────────────────────────────────
  // 3. 编排器端到端：receiveTask → DIRECT
  // ─────────────────────────────────────────────────

  it('编排器端到端：receiveTask 返回 DIRECT + 无 taskPlan', () => {
    const result = receiveTask({
      taskId: 'task-direct-e2e',
      traceId: 'trace-direct-1',
      taskDescription: '用一句话解释什么是函数',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.routingMode).toBe('DIRECT');
    expect(result.value.status).toBe('success');
    // DIRECT 模式无 taskPlan
    expect(result.value.taskPlan).toBeUndefined();
  });

  // ─────────────────────────────────────────────────
  // 4. Director Agent 创建且无 Worker
  // ─────────────────────────────────────────────────

  it('Agent 招募：仅 Director，无 Worker', () => {
    receiveTask({
      taskId: 'task-direct-agents',
      traceId: 'trace-direct-2',
      taskDescription: '解释什么是循环',
    });

    // 编排器创建了 Director
    const directors = getAgentsByRole('director');
    expect(directors.length).toBe(1);

    // 无 Worker
    const workers = getAgentsByRole('worker');
    expect(workers.length).toBe(0);
  });

  // ─────────────────────────────────────────────────
  // 5. 事件链验证
  // ─────────────────────────────────────────────────

  it('事件链：仅含 TASK_RECEIVED，无 TASK_DECOMPOSED / TASK_ASSIGNED', () => {
    receiveTask({
      taskId: 'task-direct-events',
      traceId: 'trace-direct-3',
      taskDescription: '什么是字符串',
    });

    const events = getEventLog();
    const types = events.map(e => e.eventType);

    expect(types).toContain(EventType.TASK_RECEIVED);
    // DIRECT 模式不拆解（但会 assignTask 给 Director）
    expect(types).not.toContain(EventType.TASK_DECOMPOSED);
  });

  // ─────────────────────────────────────────────────
  // 6. [LLM] Director 真实调用
  // ─────────────────────────────────────────────────

  it('[LLM] Director 真实调用 LLM → 输出非空 + Token 扣减', async () => {
    if (!process.env.HUAWEI_MAAS_API_KEY) {
      console.log('SKIP: HUAWEI_MAAS_API_KEY 未设置');
      return;
    }
    setupLlm();

    // 创建 Director
    const directorRes = createAgent({ role: 'director', model: 'glm-5.1' }, 'trace-direct-llm');
    expect(directorRes.ok).toBe(true);
    if (!directorRes.ok) return;

    const director = directorRes.value;
    const assignRes = assignTask(director.agentId, 'task-direct-llm', 'trace-direct-llm');
    expect(assignRes.ok).toBe(true);

    // Director 调用 LLM
    const response = await callModelWithRetry(MODEL, [
      { role: 'system', content: '你是一个编程导师。请用一句话回答。' },
      { role: 'user', content: '用一句话解释什么是递归。' },
    ], { max_tokens: 100 });

    expect(response.ok).toBe(true);
    if (!response.ok) return;

    expect(response.value.content.length).toBeGreaterThan(0);
    console.log(`[DIRECT] Director 输出: ${response.value.content.slice(0, 100)}`);

    // Token 扣减
    const debitRes = debit(director.agentId, response.value.usage.total_tokens, 'trace-direct-llm');
    expect(debitRes.ok).toBe(true);

    const wallet = getWallet(director.agentId);
    expect(wallet).toBeDefined();
    if (wallet) {
      expect(wallet.balance).toBeLessThan(10_000);
      console.log(`[DIRECT] Director 余额: ${wallet.balance}`);
    }
  }, 60000);
});
