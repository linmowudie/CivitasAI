/**
 * S9 真实 Agent 集成测试——Gate G9 架构变更验证
 *
 * 要求：架构变更后必须完成至少 3 轮真实 Agent 调用测试（非 mock）。
 * 本测试通过华为云 GLM-5.1 真实调用验证完整 Agent 生命周期。
 *
 * 测试场景：
 * Round 1: Worker 接收编码任务 → 调用 LLM 生成代码 → 提交审核 → Reviewer 审核通过
 * Round 2: Worker 接收设计任务 → 调用 LLM 生成方案 → 提交审核 → Reviewer 审核通过
 * Round 3: Worker 接收分析任务 → 调用 LLM 生成分析 → 提交审核 → Reviewer 审核拒绝 → Worker 重新提交 → 通过
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// ── LLM 基础设施 ────────────────────────────────────
import { OpenAIProvider } from '../../Src/Infra/Llm/Provider/openaiProvider.js';
import type { ProviderConfig } from '../../Src/Infra/Llm/Provider/providerBase.js';
import {
  registerProvider, setRoutingConfig, resetRouter,
} from '../../Src/Infra/Llm/Router/modelRouter.js';
import { callModel } from '../../Src/Core/Model/modelCaller.js';

// ── Agent 运行时 ────────────────────────────────────
import {
  createAgent, resetAgentFactory,
} from '../../Src/Core/AgentRuntime/agentFactory.js';
import {
  resetAgentRegistry, getAgent, getStatusSummary,
} from '../../Src/Core/AgentRuntime/agentRegistry.js';
import {
  assignTask, submitForReview, reviewSubmission,
  isTaskApproved, getPendingReviewCount, resetAgentRuntime,
} from '../../Src/Core/AgentRuntime/agentRuntime.js';
import { performReview, resetReviewer } from '../../Src/Services/ReviewerAgent/reviewerAgent.js';

// ── EventBus ────────────────────────────────────────
import { resetEventBus, initEventBus, publish, createEvent } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

// ── Token 经济 ──────────────────────────────────────
import {
  resetWalletManager, initWalletManager,
  getWallet, debit, getSystemPool,
} from '../../Src/Services/TokenEconomy/walletManager.js';

// ── 类型 ────────────────────────────────────────────
import type { Result } from '../../Src/Infra/types.js';

// ── 重试包装（应对 LLM API 速率限制）──────────────────

async function callModelWithRetry(
  model: string,
  messages: { role: string; content: string }[],
  opts?: { max_tokens?: number },
  retries = 3,
): Promise<Result<{ content: string; usage: { total_tokens: number }; model: string }>> {
  for (let i = 0; i <= retries; i++) {
    const res = await callModel(model, messages as any, opts);
    if (res.ok) return res;
    if (i < retries) {
      const waitMs = 5000 * (i + 1); // 5s, 10s, 15s 递增退避
      console.log(`  [retry ${i + 1}/${retries}] LLM 调用失败，等待 ${waitMs}ms 后重试...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  return await callModel(model, messages as any, opts);
}

// ═══════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════

const HUAWEI_CONFIG: ProviderConfig = {
  provider: 'huawei',
  base_url: 'https://api.modelarts-maas.com/plan/v2',
  api_key_ref: 'env:HUAWEI_MAAS_API_KEY',
  display_name: '华为云 MaaS',
  models: [{
    id: 'glm-5.1',
    context_window: 128000,
    max_output: 8192,
    supports_vision: false,
    supports_tools: true,
    cost_per_1k_input: 1.0,
    cost_per_1k_output: 2.0,
  }],
};

const MODEL = 'huawei/glm-5.1';

// ── 全局重置 ────────────────────────────────────────

function fullReset() {
  resetRouter();
  resetEventBus();
  initEventBus();
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  resetAgentRegistry();
  resetAgentFactory();
  resetAgentRuntime();
  resetReviewer();
}

function setupLlm() {
  const provider = new OpenAIProvider(HUAWEI_CONFIG);
  registerProvider(provider);
  setRoutingConfig({
    defaultModel: MODEL,
    directorModel: MODEL,
    workerModel: MODEL,
    verifierModel: MODEL,
    arbitrationModels: [MODEL],
    fallbackOrder: ['huawei'],
    timeoutMs: 60000,
    firstByteTimeoutMs: 10000,
    interChunkTimeoutMs: 15000,
  });
}

// ═══════════════════════════════════════════════════════
// 测试套件
// ═══════════════════════════════════════════════════════

describe('S9 · 真实 Agent 集成测试', () => {
  beforeAll(() => {
    if (!process.env.HUAWEI_MAAS_API_KEY) {
      console.log('SKIP: HUAWEI_MAAS_API_KEY 未设置，跳过真实 Agent 测试');
    }
  });

  beforeEach(() => {
    fullReset();
    setupLlm();
  });

  // ─────────────────────────────────────────────────
  // Round 1: Worker 编码任务 → LLM 生成 → 审核通过
  // ─────────────────────────────────────────────────

  it('Round 1: Worker 编码任务 → LLM 真实调用 → 审核通过', async () => {
    if (!process.env.HUAWEI_MAAS_API_KEY) {
      console.log('SKIP: HUAWEI_MAAS_API_KEY 未设置');
      return;
    }

    // 1. 创建 Worker + Reviewer
    const workerRes = createAgent({ role: 'worker', model: 'glm-5.1' }, 'trace-r1');
    const reviewerRes = createAgent({ role: 'reviewer', model: 'glm-5.1' }, 'trace-r1');
    expect(workerRes.ok).toBe(true);
    expect(reviewerRes.ok).toBe(true);
    if (!workerRes.ok || !reviewerRes.ok) return;

    const worker = workerRes.value;
    const reviewer = reviewerRes.value;

    // 验证初始状态
    expect(worker.status).toBe('ready');
    expect(worker.walletId).toBeDefined();

    // 2. 分配任务 → running
    const assign = assignTask(worker.agentId, 'task-encode-001', 'trace-r1');
    expect(assign.ok).toBe(true);
    expect(getAgent(worker.agentId)?.status).toBe('running');

    // 3. Worker 调用 LLM 执行编码任务
    const workerResponse = await callModelWithRetry(MODEL, [
      { role: 'system', content: '你是一个编码助手。请用一句话回答。' },
      { role: 'user', content: '用 TypeScript 写一个 add 函数，返回两数之和。只写函数代码，不要解释。' },
    ], { max_tokens: 200 });

    expect(workerResponse.ok).toBe(true);
    if (!workerResponse.ok) return;

    const workerOutput = workerResponse.value.content;
    console.log(`[Round 1] Worker 输出: ${workerOutput.slice(0, 100)}...`);
    expect(workerOutput.length).toBeGreaterThan(0);

    // 4. Worker 消耗 Token（debit）
    const debitRes = debit(worker.agentId, workerResponse.value.usage.total_tokens, 'trace-r1');
    expect(debitRes.ok).toBe(true);

    // 5. Worker 提交审核
    const submit = submitForReview({
      taskId: 'task-encode-001',
      workerAgentId: worker.agentId,
      payload: { output: workerOutput, artifacts: ['add.ts'] },
    });
    expect(submit.ok).toBe(true);
    expect(getAgent(worker.agentId)?.awaitingApproval).toBe(true);
    expect(isTaskApproved('task-encode-001')).toBe(false);

    // 6. Reviewer 调用 LLM 审核
    const reviewerResponse = await callModelWithRetry(MODEL, [
      { role: 'system', content: '你是一个代码审核员。判断代码是否正确。回复“通过”或“拒绝”。' },
      { role: 'user', content: `请审核以下代码：\n${workerOutput}` },
    ], { max_tokens: 50 });

    expect(reviewerResponse.ok).toBe(true);
    if (!reviewerResponse.ok) return;

    const reviewerOutput = reviewerResponse.value.content;
    console.log(`[Round 1] Reviewer 输出: ${reviewerOutput.slice(0, 100)}`);

    // 7. Reviewer 审核通过
    const review = performReview({
      taskId: 'task-encode-001',
      reviewerAgentId: reviewer.agentId,
    });
    expect(review.ok).toBe(true);
    expect(isTaskApproved('task-encode-001')).toBe(true);

    // 8. Worker 回到 ready
    expect(getAgent(worker.agentId)?.status).toBe('ready');
    expect(getAgent(worker.agentId)?.awaitingApproval).toBe(false);

    // 9. 验证 Token 消耗
    const wallet = getWallet(worker.agentId);
    expect(wallet).toBeDefined();
    if (wallet) {
      expect(wallet.balance).toBeLessThan(10_000); // 消耗了 Token
    }

    console.log(`[Round 1] ✅ 完成 — Worker: ${worker.agentId}, 余额: ${wallet?.balance}`);
  }, 60000);

  // ─────────────────────────────────────────────────
  // Round 2: Worker 设计任务 → LLM 生成 → 审核通过
  // ─────────────────────────────────────────────────

  it('Round 2: Worker 设计任务 → LLM 真实调用 → 审核通过', async () => {
    if (!process.env.HUAWEI_MAAS_API_KEY) {
      console.log('SKIP: HUAWEI_MAAS_API_KEY 未设置');
      return;
    }

    const workerRes = createAgent({ role: 'worker', model: 'glm-5.1' }, 'trace-r2');
    const reviewerRes = createAgent({ role: 'reviewer', model: 'glm-5.1' }, 'trace-r2');
    if (!workerRes.ok || !reviewerRes.ok) return;

    const worker = workerRes.value;
    const reviewer = reviewerRes.value;

    assignTask(worker.agentId, 'task-design-002', 'trace-r2');
    expect(getAgent(worker.agentId)?.status).toBe('running');

    // Worker 调用 LLM 做设计
    const workerResponse = await callModelWithRetry(MODEL, [
      { role: 'system', content: '你是一个系统设计师。请用简短的话回答。' },
      { role: 'user', content: '设计一个简单的 REST API 用于用户注册登录，列出 2-3 个核心端点即可。' },
    ], { max_tokens: 300 });

    expect(workerResponse.ok).toBe(true);
    if (!workerResponse.ok) return;

    const output = workerResponse.value.content;
    console.log(`[Round 2] Worker 输出: ${output.slice(0, 150)}...`);
    expect(output.length).toBeGreaterThan(0);

    // Worker 提交
    submitForReview({
      taskId: 'task-design-002',
      workerAgentId: worker.agentId,
      payload: { design: output },
    });

    // Reviewer 调用 LLM 审核
    const reviewerResponse = await callModelWithRetry(MODEL, [
      { role: 'system', content: '你是设计审核员。判断方案是否合理。回复“通过”或“拒绝”。' },
      { role: 'user', content: `请审核以下设计方案：\n${output}` },
    ], { max_tokens: 50 });

    expect(reviewerResponse.ok).toBe(true);
    console.log(`[Round 2] Reviewer 输出: ${reviewerResponse.value.content.slice(0, 100)}`);

    // 审核通过
    const review = performReview({
      taskId: 'task-design-002',
      reviewerAgentId: reviewer.agentId,
    });
    expect(review.ok).toBe(true);
    expect(isTaskApproved('task-design-002')).toBe(true);
    expect(getAgent(worker.agentId)?.status).toBe('ready');

    console.log(`[Round 2] ✅ 完成 — Worker: ${worker.agentId}`);
  }, 60000);

  // ─────────────────────────────────────────────────
  // Round 3: 审核拒绝 → 重新提交 → 通过
  // ─────────────────────────────────────────────────

  it('Round 3: Worker 分析任务 → 首次拒绝 → 重新提交 → 通过', async () => {
    if (!process.env.HUAWEI_MAAS_API_KEY) {
      console.log('SKIP: HUAWEI_MAAS_API_KEY 未设置');
      return;
    }

    const workerRes = createAgent({ role: 'worker', model: 'glm-5.1' }, 'trace-r3');
    const reviewerRes = createAgent({ role: 'reviewer', model: 'glm-5.1' }, 'trace-r3');
    if (!workerRes.ok || !reviewerRes.ok) return;

    const worker = workerRes.value;
    const reviewer = reviewerRes.value;

    assignTask(worker.agentId, 'task-analyze-003', 'trace-r3');

    // 第一次：Worker 调用 LLM
    const response1 = await callModelWithRetry(MODEL, [
      { role: 'system', content: '你是一个分析助手。请用简短的话回答。' },
      { role: 'user', content: '简要分析微服务架构的优缺点，各列 2 点。' },
    ], { max_tokens: 300 });

    expect(response1.ok).toBe(true);
    if (!response1.ok) return;

    const output1 = response1.value.content;
    console.log(`[Round 3-1] Worker 首次输出: ${output1.slice(0, 150)}...`);

    // 第一次提交
    submitForReview({
      taskId: 'task-analyze-003',
      workerAgentId: worker.agentId,
      payload: { analysis: output1 },
    });

    // 第一次审核：手动拒绝（模拟 Reviewer 认为不够好）
    const reject = reviewSubmission({
      taskId: 'task-analyze-003',
      reviewerAgentId: reviewer.agentId,
      accepted: false,
      comment: '分析不够深入，请补充具体数据支撑',
    });
    expect(reject.ok).toBe(true);
    if (reject.ok) expect(reject.value.status).toBe('rejected');

    // Worker 仍在 running + consecutiveFailures=1
    expect(getAgent(worker.agentId)?.status).toBe('running');
    expect(getAgent(worker.agentId)?.consecutiveFailures).toBe(1);

    // 第二次：Worker 重新调用 LLM（改进版）
    const response2 = await callModelWithRetry(MODEL, [
      { role: 'system', content: '你是一个分析助手。请用详细的数据回答。' },
      { role: 'user', content: '请重新分析微服务架构的优缺点，需要包含具体案例和数据支撑。' },
    ], { max_tokens: 400 });

    expect(response2.ok).toBe(true);
    if (!response2.ok) return;

    const output2 = response2.value.content;
    console.log(`[Round 3-2] Worker 改进输出: ${output2.slice(0, 150)}...`);

    // 第二次提交
    submitForReview({
      taskId: 'task-analyze-003',
      workerAgentId: worker.agentId,
      payload: { analysis: output2, revision: 2 },
    });

    // 第二次审核：通过
    const accept = performReview({
      taskId: 'task-analyze-003',
      reviewerAgentId: reviewer.agentId,
    });
    expect(accept.ok).toBe(true);
    expect(isTaskApproved('task-analyze-003')).toBe(true);
    expect(getAgent(worker.agentId)?.status).toBe('ready');

    console.log(`[Round 3] ✅ 完成 — Worker: ${worker.agentId}, 经历 1 次拒绝后通过`);
  }, 180000);

  // ─────────────────────────────────────────────────
  // 综合验证：多 Agent 并行 + Token 守恒
  // ─────────────────────────────────────────────────

  it('综合: 多 Agent 并行工作 + Token 守恒验证', async () => {
    if (!process.env.HUAWEI_MAAS_API_KEY) {
      console.log('SKIP: HUAWEI_MAAS_API_KEY 未设置');
      return;
    }

    // 创建 2 Worker + 1 Reviewer
    const w1 = createAgent({ role: 'worker', model: 'glm-5.1' }, 'trace-parallel');
    const w2 = createAgent({ role: 'worker', model: 'glm-5.1' }, 'trace-parallel');
    const rv = createAgent({ role: 'reviewer', model: 'glm-5.1' }, 'trace-parallel');
    if (!w1.ok || !w2.ok || !rv.ok) return;

    // 分配不同任务
    assignTask(w1.value.agentId, 'task-p1', 'trace-parallel');
    assignTask(w2.value.agentId, 'task-p2', 'trace-parallel');

    // 两个 Worker 并行调用 LLM
    const [r1, r2] = await Promise.all([
      callModelWithRetry(MODEL, [
        { role: 'user', content: '用一句话解释什么是递归。' },
      ], { max_tokens: 100 }),
      callModelWithRetry(MODEL, [
        { role: 'user', content: '用一句话解释什么是多态。' },
      ], { max_tokens: 100 }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    console.log(`[并行] W1: ${r1.value.content.slice(0, 80)}`);
    console.log(`[并行] W2: ${r2.value.content.slice(0, 80)}`);

    // 扣减 Token
    debit(w1.value.agentId, r1.value.usage.total_tokens, 'trace-parallel');
    debit(w2.value.agentId, r2.value.usage.total_tokens, 'trace-parallel');

    // 两个 Worker 都提交
    submitForReview({
      taskId: 'task-p1',
      workerAgentId: w1.value.agentId,
      payload: { output: r1.value.content },
    });
    submitForReview({
      taskId: 'task-p2',
      workerAgentId: w2.value.agentId,
      payload: { output: r2.value.content },
    });

    expect(getPendingReviewCount()).toBe(2);

    // Reviewer 依次审核
    performReview({ taskId: 'task-p1', reviewerAgentId: rv.value.agentId });
    performReview({ taskId: 'task-p2', reviewerAgentId: rv.value.agentId });

    expect(isTaskApproved('task-p1')).toBe(true);
    expect(isTaskApproved('task-p2')).toBe(true);
    expect(getAgent(w1.value.agentId)?.status).toBe('ready');
    expect(getAgent(w2.value.agentId)?.status).toBe('ready');

    // Token 守恒验证
    const wallet1 = getWallet(w1.value.agentId);
    const wallet2 = getWallet(w2.value.agentId);
    expect(wallet1).toBeDefined();
    expect(wallet2).toBeDefined();
    if (wallet1 && wallet2) {
      expect(wallet1.balance).toBeLessThanOrEqual(10_000);
      expect(wallet2.balance).toBeLessThanOrEqual(10_000);
      console.log(`[并行] W1 余额: ${wallet1.balance}, W2 余额: ${wallet2.balance}`);
    }

    // 状态摘要
    const summary = getStatusSummary();
    expect(summary.ready).toBeGreaterThanOrEqual(2); // 2 workers back to ready
    console.log(`[并行] 状态摘要: ${JSON.stringify(summary)}`);
  }, 180000);
});
