/**
 * @module Interface/RestApi/approvalApi
 * @description
 * 审批 API——Docs/Client/01 §5.2。
 * 审批队列查询 / 审批决策。
 * 约束：默认超时拒绝（禁止默认通过）；CRITICAL 需 2 角色审批。
 */

import { getPendingApprovals, getApproval, decideApproval, getRecentApprovals } from '../../Services/LoopControl/approvalGate.js';
import { resolveServerIdentity, extractBearerToken } from '../../Services/Governance/serverIdentity.js';
import { bindApprovalIdentity } from '../../Services/Governance/approvalIdentity.js';
import { publish, createEvent } from '../../Services/EventBus/eventBus.js';
import { EventType } from '../../Services/EventBus/eventTypes.js';

import { json, apiError, registerRoute } from './router.js';

/**
 * GET /api/approvals — 待审批队列
 */
export function listPendingApprovals(): unknown[] {
  return getPendingApprovals();
}

/**
 * GET /api/approvals?status=all — 待处理 + 已决（含落库历史，FE-005）：
 * 超时/拒绝后条目不再从列表消失，UI 可分「待处理 / 已决」两栏展示。
 */
export function listApprovals(includeDecided = false): unknown[] {
  if (includeDecided) return getRecentApprovals();
  return listPendingApprovals();
}

/**
 * GET /api/approvals/:approvalId — 审批详情
 */
export function getApprovalDetail(approvalId: string): unknown | undefined {
  return getApproval(approvalId);
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerApprovalRoutes(): void {
  registerRoute('GET', '/api/approvals', async (req) => {
    const status = (req.query['status'] ?? '').toLowerCase();
    const includeDecided = status === 'all' || req.query['include'] === 'decided';
    return json(listApprovals(includeDecided));
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

    // ★ 身份绑定（2026-10-04，G-09）：`decidedBy` 不再直接采信 ——
    //   `user` 绑定当前活动账号；Agent 角色必须是真实注册 Agent 且角色匹配。
    //   原因：身份是**法定人数去重的依据**，可伪造身份即可让一人顶替两个角色。
    // 方案 B（2026-10-04）：若携带服务端访问令牌 → 先向服务端验真，得到可信 userId；
    //   无令牌则回退方案 A（本地活动账号）。验真失败 fail-closed（403）。
    let verifiedUserId: string | undefined;
    const token = extractBearerToken(req.headers as Record<string, unknown> | undefined);
    if (token) {
      const verified = await resolveServerIdentity(token);
      if (!verified.ok) return apiError(`身份验真失败：${verified.error}`, 403);
      verifiedUserId = verified.value.userId;
    }

    const bound = bindApprovalIdentity(decidedBy, verifiedUserId ? { verifiedUserId } : {});
    if (!bound.ok) return apiError(bound.error, 403);

    const result = decideApproval({ approvalId, decidedBy: bound.value.decidedBy, approve, reason });
    if (!result.ok) return apiError(result.error, 409);

    // 广播决策：其他客户端/审批队列据此实时刷新；
    // 必须带 toolCallId，前端才能把"已通过/已拒绝"同步到对话中对应的工具行（内嵌审批卡）
    publish(createEvent({
      eventType: EventType.APPROVAL_DECIDED,
      source: 'approvalApi/decide',
      payload: {
        approvalId,
        toolCallId: result.value.toolCallId,
        sessionId: result.value.sessionId,
        toolName: result.value.toolName,
        status: result.value.status,
        approve,
        decidedBy: result.value.decidedBy,
        loopId: result.value.loopId,
      },
    }));

    return json(result.value);
  });
}
