/**
 * @module Interface/RestApi/a2aApi
 * @description A2A 查询与操作面（P0a 后端）—— 设计 §9 接口草案 + §14.5（**过滤在后端**）。
 *
 * 身份门（复用 G-09 管线，**不采信自报角色**）：
 *  1. 有 Bearer 令牌 → `resolveServerIdentity` 向服务端验真（失败 403，fail-closed）；
 *  2. 无令牌 → 回退**本地活动账号**（桌面端单属主模型）；
 *  3. 验真属主 ≠ 当前活动属主 → 403（跨账号隔离）；
 *  4. `viewerAgentId` 只用于**切换观察视角**，且必须是本机已注册 Agent（`agentViewer` 会校验层级）。
 *
 * 端点：
 *  - `GET  /api/a2a/messages`            查询（按观察者过滤；跨域**不返回正文**）
 *  - `GET  /api/a2a/messages/:messageId` 单条
 *  - `GET  /api/a2a/cards/:agentId`      卡片（agent 仅见自身与直达父）
 *  - `GET  /api/a2a/alerts`              告警（L0/所有者全见；L1 仅计数）
 *  - `GET  /api/a2a/inbox`               治理队列待处置升级（仅 L0/所有者）
 *  - `POST /api/a2a/ack`                 确认收到（requiresAck 回执）
 *  - `POST /api/a2a/reveal`              申请查看被摘除正文（**仅 L0/所有者**；非 L0 指引走审批门）
 *  - `POST /api/a2a/inbox/drain`         取出升级并**按需唤醒 L0**（G-19）
 *  - `POST /api/a2a/alerts/:alertId/dispose` 处置告警（L0 且角色匹配）
 */

import { apiError, json, registerRoute } from './router.js';
import { extractBearerToken, resolveServerIdentity } from '../../Services/Governance/serverIdentity.js';
import { getActiveOwner } from '../../Services/AccountScope/activeAccount.js';
import { toCanonicalRole } from '../../Infra/Roles/roleVocabulary.js';
import {
  agentViewer, canViewCard, getVisibleMessage, listVisibleMessages, ownerViewer, visibleAlerts,
  type ViewerContext,
} from '../../Services/A2A/visibility.js';
import { getMessageById, loadCard, markAcked } from '../../Services/A2A/a2aStore.js';
import { drainGovernanceInbox, listGovernanceInbox } from '../../Services/A2A/governanceQueue.js';
import { disposeAlert, type AlertDisposition } from '../../Services/A2A/alertDisposition.js';

type Headers = Record<string, unknown> | undefined;

/** 解析观察者（含身份门）。返回 `{ error }` 表示应直接回 401/403。 */
async function resolveViewer(
  headers: Headers,
  viewerAgentId?: string,
): Promise<{ viewer: ViewerContext } | { error: ReturnType<typeof apiError> }> {
  const activeOwner = getActiveOwner();
  const token = extractBearerToken(headers);
  let ownerUserId = activeOwner;
  if (token) {
    const verified = await resolveServerIdentity(token);
    if (!verified.ok) return { error: apiError(`身份验真失败：${verified.error}`, 403) };
    ownerUserId = verified.value.userId;
    if (ownerUserId !== activeOwner) {
      return { error: apiError('令牌属主与当前活动账号不一致（跨账号访问被拒）', 403) };
    }
  }
  if (viewerAgentId) {
    const viewer = agentViewer(viewerAgentId, ownerUserId);
    if (!viewer) return { error: apiError(`Agent ${viewerAgentId} 未在本机注册，无法以其视角查询`, 404) };
    return { viewer };
  }
  return { viewer: ownerViewer(ownerUserId) };
}

/** 是否为治理观察者（L0 或所有者） */
function isGovernanceViewer(viewer: ViewerContext): boolean {
  return viewer.kind === 'owner' || viewer.tier === 'owner' || viewer.tier === 'L0';
}

