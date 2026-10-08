/**
 * @module Services/A2A/governanceQueue
 * @description **治理队列**：`escalate` 的落点与 L0 **按需唤醒**（P0a 后端内核）—— 设计 §18 #4 + G-19。
 *
 * 为什么不是"投递给某个 L0 Agent"：L0 是**按需创建/扩容**的（G-19），不常驻。
 * 因此 `escalate` 投递到队列，由治理层在**需要处置时**才唤醒/创建对应治理角色。
 */

import { ensureAgentForRole } from '../Governance/governanceProvisioning.js';
import { listMessages, markDelivered, type StoredMessage } from './a2aStore.js';

/** 治理队列标识（与 broker 保持一致；本地常量避免循环依赖） */
export const GOVERNANCE_INBOX = 'governance:inbox';

/** 可承接升级的治理角色（执行域称呼） */
const GOVERNANCE_ROLES = ['auditor', 'regulator', 'arbitrator'] as const;
type GovernanceRole = (typeof GOVERNANCE_ROLES)[number];

export interface InboxItem {
  message: StoredMessage;
  /** 建议承接的治理角色 */
  requiredRole: GovernanceRole;
}

function requiredRoleFor(message: StoredMessage): GovernanceRole {
  const payload = message.envelope.payload as Record<string, unknown>;
  const declared = typeof payload['requiredRole'] === 'string' ? String(payload['requiredRole']) : '';
  const normalized = declared === 'regulatory_authority' ? 'regulator' : declared;
  if ((GOVERNANCE_ROLES as readonly string[]).includes(normalized)) return normalized as GovernanceRole;
  // 默认交**审计局**：升级多与"副作用/行为异常"相关
  return 'auditor';
}

/** 待处置的升级（未投递 + 已放行） */
export function listGovernanceInbox(options: { limit?: number } = {}): InboxItem[] {
  const rows = listMessages({ targetAgentId: GOVERNANCE_INBOX, limit: options.limit ?? 200 });
  return rows
    .filter(m => m.verdict === 'allow' && m.envelope.kind === 'escalate' && !m.deliveredAt)
    .map(m => ({ message: m, requiredRole: requiredRoleFor(m) }));
}

/** 队列统计（按角色） */
export function governanceInboxStats(): { pending: number; byRole: Record<string, number> } {
  const items = listGovernanceInbox({ limit: 1000 });
  const byRole: Record<string, number> = {};
  for (const i of items) byRole[i.requiredRole] = (byRole[i.requiredRole] ?? 0) + 1;
  return { pending: items.length, byRole };
}

export interface DrainResult {
  /** 本次取出的升级 */
  drained: Array<{ messageId: string; taskId: string; requiredRole: GovernanceRole; assignedAgentId: string | null }>;
  /** 因本次升级而被创建/唤醒的治理角色 */
  ensuredRoles: string[];
  /** 角色 → 承接 Agent（`null` = 未创建成功，交由治理层人工处理） */
  assignments: Record<string, string | null>;
}

/**
 * 取出并投递队列中的升级：**按需唤醒/创建 L0**（G-19），随后标记消息已投递。
 * 幂等：已投递的消息不再返回。
 */
export function drainGovernanceInbox(options: { max?: number; ensureAgents?: boolean } = {}): DrainResult {
  const max = Math.max(1, options.max ?? 20);
  const ensure = options.ensureAgents ?? true;
  const items = listGovernanceInbox({ limit: max });
  const assignments: Record<string, string | null> = {};
  const ensuredRoles: string[] = [];
  const drained: DrainResult['drained'] = [];

  for (const item of items) {
    const role = item.requiredRole;
    if (!(role in assignments)) {
      if (ensure) {
        const r = ensureAgentForRole(role, { reason: 'A2A escalate 按需唤醒（G-19）' });
        assignments[role] = r.ok ? r.value.agentId : null;
        if (r.ok) ensuredRoles.push(role);
      } else {
        assignments[role] = null;
      }
    }
    markDelivered(item.message.envelope.messageId);
    drained.push({
      messageId: item.message.envelope.messageId,
      taskId: item.message.envelope.taskId,
      requiredRole: role,
      assignedAgentId: assignments[role] ?? null,
    });
  }

  return { drained, ensuredRoles, assignments };
}
