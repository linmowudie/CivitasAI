/**
 * FE-071 / FE-072 回归测试：Skills 资产运行期消费 + Agent 执行入口
 *
 * 覆盖：
 *  - skillsAssets：真实装载（playbook/rubric/strategy/法典文档）+ 各 getter + 降级；
 *  - agentFactory：执行级角色注入任务 Playbook（worker/partner/assembly_node），reviewer 不注入；
 *  - performReview：L3 rubric 消费校准资产（rubricDimensions → Judge prompt）；
 *  - strategyLedger：候选注入 + 缺省消费 + 失败策略排除；
 *  - agent.recruit：dispatch 如实降级为 'manual'（指向执行入口）；
 *  - agentExecutor：错误路径 + mock 模型下的真实执行链路（executeLoop 收口）。
 *
 * 说明：executor 成功路径经 vi.mock 拦截模型调用（不发起真实请求）；无数据库依赖（fail-safe）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── mock 模型调用（executor → executeLoop 的 ⑥ 步出口）──
const h = vi.hoisted(() => ({ callModel: vi.fn(), callModelStream: vi.fn() }));
vi.mock('../../Src/Core/Model/modelCaller.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../Src/Core/Model/modelCaller.js')>();
  return { ...actual, callModel: h.callModel, callModelStream: h.callModelStream };
});

import {
  loadSkillsAssets, getL3Rubric, getPlaybook, getBehaviorCodeMarkdown,
  getStrategyCandidates, resetSkillsAssets,
} from '../../Src/Services/Prompts/skillsAssets.js';
import { createAgent, resetAgentFactory } from '../../Src/Core/AgentRuntime/agentFactory.js';
import { resetAgentRegistry, updateAgent, getAgent } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import { resetWalletManager, initWalletManager } from '../../Src/Services/TokenEconomy/walletManager.js';
import { executeAssignedTask } from '../../Src/Core/AgentRuntime/agentExecutor.js';
import {
  configureStrategyCandidates, getStrategyCandidatesInjected,
  selectNextStrategy, recordStrategy, clearLedger,
} from '../../Src/Services/LoopControl/strategyLedger.js';
import { agentRecruiter } from '../../Src/Tools/Custom/agentRecruiter.js';
import { configureToolServicePorts } from '../../Src/Tools/Registry/toolServicePorts.js';
import { recruitAgent, getRecruitedAgents } from '../../Src/Services/Recruitment/recruiter.js';
import type { ToolExecutionContext } from '../../Src/Tools/Traits/toolSpec.js';
import {
  resetReviewer, configureReviewer, performReview,
} from '../../Src/Services/ReviewerAgent/reviewerAgent.js';
import {
  assignTask, submitForReview, resetAgentRuntime,
} from '../../Src/Core/AgentRuntime/agentRuntime.js';
import { resetEventBus } from '../../Src/Services/EventBus/eventBus.js';
import { clearMiddlewares } from '../../Src/Core/Middleware/middlewareRegistry.js';
import { resetRolePrompts } from '../../Src/Services/Prompts/promptRegistry.js';

const PASS_JSON = JSON.stringify({ score: 0.9, pass: true, evidence: [{ note: 'ok' }], defectCategory: null });

function toolCtx(role: string): ToolExecutionContext {
  return {
    operationId: 'op-skills-1',
    agentId: 'agent-skills-1',
    agentRole: role,
    loopId: 'loop-skills-1',
    traceId: 'trace-skills-1',
  } as ToolExecutionContext;
}

beforeEach(() => {
  resetAgentRegistry();
  resetAgentFactory();
  resetAgentRuntime();
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  resetSkillsAssets();
  resetReviewer();
  clearLedger();
  resetEventBus();
  clearMiddlewares();
  resetRolePrompts();
  h.callModel.mockReset();
  h.callModelStream.mockReset();
  // 分层修正（2026-10-04）：agent.recruit 经端口注入招募服务（Tools 不可直连 Services）
  configureToolServicePorts({ recruitment: { recruitAgent, getRecruitedAgents } });
});

afterEach(() => {
  resetSkillsAssets();
  configureStrategyCandidates([]);
});

// ═══════════════════════════════════════════════════════════════════
// 1. skillsAssets 装载与查询
// ═══════════════════════════════════════════════════════════════════

describe('FE-071 · skillsAssets', () => {
  it('真实装载：playbook / rubric / strategies / 法典文档', () => {
    const loaded = loadSkillsAssets();
    expect(loaded.playbooks).toBeGreaterThanOrEqual(1);
    expect(loaded.rubricLoaded).toBe(true);
    expect(loaded.strategies).toBeGreaterThanOrEqual(5);
    expect(loaded.behaviorCodeLoaded).toBe(true);

    expect(getPlaybook('taskExecution')).toContain('任务执行 Playbook');
    expect(getBehaviorCodeMarkdown()).toContain('R-001');

    const rubric = getL3Rubric();
    expect(rubric).not.toBeNull();
    expect(rubric!.some(r => r.includes('correctness'))).toBe(true);
    expect(rubric!.some(r => r.includes('权重'))).toBe(true);

    const strategies = getStrategyCandidates();
    expect(strategies.length).toBeGreaterThanOrEqual(5);
    expect(strategies[0]).toHaveProperty('strategy');
  });

  it('未装载 → 各 getter 降级为 null/空（向后兼容）', () => {
    resetSkillsAssets();
    expect(getPlaybook('taskExecution')).toBeNull();
    expect(getL3Rubric()).toBeNull();
    expect(getBehaviorCodeMarkdown()).toBeNull();
    expect(getStrategyCandidates()).toEqual([]);
  });

  it('agentFactory：执行级角色注入 Playbook；reviewer 不注入；未装载退化', () => {
    // 未装载：worker 无 playbook
    const bare = createAgent({ role: 'worker', model: 'test-model' }, 'trace-s1');
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.value.systemPrompt ?? '').not.toContain('任务执行 Playbook');

    // 装载后：worker/assembly_node 注入；reviewer 不注入
    loadSkillsAssets();
    const worker = createAgent({ role: 'worker', model: 'test-model' }, 'trace-s1');
    expect(worker.ok).toBe(true);
    if (worker.ok) expect(worker.value.systemPrompt).toContain('任务执行 Playbook');

    const node = createAgent({ role: 'assembly_node', model: 'test-model' }, 'trace-s1');
    expect(node.ok).toBe(true);
    if (node.ok) expect(node.value.systemPrompt).toContain('任务执行 Playbook');

    const reviewer = createAgent({ role: 'reviewer', model: 'test-model' }, 'trace-s1');
    expect(reviewer.ok).toBe(true);
    if (reviewer.ok) expect(reviewer.value.systemPrompt ?? '').not.toContain('任务执行 Playbook');
  });

  it('performReview：L3 rubric 消费校准资产（rubricDimensions → Judge prompt）', async () => {
    loadSkillsAssets();

    const worker = createAgent({ role: 'worker', model: 'worker-model' }, 'trace-s2');
    const reviewer = createAgent({ role: 'reviewer', model: 'reviewer-model' }, 'trace-s2');
    expect(worker.ok && reviewer.ok).toBe(true);
    if (!worker.ok || !reviewer.ok) return;

    assignTask(worker.value.agentId, 'task-s2', 'trace-s2');
    submitForReview({
      taskId: 'task-s2',
      workerAgentId: worker.value.agentId,
      payload: { summary: '实现模块并附单元测试' },
    });

    let seenPrompt = '';
    configureReviewer({
      judgeModel: 'judge-model-x',
      callModelFn: async (_model, prompt) => {
        seenPrompt = prompt;
        return PASS_JSON;
      },
    });

    const review = await performReview({ taskId: 'task-s2', reviewerAgentId: reviewer.value.agentId });
    expect(review.ok).toBe(true);
    // 校准资产的 rubric 维度进入 Judge prompt（含权重描述）
    expect(seenPrompt).toContain('correctness');
    expect(seenPrompt).toContain('权重');
  });

  it('strategyLedger：候选注入 + 缺省消费 + 失败策略排除', () => {
    configureStrategyCandidates(['拆解为更小子任务', '切换实现方法']);
    expect(getStrategyCandidatesInjected()).toEqual(['拆解为更小子任务', '切换实现方法']);

    // 缺省消费（不传显式 candidates）
    const first = selectNextStrategy('loop-skills');
    expect(first.strategy).toBe('拆解为更小子任务');
    expect(first.escalated).toBe(false);

    // 记录一次失败 → 下一个候选
    recordStrategy('loop-skills', {
      iteration: 1,
      strategy: '拆解为更小子任务',
      expectedOutcome: '尝试拆解',
      actualOutcome: '仍然失败',
      failureReason: '无进展',
    });
    const second = selectNextStrategy('loop-skills');
    expect(second.strategy).toBe('切换实现方法');

    // 全部失败 → 升级人工
    recordStrategy('loop-skills', {
      iteration: 2,
      strategy: '切换实现方法',
      expectedOutcome: '换法重试',
      failureReason: '仍失败',
    });
    const third = selectNextStrategy('loop-skills');
    expect(third.escalated).toBe(true);
    expect(third.strategy).toBe('escalate_human');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. agent.recruit 降级 + executor 执行入口
// ═══════════════════════════════════════════════════════════════════

describe('FE-072 · Agent 执行入口', () => {
  it('agent.recruit：dispatch 如实降级为 manual（指向执行端点）', async () => {
    const result = await agentRecruiter.execute(
      { role: 'worker', task: '实现一个工具函数并自测' },
      toolCtx('prime_director'),
    );
    expect(result.status).toBe('success');
    const payload = JSON.parse(String(result.content)) as { dispatch: string; hint: string; agentId: string };
    expect(payload.dispatch).toBe('manual');
    expect(payload.hint).toContain('/execute');
    expect(payload.agentId).toBeTruthy();
    // 招募实体的状态与注册表（ready）
    expect(getAgent(payload.agentId)?.status).toBe('ready');
  });

  it('executor：不存在 / 终态 Agent → 拒绝', async () => {
    const missing = await executeAssignedTask({ agentId: 'agent-nonexistent' });
    expect(missing.ok).toBe(false);

    const created = createAgent({ role: 'worker', model: 'test-model' }, 'trace-s3');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    updateAgent(created.value.agentId, { status: 'expelled' });

    const denied = await executeAssignedTask({ agentId: created.value.agentId });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain('expelled');
  });

  it('executor：mock 模型下的真实执行链路（executeLoop 收口 + 结果回传）', async () => {
    h.callModel.mockResolvedValue({
      ok: true,
      value: {
        content: 'done',
        finish_reason: 'stop',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'test-model',
      },
    });

    const created = createAgent({ role: 'worker', model: 'test-model' }, 'trace-s4');
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await executeAssignedTask({
      agentId: created.value.agentId,
      instruction: '简短回复完成',
      maxIterations: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitReason).toBe('success');
    expect(result.value.iterations).toBe(1);
    expect(result.value.output).toBe('done');
    expect(result.value.tokensConsumed).toBeGreaterThan(0);
    expect(h.callModel).toHaveBeenCalledTimes(1);

    // ready → running（经 assignTask 驱动）
    expect(getAgent(created.value.agentId)?.status).toBe('running');
  });
});