export function registerA2ARoutes(): void {
  // ── 查询消息（按观察者过滤）────────────────────────────────────
  registerRoute('GET', '/api/a2a/messages', async (req) => {
    const resolved = await resolveViewer(req.headers as Headers, req.query['viewerAgentId']);
    if ('error' in resolved) return resolved.error;
    const filter: Parameters<typeof listVisibleMessages>[1] = {
      limit: clampLimit(req.query['limit']),
    };
    if (req.query['taskId']) filter.taskId = req.query['taskId']!;
    if (req.query['sourceAgentId']) filter.sourceAgentId = req.query['sourceAgentId']!;
    if (req.query['targetAgentId']) filter.targetAgentId = req.query['targetAgentId']!;
    if (req.query['verdict']) filter.verdict = req.query['verdict']!;
    const items = listVisibleMessages(resolved.viewer, filter);
    return json({
      items: items.map(v => ({
        messageId: v.message.envelope.messageId,
        kind: v.message.envelope.kind,
        taskId: v.message.envelope.taskId,
        sourceAgentId: v.message.envelope.sourceAgentId,
        targetAgentId: v.message.envelope.targetAgentId,
        visibility: v.message.envelope.visibility,
        verdict: v.message.verdict,
        contentHash: v.message.envelope.contentHash,
        prevHash: v.message.envelope.prevHash,
        memoryRefs: v.message.envelope.memoryRefs ?? [],
        summary: v.message.summary ?? v.message.envelope.summary,
        payload: v.message.envelope.payload,      // 跨域时**已是空对象**（后端摘除）
        redacted: v.redacted,
        ...(v.reason ? { redactedReason: v.reason } : {}),
        createdAt: v.message.createdAt,
      })),
      count: items.length,
      viewer: { kind: resolved.viewer.kind, tier: resolved.viewer.tier ?? 'owner', agentId: resolved.viewer.agentId ?? null },
    });
  });

  // ── 单条消息 ──────────────────────────────────────────────────
  registerRoute('GET', '/api/a2a/messages/:messageId', async (req) => {
    const messageId = req.params['messageId'];
    if (!messageId) return apiError('messageId is required');
    const resolved = await resolveViewer(req.headers as Headers, req.query['viewerAgentId']);
    if ('error' in resolved) return resolved.error;
    const visible = getVisibleMessage(messageId, resolved.viewer);
    if (!visible) return apiError('Message not found or not visible to viewer', 404);
    return json({ ...visible.message.envelope, verdict: visible.message.verdict, redacted: visible.redacted });
  });

  // ── 卡片 ─────────────────────────────────────────────────────
  registerRoute('GET', '/api/a2a/cards/:agentId', async (req) => {
    const agentId = req.params['agentId'];
    if (!agentId) return apiError('agentId is required');
    const resolved = await resolveViewer(req.headers as Headers, req.query['viewerAgentId']);
    if ('error' in resolved) return resolved.error;
    if (!canViewCard(resolved.viewer, agentId)) return apiError('无权查看该 Agent 卡片', 403);
    const card = loadCard(agentId);
    if (!card) return apiError('Card not found', 404);
    return json(card);
  });

  // ── 告警（L1 仅计数）──────────────────────────────────────────
  registerRoute('GET', '/api/a2a/alerts', async (req) => {
    const resolved = await resolveViewer(req.headers as Headers, req.query['viewerAgentId']);
    if ('error' in resolved) return resolved.error;
    const filter: Parameters<typeof visibleAlerts>[1] = { limit: clampLimit(req.query['limit']) };
    if (req.query['ruleId']) filter.ruleId = req.query['ruleId']!;
    if (req.query['disposition']) filter.disposition = req.query['disposition']!;
    const result = visibleAlerts(resolved.viewer, filter);
    return json(result);
  });

  // ── 治理队列 ─────────────────────────────────────────────────
  registerRoute('GET', '/api/a2a/inbox', async (req) => {
    const resolved = await resolveViewer(req.headers as Headers, req.query['viewerAgentId']);
    if ('error' in resolved) return resolved.error;
    if (!isGovernanceViewer(resolved.viewer)) return apiError('治理队列仅 L0/所有者可读', 403);
    const items = listGovernanceInbox({ limit: clampLimit(req.query['limit']) });
    return json({
      items: items.map(i => ({
        messageId: i.message.envelope.messageId, taskId: i.message.envelope.taskId,
        requiredRole: i.requiredRole, payload: i.message.envelope.payload, createdAt: i.message.createdAt,
      })),
      count: items.length,
    });
  });

  registerRoute('POST', '/api/a2a/inbox/drain', async (req) => {
    const resolved = await resolveViewer(req.headers as Headers, req.query['viewerAgentId']);
    if ('error' in resolved) return resolved.error;
    if (!isGovernanceViewer(resolved.viewer)) return apiError('取出升级需 L0/所有者', 403);
    const max = typeof req.body['max'] === 'number' ? Number(req.body['max']) : 20;
    return json(drainGovernanceInbox({ max }));
  });

  // ── 确认收到 ──────────────────────────────────────────────────
  registerRoute('POST', '/api/a2a/ack', async (req) => {
    const messageId = typeof req.body['messageId'] === 'string' ? req.body['messageId'] : '';
    if (!messageId) return apiError('messageId is required');
    const resolved = await resolveViewer(req.headers as Headers, req.query['viewerAgentId']);
    if ('error' in resolved) return resolved.error;
    const msg = getMessageById(messageId);
    if (!msg) return apiError('Message not found', 404);
    // 只有**接收方本人**（或以 L0/所有者身份）可确认
    if (!isGovernanceViewer(resolved.viewer) && resolved.viewer.agentId !== msg.envelope.targetAgentId) {
      return apiError('只有接收方可确认该消息', 403);
    }
    if (!msg.envelope.requiresAck) return apiError('该消息不要求确认', 409);
    markAcked(messageId);
    return json({ messageId, acked: true });
  });

  // ── 申请查看被摘除正文（P0：仅 L0/所有者；其他人走审批门 P1）────
  registerRoute('POST', '/api/a2a/reveal', async (req) => {
    const messageId = typeof req.body['messageId'] === 'string' ? req.body['messageId'] : '';
    if (!messageId) return apiError('messageId is required');
    const resolved = await resolveViewer(req.headers as Headers, req.query['viewerAgentId']);
    if ('error' in resolved) return resolved.error;
    if (!isGovernanceViewer(resolved.viewer)) {
      return apiError('查看被摘除正文需 L0/所有者；其余角色须走审批门（P1 实装）', 403);
    }
    const msg = getMessageById(messageId);
    if (!msg) return apiError('Message not found', 404);
    return json({ messageId, payload: msg.envelope.payload, revealedBy: resolved.viewer.tier ?? 'owner' });
  });

  // ── 处置告警（角色匹配由 disposeAlert 强制）────────────────────
  registerRoute('POST', '/api/a2a/alerts/:alertId/dispose', async (req) => {
    const alertId = req.params['alertId'];
    if (!alertId) return apiError('alertId is required');
    const resolved = await resolveViewer(req.headers as Headers, req.query['viewerAgentId']);
    if ('error' in resolved) return resolved.error;
    if (!isGovernanceViewer(resolved.viewer)) return apiError('告警处置需 L0/所有者', 403);
    const disposition = String(req.body['disposition'] ?? '') as AlertDisposition;
    if (!disposition) return apiError('disposition is required');
    // 观察者角色即处置角色（治理动作门会再校验一次，不采信自报层级）
    const actorRole = resolved.viewer.kind === 'owner'
      ? 'user'
      : toCanonicalRole(resolved.viewer.role ?? '');
    const reason = typeof req.body['reason'] === 'string' ? req.body['reason'] : undefined;
    const cooldownMs = typeof req.body['cooldownMs'] === 'number' ? Number(req.body['cooldownMs']) : undefined;
    const result = disposeAlert({
      alertId, disposition, actorRole,
      ...(reason !== undefined ? { reason } : {}),
      ...(cooldownMs !== undefined ? { cooldownMs } : {}),
    });
    if (!result.ok) return apiError(String(result.error), 409);
    return json(result.value);
  });
}

function clampLimit(raw: string | undefined): number {
  const n = raw ? Number(raw) : 200;
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(Math.floor(n), 2000);
}
