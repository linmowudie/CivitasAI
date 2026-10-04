/**
 * @module AgentRuntime/agentExecutor
 * @description
 * Agent 任务执行入口（FE-072 实装）——把"已登记任务"的 Agent 真正驱动起来。
 *
 * 修复背景：`agent.recruit`（及编排）创建的 Agent 登记 `lastTaskId` 后**无执行驱动**
 * （recruit 工具返回值自陈 `dispatch: 'pending'`——"派发执行由编排调度负责"，而该链路缺失）。
 * 现提供最小执行链路：构造 Loop 配置与状态 → `executeLoop` 真实执行 → 状态回写。
 *
 * 边界（诚实说明）：同步等待整轮 Loop 完成（REST 端点语义）；长任务/并发调度
 * 建议后续接异步任务队列（当前复用 middleware 注册与既有中断语义）。
 */

import { getAgent } from './agentRegistry.js';
import { assignTask } from './agentRuntime.js';
import { createLoopConfig } from '../Loop/loopConfig.js';
import { createLoopState } from '../Loop/loopEngine.js';
import { executeLoop } from '../Loop/runIteration.js';
import { resolveModel, getRoutingConfig } from '../../Infra/Llm/Router/modelRouter.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

export interface AgentExecutionResult {
  agentId: string;
  loopId: string;
  traceId: string;
  exitReason?: string;
  iterations: number;
  tokensConsumed: number;
  output: string;
}

/**
 * 驱动指定 Agent 执行其已登记任务（或由 `instruction` 显式指定指令）。
 * @returns 执行结果；Agent 不存在/终态/配置非法时返回错误
 */
export async function executeAssignedTask(params: {
  agentId: string;
  instruction?: string;
  model?: string;
  maxIterations?: number;
}): Promise<Result<AgentExecutionResult>> {
  const agent = getAgent(params.agentId);
  if (!agent) return err(`Agent ${params.agentId} 不存在`);
  if (agent.status === 'destroyed' || agent.status === 'expelled' || agent.status === 'suspended') {
    return err(`Agent ${params.agentId} 状态 ${agent.status}，不可执行`);
  }

  // FE-072：模型解析——agent.model 为占位符（'worker-model' 等）或未注册时，
  //   回退到 routing 的 worker/default 模型（历史数据与 orchestrator 占位都可驱动执行）
  let model = params.model ?? agent.model;
  if (!model || !resolveModel(model).ok) {
    const routing = getRoutingConfig();
    const fallback = routing?.workerModel || routing?.defaultModel;
    if (fallback && resolveModel(fallback).ok) {
      model = fallback;
    }
  }
  const configResult = createLoopConfig({
    model,
    stream: false,
    ...(params.maxIterations !== undefined ? { max_iterations: params.maxIterations } : {}),
  });
  if (!configResult.ok) return err(configResult.error);

  const loopId = `loop-exec-${params.agentId}-${Date.now()}`;
  const traceId = `trace-exec-${Date.now().toString(36)}`;

  // ready → running（未登记任务号时兜底生成，保证状态机可流转）
  if (agent.status === 'ready') {
    assignTask(params.agentId, agent.lastTaskId ?? `task-adhoc-${Date.now().toString(36)}`, traceId);
  }

  const instruction = params.instruction
    ?? `执行你被分配的任务${agent.lastTaskId ? `（taskId=${agent.lastTaskId}）` : ''}。`
      + '若任务详情不可见，请基于你的角色职责与已登记约束继续。';

  const loopState = createLoopState({
    loopId,
    agentId: params.agentId,
    traceId,
    config: configResult.value,
  });

  const result = await executeLoop(loopState, {
    userInput: instruction,
    sessionId: `agent-exec-${params.agentId}`,
    agentId: params.agentId,
    agentRole: agent.role,
    config: configResult.value,
    chatMessages: [{ role: 'user', content: instruction }],
    recentCallTimestamps: [],
  });
  if (!result.ok) return err(result.error);

  const last = result.value.iterations[result.value.iterations.length - 1];
  return ok({
    agentId: params.agentId,
    loopId,
    traceId,
    exitReason: result.value.exitReason,
    iterations: result.value.iterations.length,
    tokensConsumed: result.value.totalTokensConsumed,
    output: last?.outputText ?? '',
  });
}
