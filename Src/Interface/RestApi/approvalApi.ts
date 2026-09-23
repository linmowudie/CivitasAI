/**
 * @module Interface/RestApi/approvalApi
 * @description
 * 审批 API——Docs/09 §5.2。
 * 审批队列查询 / 审批决策。
 * 约束：默认超时拒绝（禁止默认通过）；CRITICAL 需 2 角色审批。
 */

import { getPendingApprovals, getApproval, decideApproval } from '../../Services/LoopControl/approvalGate.js';

import { json, apiError, registerRoute } from './router.js';

/**
 * GET /api/approvals — 待审批队列
 */
export function listPendingApprovals(): unknown[] {
  return getPendingApprovals();
}

/**
 * GET /api/approvals/:approvalId — 审批详情
 */
export function getApprovalDetail(approvalId: string): unknown | undefined {
  return getApproval(approvalId);
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerApprovalRoutes(): void {
  registerRoute('GET', '/api/approvals', async () => {
    return json(listPendingApprovals());
  });

  registerRoute('GET', '/api/approvals/:approvalId', async (req) => {
    const approvalId = req.params.approvalId;
    if (!approvalId) return apiError('approvalId is required', 400);
    const approval = getApprovalDetail(approvalId);
    if (!approval) return apiError('Approval not found', 404);
    return json(approval);
  });

  // F0.4：审批决策端点（默认拒绝语义不变）
  registerRoute('POST', '/api/approvals/:approvalId/decide', async (req) => {
    const approvalId = req.params.approvalId;
    if (!approvalId) return apiError('approvalId is required', 400);
    const decidedBy = req.body?.decidedBy as string;
    const approve = req.body?.approve as boolean;
    const reason = req.body?.reason as string | undefined;

    if (!decidedBy || typeof approve !== 'boolean') {
      return apiError('decidedBy (string) and approve (boolean) are required');
    }

    const result = decideApproval({ approvalId, decidedBy, approve, reason });
    if (!result.ok) return apiError(result.error, 409);
    return json(result.value);
  });
}
