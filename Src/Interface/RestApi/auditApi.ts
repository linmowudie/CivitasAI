/**
 * @module Interface/RestApi/auditApi
 * @description
 * 审计域端点（FE-061 实装）——为审计局四件（冻结 / 巡检 / 异常检测 / 稽查）提供触发与查询面。
 *
 * 端点：
 *  - `GET  /api/audit/status`                 → 冻结列表 + 最新巡检 + 关键告警（面板概览）
 *  - `POST /api/audit/freeze`                 → 冻结 Agent（治理动作）
 *  - `POST /api/audit/unfreeze`               → 解冻 Agent（治理动作）
 *  - `POST /api/audit/investigate`            → 深度稽查（可产出自动冻结判定）
 *  - `POST /api/audit/patrol`                 → 手动触发一次巡检
 *  - `GET  /api/audit/reports`                → 巡检历史
 *
 * 说明：冻结的**执行效力**由前置监管承担（`runPreSupervision` 拒冻结 Agent，FE-061 联动）。
 */

import { json, apiError, registerRoute } from './router.js';
import {
  freeze, unfreeze, investigate, getFrozenAgents, getAuditReports,
} from '../../Services/Audit/resourceAuditBureau.js';
import { getFreezeHistory } from '../../Services/Audit/freezeManager.js';
import { getCriticalAlerts, getAlerts } from '../../Services/Audit/anomalyDetector.js';
import { getLatestReport, getReports } from '../../Services/Audit/patrolScheduler.js';

function errorStatus(message: string): number {
  return /拒绝|仅|权限|role|guard/i.test(message) ? 403 : 400;
}

export function registerAuditRoutes(): void {
  registerRoute('GET', '/api/audit/status', async () => {
    return json({
      frozenAgents: getFrozenAgents(),
      latestPatrol: getLatestReport() ?? null,
      criticalAlerts: getCriticalAlerts(),
      alertCount: getAlerts().length,
    });
  });

  registerRoute('POST', '/api/audit/freeze', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const agentId = typeof body['agentId'] === 'string' ? body['agentId'] : '';
    const reason = typeof body['reason'] === 'string' ? body['reason'] : '';
    const actorRole = typeof body['actorRole'] === 'string' ? body['actorRole'] : '';
    if (!agentId || !reason) return apiError('agentId/reason 必填', 400);

    const result = freeze(agentId, reason, actorRole);
    if (!result.ok) return apiError(result.error, errorStatus(result.error));
    return json({ freeze: result.value });
  });

  registerRoute('POST', '/api/audit/unfreeze', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const agentId = typeof body['agentId'] === 'string' ? body['agentId'] : '';
    const actorRole = typeof body['actorRole'] === 'string' ? body['actorRole'] : '';
    if (!agentId) return apiError('agentId 必填', 400);

    const result = unfreeze(agentId, actorRole);
    if (!result.ok) return apiError(result.error, errorStatus(result.error));
    return json({ unfrozen: agentId });
  });

  registerRoute('POST', '/api/audit/investigate', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const agentId = typeof body['agentId'] === 'string' ? body['agentId'] : '';
    const actorRole = typeof body['actorRole'] === 'string' ? body['actorRole'] : '';
    if (!agentId) return apiError('agentId 必填', 400);

    const result = investigate(agentId, actorRole);
    if (!result.ok) return apiError(result.error, errorStatus(result.error));
    return json({ report: result.value, frozenAgents: getFrozenAgents() });
  });

  registerRoute('POST', '/api/audit/patrol', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actorRole = typeof body['actorRole'] === 'string' ? body['actorRole'] : '';
    // 手动巡检 = 即时刷新真实快照（经济记账 + 注册表）后执行——不依赖周期任务先跑
    const { refreshAgentSnapshots } = await import('../../Services/Audit/auditScheduler.js');
    refreshAgentSnapshots();
    const { runPatrol } = await import('../../Services/Audit/resourceAuditBureau.js');
    const result = runPatrol(actorRole);
    if (!result.ok) return apiError(result.error, errorStatus(result.error));
    return json({ report: result.value });
  });

  registerRoute('GET', '/api/audit/reports', async (req) => {
    const limitRaw = req.query['limit'];
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || (limit as number) < 0)) {
      return apiError('limit 必须是 >= 0 的数字', 400);
    }
    const reports = getReports();
    const freezeHistory = getFreezeHistory();
    return json({
      items: limit !== undefined ? reports.slice(-limit) : reports,
      freezeHistory: limit !== undefined ? freezeHistory.slice(-limit) : freezeHistory,
      auditReports: getAuditReports(),
    });
  });
}
