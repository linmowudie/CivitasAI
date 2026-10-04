/**
 * @module Recruitment/recruiter
 * @description
 * Agent 招募器——Docs/Agent/03 §5.1。
 * 按需求招募 Agent，分配工具白名单，注册到 AgentRegistry。
 * 支持开除后重新招募（新 Agent 继承上下文）。
 */

import type { RecruitmentRequest } from '../../Core/Decision/types.js';
import type { AgentInstance } from '../../Core/AgentRuntime/types.js';
import { createAgent } from '../../Core/AgentRuntime/agentFactory.js';
import { getAgent, getAllAgents, updateAgent, setAgentParent, getAgentParent } from '../../Core/AgentRuntime/agentRegistry.js';
import { handleAgentEvent } from '../../Core/AgentRuntime/agentRuntime.js';
import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { getRoutingConfig } from '../../Infra/Llm/Router/modelRouter.js';

import * as agentRepository from '../../Infra/Db/Repositories/agentRepository.js';

import { recordTermination } from './terminationRationale.js';

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
  // FE-072：按角色解析**真实模型**（此前硬编码 'worker-model' 占位——执行时无可解析模型）；
  //   routing 未配置时保留占位（由执行入口的兜底解析处理）。
  const routing = getRoutingConfig();
  const roleModel = request.role === 'reviewer'
    ? (routing?.verifierModel || routing?.defaultModel)
    : (routing?.workerModel || routing?.defaultModel);
  const createResult = createAgent(
    { role: request.role, model: roleModel || 'worker-model' },
    request.traceId,
  );
  if (!createResult.ok) return createResult;

  const agent = createResult.value;

  // 父子关系（落库与编排/审计都依赖）：AgentInstance 类型无 parent 字段，故登记到注册表旁挂索引
  setAgentParent(agent.agentId, request.parentAgentId);

  // 更新元数据（Domain、Parent 等）
  updateAgent(agent.agentId, {
    lastTaskId: `task-${request.domain}`,
  });

  // 把**编排约束**落库：任务提示词 / 工具白名单 / Token 预算 / 迭代上限 / 超时。
  // 修复前这些请求字段被完全忽略 —— Agent 招募出来既无预算也无限额，多 Agent 治理形同虚设。
  agentRepository.upsertAgent({
    agentId: agent.agentId,
    traceId: request.traceId,
    parentAgentId: request.parentAgentId,
    role: String(request.role),
    // FE-052：角色提示词随实体落库（agents.system_prompt；此前该列无任何写入方）
    systemPrompt: agent.systemPrompt,
    taskPrompt: request.taskPrompt ?? null,
    allowedTools: request.requiredTools ?? null,
    tokenBudget: request.tokenBudget,
    maxIterations: request.maxIterations,
    timeoutMs: request.timeLimitMs,
    status: agent.status,
    createdAt: agent.createdAt,
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

// ── 开除 Agent（Docs/Agent/03 §5.3）───────────────────────────────────────

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

/**
 * 查询某次运行中**被招募出来的** Agent。
 *
 * 修复（2026-10-03）：此前是返回 `[]` 的桩，导致调用方（如招募上限保护）永远认为"没有子 Agent"。
 * 现在从注册表按 trace 过滤，并且只算**登记过父关系**的 Agent —— 父 Agent 自己也在同一 trace 下，
 * 不能被误算成子 Agent。
 */
export function getRecruitedAgents(traceId: string): AgentInstance[] {
  return getAllAgents().filter(a => a.traceId === traceId && getAgentParent(a.agentId) !== undefined);
}

// ── 清理（测试用）──────────────────────────────────────────────────

export async function resetRecruiter(): Promise<void> {
  // 清理依赖
  const { resetTerminations } = await import('./terminationRationale.js');
  resetTerminations();
}
