/**
 * @module Interface/RestApi/governanceApi
 * @description 治理动作留痕的查询端点（2026-10-04 新增，配合清单 G-10）。
 *
 * 端点：
 *  - `GET /api/governance/records?action=&actorRole=&outcome=&limit=` → 台账查询
 *  - `GET /api/governance/summary` → 规模与拒绝统计（面板概览用）
 *
 * 说明：台账当前为**进程内**（`Services/Governance/governanceAudit`），
 * 事件实时面由 `governance:action_recorded` 承担；本端点用于**页面刷新后的历史回填**。
 * 落库属后续项（见 `Docs/Dev/治理层完善清单.md` G-10 备注）。
 */

import { registerRoute, apiError } from './router.js';
import {
  listGovernanceRecords,
} from '../../Services/Governance/governanceAudit.js';

export function registerGovernanceRoutes(): void {
  registerRoute('GET', '/api/governance/records', async (req) => {
    try {
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const limitRaw = q['limit'];
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      if (limitRaw !== undefined && (!Number.isFinite(limit) || (limit as number) < 0)) {
        return apiError('limit 必须是 >= 0 的数字', 400);
      }
      const records = listGovernanceRecords({
        ...(q['action'] ? { action: q['action'] } : {}),
        ...(q['actorRole'] ? { actorRole: q['actorRole'] } : {}),
        ...(q['outcome'] ? { outcome: q['outcome'] as 'allowed' | 'denied' | 'failed' } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return { status: 200, body: { ok: true, data: { records, total: records.length } } };
    } catch (e) {
      return apiError(e instanceof Error ? e.message : String(e), 500);
    }
  });

  registerRoute('GET', '/api/governance/summary', async () => {
    const all = listGovernanceRecords();
    const denied = all.filter(r => r.outcome === 'denied').length;
    const byAction: Record<string, number> = {};
    for (const r of all) byAction[r.action] = (byAction[r.action] ?? 0) + 1;
    // FE-044：total 与 denied/allowed/byAction 同口径（此前用内存计数，
    // 重启后与其余统计不一致——内存为 0 而持久化有记录）
    return {
      status: 200,
      body: { ok: true, data: { total: all.length, denied, allowed: all.length - denied, byAction } },
    };
  });
}
