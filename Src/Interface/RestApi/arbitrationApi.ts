/**
 * @module Interface/RestApi/arbitrationApi
 * @description
 * 仲裁域端点（FE-062 实装）——手动触发六步闭环与查询监管干预/恢复计划。
 *
 * 端点：
 *  - `POST /api/arbitration/cases`        → 执行完整仲裁（立案→胶囊→裁决→停职→恢复→沉淀）
 *  - `GET  /api/arbitration/interventions`→ 监管干预记录（finalArbiter）
 *  - `GET  /api/arbitration/restorations` → 恢复计划（restorationManager；可按 caseId 过滤）
 *
 * 说明：自动路径（GlobalWorkspace 语义冲突 → CONFLICT_DETECTED → 自动仲裁）
 * 由 `Services/Arbitration/arbitrationWiring.ts` 承担；本端点为显式/补录触发面。
 */

import { json, apiError, registerRoute } from './router.js';
import { executeFullArbitration } from '../../Services/Arbitration/tribunal.js';
import { getAllInterventions } from '../../Services/Regulation/finalArbiter.js';
import { getAllPlans, getPlansByCase } from '../../Services/Arbitration/restorationManager.js';
import type { ConflictType } from '../../Services/Arbitration/types.js';

const CONFLICT_TYPES: ConflictType[] = ['semantic_opposition', 'contradiction', 'duplication'];

export function registerArbitrationRoutes(): void {
  registerRoute('POST', '/api/arbitration/cases', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string) : '');

    const conflictId = str('conflictId');
    const conflictType = body['conflictType'] as ConflictType;
    const plaintiffAgentId = str('plaintiffAgentId');
    const defendantAgentId = str('defendantAgentId');
    const newMemoryContent = str('newMemoryContent');
    const oldMemoryContent = str('oldMemoryContent');
    const restorerAgentId = str('restorerAgentId');

    if (!conflictId || !plaintiffAgentId || !defendantAgentId) {
      return apiError('conflictId/plaintiffAgentId/defendantAgentId 必填', 400);
    }
    if (!CONFLICT_TYPES.includes(conflictType)) {
      return apiError(`conflictType 非法（合法：${CONFLICT_TYPES.join('/')}）`, 400);
    }
    if (!newMemoryContent || !oldMemoryContent) {
      return apiError('newMemoryContent/oldMemoryContent 必填（仲裁需要冲突双方原文）', 400);
    }

    const result = executeFullArbitration({
      conflictId,
      traceId: str('traceId') || `trace-arb-${Date.now()}`,
      conflictType,
      plaintiffAgentId,
      defendantAgentId,
      newMemoryContent,
      oldMemoryContent,
      taskDescription: str('taskDescription') || `手动提交的仲裁冲突 ${conflictId}`,
      restorerAgentId: restorerAgentId || plaintiffAgentId,
      ...(str('actorRole') ? { actorRole: str('actorRole') } : {}),
    });

    if (!result.ok) return apiError(result.error, 400);
    return json({ case: result.value });
  });

  registerRoute('GET', '/api/arbitration/interventions', async () => {
    return json({ items: getAllInterventions() });
  });

  registerRoute('GET', '/api/arbitration/restorations', async (req) => {
    const caseId = req.query['caseId'];
    const items = caseId ? getPlansByCase(caseId) : getAllPlans();
    return json({ items, total: items.length });
  });
}
