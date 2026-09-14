/**
 * @module AgentRuntime/agentRegistry
 * @description
 * Agent 注册表——Docs/02 §6。
 * 管理所有 Agent 实例的生命周期，提供 CRUD + 查询。
 */

import type { AgentInstance, AgentStatus, AgentRole } from './types.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 内部状态 ────────────────────────────────────────────────────────

const agents: Map<string, AgentInstance> = new Map();

// ── 注册 ────────────────────────────────────────────────────────────

export function registerAgent(agent: AgentInstance): Result<void> {
  if (agents.has(agent.agentId)) {
    return err(`Agent ${agent.agentId} 已注册`);
  }
  agents.set(agent.agentId, { ...agent });
  return ok(undefined);
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getAgent(agentId: string): AgentInstance | undefined {
  const agent = agents.get(agentId);
  return agent ? { ...agent } : undefined;
}

export function getAllAgents(): AgentInstance[] {
  return [...agents.values()].map(a => ({ ...a }));
}

export function getAgentsByStatus(status: AgentStatus): AgentInstance[] {
  return getAllAgents().filter(a => a.status === status);
}

export function getAgentsByRole(role: AgentRole): AgentInstance[] {
  return getAllAgents().filter(a => a.role === role);
}

export function getReadyWorkers(): AgentInstance[] {
  return getAllAgents().filter(a => a.role === 'worker' && a.status === 'ready');
}

// ── 更新 ────────────────────────────────────────────────────────────

export function updateAgentStatus(
  agentId: string,
  status: AgentStatus,
): Result<AgentInstance> {
  const agent = agents.get(agentId);
  if (!agent) return err(`Agent ${agentId} 不存在`);

  agent.status = status;
  agent.updatedAt = Date.now();
  return ok({ ...agent });
}

export function updateAgent(agentId: string, updates: Partial<AgentInstance>): Result<AgentInstance> {
  const agent = agents.get(agentId);
  if (!agent) return err(`Agent ${agentId} 不存在`);

  Object.assign(agent, updates, { updatedAt: Date.now() });
  return ok({ ...agent });
}

// ── 注销 ────────────────────────────────────────────────────────────

export function unregisterAgent(agentId: string): Result<void> {
  if (!agents.has(agentId)) return err(`Agent ${agentId} 不存在`);
  agents.delete(agentId);
  return ok(undefined);
}

// ── 统计 ────────────────────────────────────────────────────────────

export function getAgentCount(): number {
  return agents.size;
}

export function getStatusSummary(): Record<AgentStatus, number> {
  const summary: Record<AgentStatus, number> = {
    creating: 0, ready: 0, running: 0,
    suspended: 0, expelled: 0, destroyed: 0,
  };
  for (const agent of agents.values()) {
    summary[agent.status]++;
  }
  return summary;
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetAgentRegistry(): void {
  agents.clear();
}
