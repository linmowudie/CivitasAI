/**
 * @module AgentRuntime/agentFactory
 * @description
 * Agent 工厂——Docs/02 §6。
 * 按角色创建 Agent 实例，分配钱包，加载角色 Prompt。
 * Worker 不可自行宣告完成（必须走 submitForReview）。
 */

import type { AgentInstance, AgentRole, CreateAgentParams } from './types.js';
import { registerAgent, updateAgent } from './agentRegistry.js';
import { createWallet } from '../../Services/TokenEconomy/walletManager.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 内部计数 ────────────────────────────────────────────────────────

let agentCounter = 0;

// ── 创建 Agent ──────────────────────────────────────────────────────

/**
 * 创建并注册 Agent 实例。
 * 流程：creating → 分配钱包 → 加载 Prompt → ready
 */
export function createAgent(params: CreateAgentParams, traceId: string): Result<AgentInstance> {
  const agentId = `agent-${params.role}-${++agentCounter}`;
  const now = Date.now();

  // 创建 Agent 实例（初始状态 creating）
  const agent: AgentInstance = {
    agentId,
    role: params.role,
    status: 'creating',
    traceId,
    model: params.model,
    createdAt: now,
    updatedAt: now,
    lastTaskId: params.taskId,
    consecutiveFailures: 0,
    awaitingApproval: false,
  };

  // 注册到注册表
  const regResult = registerAgent(agent);
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
