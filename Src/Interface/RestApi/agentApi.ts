/**
 * @module Interface/RestApi/agentApi
 * @description
 * Agent API——Docs/09 §2.3。
 * Agent 列表 / 详情 / 状态查询。
 */

import { json, apiError, registerRoute } from './router.js';
import { getAllAgents, getAgent, getAgentsByStatus } from '../../Core/AgentRuntime/agentRegistry.js';

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
    const agent = getAgentDetail(req.params.agentId);
    if (!agent) return apiError('Agent not found', 404);
    return json(agent);
  });
}
