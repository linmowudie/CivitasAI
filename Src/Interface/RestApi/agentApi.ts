/**
 * @module Interface/RestApi/agentApi
 * @description
 * Agent API——Docs/Client/01 §2.3。
 * Agent 列表 / 详情 / 状态查询。
 */

import { getAllAgents, getAgent, getAgentsByStatus } from '../../Core/AgentRuntime/agentRegistry.js';
import { executeAssignedTask } from '../../Core/AgentRuntime/agentExecutor.js';

import { json, apiError, registerRoute } from './router.js';

/**
 * GET /api/agents — 查询 Agent 列表
 */
export function listAgents(filter?: { status?: string }): unknown[] {
  if (filter?.status) {
    return getAgentsByStatus(filter.status as any);
  }
  return getAllAgents();
}

/**
 * GET /api/agents/:agentId — 查询 Agent 详情
 */
export function getAgentDetail(agentId: string): unknown | undefined {
  return getAgent(agentId);
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerAgentRoutes(): void {
  registerRoute('GET', '/api/agents', async (req) => {
    const filter = req.query.status ? { status: req.query.status } : undefined;
    return json(listAgents(filter));
  });

  registerRoute('GET', '/api/agents/:agentId', async (req) => {
    const agent = getAgentDetail(req.params.agentId ?? '');
    if (!agent) return apiError('Agent not found', 404);
    return json(agent);
  });

  /**
   * POST /api/agents/:agentId/execute —— 驱动 Agent 执行已登记任务（FE-072）。
   * 同步等待整轮 Loop 完成；body：{ instruction?, model?, maxIterations? }。
   */
  registerRoute('POST', '/api/agents/:agentId/execute', async (req) => {
    const agentId = req.params.agentId ?? '';
    if (!agentId) return apiError('agentId is required', 400);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const result = await executeAssignedTask({
      agentId,
      instruction: typeof body['instruction'] === 'string' ? body['instruction'] : undefined,
      model: typeof body['model'] === 'string' ? body['model'] : undefined,
      maxIterations: typeof body['maxIterations'] === 'number' ? body['maxIterations'] : undefined,
    });
    if (!result.ok) return apiError(result.error, 400);
    return json(result.value);
  });
}
