/**
 * @module Interface/RestApi/loopApi
 * @description
 * Loop API——Docs/09 §2。
 * Loop 状态查询 / 事件日志 / 仲裁案件。
 */

import { json, apiError, registerRoute } from './router.js';
import { getEventLog } from '../../Services/EventBus/eventBus.js';
import { getAllCases, getCase } from '../../Services/Arbitration/tribunal.js';
import { getPoolStats } from '../../Services/Arbitration/arbitratorPool.js';
import { getAllAgents } from '../../Core/AgentRuntime/agentRegistry.js';

/**
 * GET /api/loops/events — 事件日志
 */
export function getEvents(filter?: {
  eventType?: string;
  traceId?: string;
  limit?: number;
}): unknown[] {
  return getEventLog({
    eventType: filter?.eventType as any,
    traceId: filter?.traceId,
    limit: filter?.limit,
  });
}

/**
 * GET /api/loops/dashboard — 大屏概览
 */
export function getDashboardOverview(): {
  activeAgents: number;
  totalAgents: number;
  activeArbitrationCases: number;
  totalArbitrationCases: number;
  arbitratorPool: unknown;
  recentEvents: number;
} {
  const agents = getAllAgents();
  const cases = getAllCases();
  const activeCases = cases.filter(c =>
    c.status !== 'completed' && c.status !== 'timeout'
  );

  return {
    activeAgents: agents.filter(a => a.status === 'running').length,
    totalAgents: agents.length,
    activeArbitrationCases: activeCases.length,
    totalArbitrationCases: cases.length,
    arbitratorPool: getPoolStats(),
    recentEvents: getEventLog().length,
  };
}

/**
 * GET /api/loops/arbitration — 仲裁案件列表
 */
export function listArbitrationCases(): unknown[] {
  return getAllCases();
}

/**
 * GET /api/loops/arbitration/:caseId — 仲裁案件详情
 */
export function getArbitrationCase(caseId: string): unknown | undefined {
  return getCase(caseId);
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerLoopRoutes(): void {
  registerRoute('GET', '/api/loops/events', async (req) => {
    const filter: Record<string, any> = {};
    if (req.query.eventType) filter.eventType = req.query.eventType;
    if (req.query.traceId) filter.traceId = req.query.traceId;
    if (req.query.limit) filter.limit = parseInt(req.query.limit, 10);
    return json(getEvents(filter));
  });

  registerRoute('GET', '/api/loops/dashboard', async () => {
    return json(getDashboardOverview());
  });

  registerRoute('GET', '/api/loops/arbitration', async () => {
    return json(listArbitrationCases());
  });

  registerRoute('GET', '/api/loops/arbitration/:caseId', async (req) => {
    const c = getArbitrationCase(req.params.caseId);
    if (!c) return apiError('Case not found', 404);
    return json(c);
  });
}
