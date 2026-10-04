/**
 * FE-056 / FE-057 回归测试：评审四级验证管线（替代原「默认接受」桩）
 *
 * 覆盖：
 *  - L1 schema（提交结构：summary 必填）与 L2 rule（成果非空）的确定性拒绝；
 *  - L3 独立 LLM Judge（ADR-0004：异模型）的通过 / 拒绝 / 调用异常 fail-closed；
 *  - minLevelsRequired 层数不足（ADR-0003）的 fail-closed；
 *  - judgeModel 显式禁用语义（空串 / 与产出者相同 → 降级 L1+L2）。
 *
 * 说明：本测试不注册 Provider——L3 通过 `callModelFn` 注入（评审管线本身的
 * 模型选择与调用链在单元层验证；真实模型调用的端到端验证见 .verify 脚本）。
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createAgent, resetAgentFactory,
} from '../../Src/Core/AgentRuntime/agentFactory.js';
import { resetAgentRegistry } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import {
  assignTask, submitForReview, isTaskApproved, resetAgentRuntime,
} from '../../Src/Core/AgentRuntime/agentRuntime.js';
import {
  performReview, resetReviewer, configureReviewer,
} from '../../Src/Services/ReviewerAgent/reviewerAgent.js';
import { resetEventBus } from '../../Src/Services/EventBus/eventBus.js';
import { resetWalletManager, initWalletManager } from '../../Src/Services/TokenEconomy/walletManager.js';
import { resetRouter } from '../../Src/Infra/Llm/Router/modelRouter.js';

// ── 测试脚手架 ──────────────────────────────────────────────────────

function makeWorkerTask(workerModel = 'worker-model'): {
  workerId: string;
  reviewerId: string;
  taskId: string;
} {
  const worker = createAgent({ role: 'worker', model: workerModel }, 'trace-review');
  const reviewer = createAgent({ role: 'reviewer', model: 'reviewer-model' }, 'trace-review');
  if (!worker.ok || !reviewer.ok) throw new Error('创建 Agent 失败');
  assignTask(worker.value.agentId, 'task-review-1', 'trace-review');
  return { workerId: worker.value.agentId, reviewerId: reviewer.value.agentId, taskId: 'task-review-1' };
}

const PASS_JSON = JSON.stringify({
  score: 0.9,
  pass: true,
  evidence: [{ note: '成果与需求一致' }],
  defectCategory: null,
});

const FAIL_JSON = JSON.stringify({
  score: 0.2,
  pass: false,
  evidence: [{ note: '摘要空泛，缺少可验证细节' }],
  defectCategory: 'quality_low',
});

beforeEach(() => {
  resetRouter();
  resetEventBus();
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  resetAgentRegistry();
  resetAgentFactory();
  resetAgentRuntime();
  resetReviewer();
});

// ── 用例 ────────────────────────────────────────────────────────────

describe('FE-056/057 · 评审验证管线', () => {
  it('L1+L2 通过：合规提交（无 L3 环境）→ accepted，comment 标注层级', async () => {
    const { workerId, reviewerId, taskId } = makeWorkerTask();
    submitForReview({
      taskId,
      workerAgentId: workerId,
      payload: { summary: '后端模块开发完成，包含 3 个 REST 端点与单元测试', artifacts: ['src/server.ts'] },
    });

    // 无 Provider 注册 + 无 routing → 自动候选为空 → 无 L3 spec
    const result = await performReview({ taskId, reviewerAgentId: reviewerId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('accepted');
    expect(result.value.reviewerComment).toContain('L1+L2');
    expect(result.value.reviewerComment).toContain('评审通过');
    expect(isTaskApproved(taskId)).toBe(true);
  });

  it('空成果 → L2 确定性拒绝（rejected + comment 含 [L2 rule]）', async () => {
    const { workerId, reviewerId, taskId } = makeWorkerTask();
    submitForReview({
      taskId,
      workerAgentId: workerId,
      payload: { summary: '', artifacts: [] },
    });

    const result = await performReview({ taskId, reviewerAgentId: reviewerId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('rejected');
    expect(result.value.reviewerComment).toContain('[L2 rule]');
    expect(isTaskApproved(taskId)).toBe(false);
  });

  it('缺失 summary 字段 → L1 schema 拒绝（fail-closed 于最底两层）', async () => {
    const { workerId, reviewerId, taskId } = makeWorkerTask();
    submitForReview({
      taskId,
      workerAgentId: workerId,
      payload: { output: '只有 output 字段，没有按契约提供 summary' },
    });

    const result = await performReview({ taskId, reviewerAgentId: reviewerId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // summary 为空 + artifacts 空 → 先被判 L2 非空规则拒绝（L1 仅查结构键存在性）
    expect(result.value.status).toBe('rejected');
    expect(result.value.reviewerComment).toContain('评审未通过');
  });

  it('L3 Judge 通过（注入 mock）→ accepted，且 Judge 收到成果文本', async () => {
    const { workerId, reviewerId, taskId } = makeWorkerTask();
    const judgeCalls: Array<{ model: string; prompt: string }> = [];
    configureReviewer({
      judgeModel: 'judge-model-x',
      callModelFn: async (model, prompt) => {
        judgeCalls.push({ model, prompt });
        return PASS_JSON;
      },
    });

    submitForReview({
      taskId,
      workerAgentId: workerId,
      payload: { summary: '实现用户登录接口与 JWT 校验，附测试', artifacts: ['src/auth.ts'] },
    });

    const result = await performReview({ taskId, reviewerAgentId: reviewerId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('accepted');
    expect(result.value.reviewerComment).toContain('L1+L2+L3');

    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0]!.model).toBe('judge-model-x');
    expect(judgeCalls[0]!.prompt).toContain('实现用户登录接口与 JWT 校验');
  });

  it('L3 Judge 判定不通过 → rejected + comment 含 [L3 llm_judge]', async () => {
    const { workerId, reviewerId, taskId } = makeWorkerTask();
    configureReviewer({
      judgeModel: 'judge-model-x',
      callModelFn: async () => FAIL_JSON,
    });

    submitForReview({
      taskId,
      workerAgentId: workerId,
      payload: { summary: '做了点东西' },
    });

    const result = await performReview({ taskId, reviewerAgentId: reviewerId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('rejected');
    expect(result.value.reviewerComment).toContain('[L3 llm_judge]');
    expect(isTaskApproved(taskId)).toBe(false);
  });

  it('L3 Judge 调用异常 → fail-closed 拒绝（不静默放行）', async () => {
    const { workerId, reviewerId, taskId } = makeWorkerTask();
    configureReviewer({
      judgeModel: 'judge-model-x',
      callModelFn: async () => {
        throw new Error('judge 网络超时');
      },
    });

    submitForReview({
      taskId,
      workerAgentId: workerId,
      payload: { summary: '完成了一个模块的搭建与联调' },
    });

    const result = await performReview({ taskId, reviewerAgentId: reviewerId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('rejected');
    expect(result.value.reviewerComment).toContain('judge 网络超时');
  });

  it('ADR-0004：judgeModel 与产出者相同 → 显式降级（Judge 不被调用）', async () => {
    const { workerId, reviewerId, taskId } = makeWorkerTask('worker-model');
    const judgeCalls: string[] = [];
    configureReviewer({
      judgeModel: 'worker-model', // = 产出者模型 → 显式禁用 L3
      callModelFn: async (model) => {
        judgeCalls.push(model);
        return PASS_JSON;
      },
    });

    submitForReview({
      taskId,
      workerAgentId: workerId,
      payload: { summary: '完成了目标模块并产出可验证文件' },
    });

    const result = await performReview({ taskId, reviewerAgentId: reviewerId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('accepted');
    expect(judgeCalls).toHaveLength(0);
  });

  it('ADR-0003：minLevelsRequired=3 且无 L3 → 层数不足 fail-closed', async () => {
    const { workerId, reviewerId, taskId } = makeWorkerTask();
    configureReviewer({ judgeModel: '', minLevelsRequired: 3 });

    submitForReview({
      taskId,
      workerAgentId: workerId,
      payload: { summary: '完成了目标模块并产出可验证文件' },
    });

    const result = await performReview({ taskId, reviewerAgentId: reviewerId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('rejected');
    expect(result.value.reviewerComment).toContain('验证管线异常');
    expect(result.value.reviewerComment).toContain('层数不足');
  });

  it('自定义 criteria 替代默认 rubric（进入 Judge prompt）', async () => {
    const { workerId, reviewerId, taskId } = makeWorkerTask();
    let seenPrompt = '';
    configureReviewer({
      judgeModel: 'judge-model-x',
      callModelFn: async (_model, prompt) => {
        seenPrompt = prompt;
        return PASS_JSON;
      },
    });

    submitForReview({
      taskId,
      workerAgentId: workerId,
      payload: { summary: '完成接口联调' },
    });

    await performReview({
      taskId,
      reviewerAgentId: reviewerId,
      criteria: ['必须包含接口字段清单'],
    });

    expect(seenPrompt).toContain('必须包含接口字段清单');
  });

  it('L3 Judge 输出带 markdown 围栏仍可解析（真实模型容错）', async () => {
    const { workerId, reviewerId, taskId } = makeWorkerTask();
    configureReviewer({
      judgeModel: 'judge-model-x',
      callModelFn: async () => '```json\n' + PASS_JSON + '\n```',
    });

    submitForReview({
      taskId,
      workerAgentId: workerId,
      payload: { summary: '完成接口联调与回归测试' },
    });

    const result = await performReview({ taskId, reviewerAgentId: reviewerId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('accepted');
  });
});
