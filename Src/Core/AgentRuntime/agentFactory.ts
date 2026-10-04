/**
 * @module AgentRuntime/agentFactory
 * @description
 * Agent 工厂——Docs/Agent/02 §6。
 * 按角色创建 Agent 实例，分配钱包，装载角色 Prompt（FE-052：promptRegistry）。
 * Worker 不可自行宣告完成（必须走 submitForReview）。
 */

import { createWallet } from '../../Services/TokenEconomy/walletManager.js';
import { getRolePrompt } from '../../Services/Prompts/promptRegistry.js';
import { getPlaybook } from '../../Services/Prompts/skillsAssets.js';
import { denyReasonForAgentRole } from '../../Infra/Roles/roleVocabulary.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import { registerAgent, updateAgent } from './agentRegistry.js';
import type { AgentInstance, AgentRole, CreateAgentParams } from './types.js';

// ── 内部计数 ────────────────────────────────────────────────────────

let agentCounter = 0;

/** 附加任务执行 Playbook 的执行级角色（FE-071：worker/partner/assembly_node） */
const EXECUTION_ROLES_WITH_PLAYBOOK = new Set(['worker', 'partner', 'assembly_node']);

// ── 创建 Agent ──────────────────────────────────────────────────────

/**
 * 创建并注册 Agent 实例。
 * 流程：creating → 分配钱包 → 加载 Prompt → ready
 */
export function createAgent(
  params: CreateAgentParams,
  traceId: string,
  /** 系统播种开关（G-11）：默认禁止以治理角色创建 Agent；仅受控系统路径可显式打开 */
  options: { allowGovernance?: boolean } = {},
): Result<AgentInstance> {
  // ★ 角色赋权守卫（G-11，2026-10-04）：
  //   治理角色（regulator / regulatory_authority / auditor / arbitrator）**不得被赋权**给 Agent。
  //   修复前仅招募工具有此限制，工厂层无校验 ⇒ 任意调用方可伪造 L0 身份。
  const denied = denyReasonForAgentRole(params.role, options.allowGovernance ?? false);
  if (denied) return err(denied);

  const agentId = `agent-${params.role}-${++agentCounter}`;
  const now = Date.now();

  // FE-052：装载角色提示词——显式传入优先；缺省从 promptRegistry 按角色查询
  //   （未装载/未知角色 → undefined，实体不携带提示词，行为与修复前一致）
  const basePrompt = params.systemPrompt ?? getRolePrompt(String(params.role));
  // FE-071：执行级角色附加任务执行 Playbook（Skills/playbooks/*；未装载时退化）
  const playbook = EXECUTION_ROLES_WITH_PLAYBOOK.has(String(params.role))
    ? getPlaybook('taskExecution')
    : null;
  const systemPrompt = playbook
    ? `${basePrompt ? `${basePrompt}

---

` : ''}${playbook}`
    : basePrompt;

  // 创建 Agent 实例（初始状态 creating）
  const agent: AgentInstance = {
    agentId,
    role: params.role,
    status: 'creating',
    traceId,
    model: params.model,
    systemPrompt,
    createdAt: now,
    updatedAt: now,
    lastTaskId: params.taskId,
    consecutiveFailures: 0,
    awaitingApproval: false,
  };

  // 注册到注册表
  // 透传系统播种开关（否则会撞上注册表的防御纵守卫）
  const regResult = registerAgent(agent, options);
  if (!regResult.ok) return regResult;

  // 分配 Token 钱包
  const walletResult = createWallet(agentId, traceId);
  if (walletResult.ok) {
    agent.walletId = walletResult.value.walletId;
  }
  // 钱包创建失败不阻断（降级模式）

  // 初始化完成 → ready（同步更新注册表）
  agent.status = 'ready';
  agent.updatedAt = Date.now();
  updateAgent(agentId, { status: 'ready', walletId: agent.walletId });

  return ok({ ...agent });
}

/**
 * 批量创建 Agent
 */
export function createAgentBatch(
  params: { role: AgentRole; model: string; count: number },
  traceId: string,
): Result<AgentInstance[]> {
  const agents: AgentInstance[] = [];
  for (let i = 0; i < params.count; i++) {
    const result = createAgent({ role: params.role, model: params.model }, traceId);
    if (!result.ok) return err(`批量创建第 ${i + 1} 个 Agent 失败: ${result.error}`);
    agents.push(result.value);
  }
  return ok(agents);
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetAgentFactory(): void {
  agentCounter = 0;
}
