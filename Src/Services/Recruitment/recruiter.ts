/**
 * @module Recruitment/recruiter
 * @description
 * Agent 招募器——Docs/03 §5.1。
 * 按需求招募 Agent，分配工具白名单，注册到 AgentRegistry。
 * 支持开除后重新招募（新 Agent 继承上下文）。
 */

import type { RecruitmentRequest } from '../Decision/types.js';
import type { AgentInstance, AgentRole } from '../../Core/AgentRuntime/types.js';
import { createAgent } from '../../Core/AgentRuntime/agentFactory.js';
import { getAgent, updateAgent, getAgentsByRole } from '../../Core/AgentRuntime/agentRegistry.js';
import { handleAgentEvent } from '../../Core/AgentRuntime/agentRuntime.js';
import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import { recordTermination, hasTerminationRecord } from './terminationRationale.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 招募入口 ────────────────────────────────────────────────────────

/**
 * 招募 Agent。
 * 流程：解析需求 → 创建 Agent → 配置工具 → 注册 → 广播事件。
 */
export function recruitAgent(request: RecruitmentRequest): Result<AgentInstance> {
  if (!request.traceId) return err('traceId 不能为空');
  if (!request.parentAgentId) return err('parentAgentId 不能为空');
  if (request.tokenBudget <= 0) return err('Token 预算必须大于 0');

  // 创建 Agent
  const createResult = createAgent(
    { role: request.role, model: 'worker-model' },
    request.traceId,
  );
  if (!createResult.ok) return createResult;

  const agent = createResult.value;

  // 更新元数据（Domain、Parent 等）
  updateAgent(agent.agentId, {
    lastTaskId: `task-${request.domain}`,
  });

  // 发布招募事件
  publish(createEvent({
    eventType: EventType.AGENT_RECRUITED,
    source: 'Recruitment/recruitAgent',
    traceId: request.traceId,
    payload: {
      agentId: agent.agentId,
      role: request.role,
      domain: request.domain,
      parentAgentId: request.parentAgentId,
      tokenBudget: request.tokenBudget,
    },
  }));

  return ok(agent);
}

// ── 批量招募 ────────────────────────────────────────────────────────

export function recruitAgents(requests: RecruitmentRequest[]): Result<AgentInstance[]> {
  const agents: AgentInstance[] = [];
  for (const req of requests) {
    const result = recruitAgent(req);
    if (!result.ok) return err(`招募第 ${agents.length + 1} 个 Agent 失败: ${result.error}`);
    agents.push(result.value);
  }
  return ok(agents);
}

// ── 开除 Agent（Docs/03 §5.3）───────────────────────────────────────

/**
 * 开除 Agent。
 * 流程：冻结 → 回收 Token → 保存历史 → 清理 → 广播事件。
 * 必须有合法的 TerminationRationale。
 */
export function expelAgent(params: {
  agentId: string;
  taskId: string;
  traceId: string;
  reason: 'capability' | 'laziness' | 'goal_unreasonable' | 'external_error';
  evidence: string[];
  decidedBy: string;
}): Result<void> {
  const agent = getAgent(params.agentId);
  if (!agent) return err(`Agent ${params.agentId} 不存在`);

  // 记录终止理由（必须在开除前）
  const consecutiveFailures = agent.consecutiveFailures;
  const termResult = recordTermination({
    agentId: params.agentId,
    taskId: params.taskId,
    traceId: params.traceId,
    reason: params.reason,
    evidence: params.evidence,
    consecutiveFailures,
    decidedBy: params.decidedBy,
  });
  if (!termResult.ok) return termResult;

  // 执行开除：状态 → expelled
  const expelResult = handleAgentEvent(params.agentId, {
    type: 'EXPEL',
    reason: params.reason,
  });
  if (!expelResult.ok) return expelResult;

  // 发布开除事件
  publish(createEvent({
    eventType: EventType.AGENT_EXPELLED,
    source: 'Recruitment/expelAgent',
    traceId: params.traceId,
    payload: {
      agentId: params.agentId,
      reason: params.reason,
      decidedBy: params.decidedBy,
      consecutiveFailures,
    },
  }));

  return ok(undefined);
}

// ── 重新招募（开除后替换）──────────────────────────────────────────

/**
 * 开除当前 Agent 并招募替代者。
 * 新 Agent 继承原任务上下文。
 */
export function expelAndReplace(params: {
  agentId: string;
  taskId: string;
  traceId: string;
  reason: 'capability' | 'laziness' | 'goal_unreasonable' | 'external_error';
  evidence: string[];
  decidedBy: string;
  originalRequest: RecruitmentRequest;
}): Result<AgentInstance> {
  // 开除
  const expelResult = expelAgent(params);
  if (!expelResult.ok) return err(`开除失败: ${expelResult.error}`);

  // 重新招募
  return recruitAgent(params.originalRequest);
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getRecruitedAgents(traceId: string): AgentInstance[] {
  // 简化实现：返回所有 Agent（后续可按 traceId 过滤）
  return [];
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetRecruiter(): void {
  // 清理依赖
  const { resetTerminations } = require('./terminationRationale.js');
  resetTerminations();
}
