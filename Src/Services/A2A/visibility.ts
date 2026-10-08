/**
 * @module Services/A2A/visibility
 * @description A2A **可见性过滤层**（P0a 后端内核）—— 设计 §5.2 矩阵 + §14.5 D1/D3/D4/D5。
 *
 * 铁律：**过滤在后端完成，前端只渲染拿到的字段**（D1）。
 * 因此跨域消息在这里就被**摘掉正文**（不是靠前端隐藏）——`payload` 置空、仅保留 `summary`。
 *
 * 矩阵（与设计逐字一致）：
 * | 观察者 | 自身/域内 | 跨域 | 告警证据 |
 * |--------|----------|------|---------|
 * | L0 / 所有者 | 全部正文 | 全部正文 | ✅ 全见 |
 * | L1 | 自身域（自身 + 下游）正文 | **仅摘要**（无正文） | 仅计数 |
 * | L2 | 自身 + **直达父** | 不可见（不返回） | 不可见 |
 * | 未知/缺失 | fail-closed：不返回任何消息 | — | — |
 */

import { getAllAgents, getAgent, getAgentParent } from '../../Core/AgentRuntime/agentRegistry.js';
import { tierOfRole } from '../../Infra/Roles/roleVocabulary.js';
import { listAlerts, listMessages, type StoredMessage } from './a2aStore.js';
import type { AgentTier, CollusionAlert } from './types.js';

/** 观察者上下文（**必须显式构造**，缺失即 fail-closed） */
export interface ViewerContext {
  kind: 'owner' | 'agent';
  ownerUserId: string;
  /** `kind==='agent'` 时必填 */
  agentId?: string;
  tier?: AgentTier;
  role?: string;
}

/** 所有者视角（可见全部） */
export function ownerViewer(ownerUserId: string): ViewerContext {
  return { kind: 'owner', ownerUserId, tier: 'owner' };
}

/** agent 视角（层级由注册表角色推导；治理角色 = L0） */
export function agentViewer(agentId: string, ownerUserId: string): ViewerContext | null {
  const agent = getAgent(agentId);
  if (!agent) return null;
  const tier = (tierOfRole(agent.role) as AgentTier | undefined) ?? 'L2';
  return { kind: 'agent', ownerUserId, agentId, tier, role: agent.role };
}

/** 后代的 agentId 集合（含自身）——用于 L1 的"自身域" */
export function domainAgentIds(rootAgentId: string): Set<string> {
  const domain = new Set<string>([rootAgentId]);
  const all = getAllAgents();
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of all) {
      if (domain.has(a.agentId)) continue;
      const parentId = a.father?.agentId ?? getAgentParent(a.agentId);
      if (parentId && domain.has(parentId)) { domain.add(a.agentId); changed = true; }
    }
  }
  return domain;
}

export interface VisibleMessage {
  message: StoredMessage;
  /** 正文被摘除（跨域 / 隔离态） */
  redacted: boolean;
  /** 摘除原因（可观测） */
  reason?: string;
}

function withoutPayload(message: StoredMessage, reason: string): VisibleMessage {
  const summary = message.summary ?? message.envelope.summary;
  return {
    redacted: true,
    reason,
    message: {
      ...message,
      envelope: {
        ...message.envelope,
        payload: {},                                                   // ★ 正文在**后端**就不返回
        ...(summary !== undefined ? { summary } : {}),
      },
    },
  };
}

/** 单条消息对该观察者是否可见、是否需摘除正文 */
function classify(message: StoredMessage, viewer: ViewerContext): 'full' | 'summary' | 'hidden' {
  if (viewer.kind === 'owner' || viewer.tier === 'owner') return 'full';
  if (viewer.tier === 'L0') return 'full';
  if (!viewer.agentId) return 'hidden';                                // agent 视角必须有 agentId

  const self = viewer.agentId;
  const from = message.envelope.sourceAgentId;
  const to = message.envelope.targetAgentId;

  if (viewer.tier === 'L2') {
    // 设计：仅自身与**直达父**
    const fatherId = getAgent(self)?.father?.agentId ?? getAgentParent(self);
    const inScope = from === self || to === self
      || (fatherId !== undefined && (from === fatherId || to === fatherId));
    return inScope ? 'full' : 'hidden';
  }

  // L1：自身域（自身 + 下游）正文；跨域仅摘要
  // ⚠️ 必须**两端都在域内**才算域内 —— 只看单端会把"域内成员发给域外"的消息
  //    误判为域内正文（实现期测试暴露的缺陷，见设计 §18 #32）。
  const domain = domainAgentIds(self);
  if (domain.has(from) && domain.has(to)) return 'full';
  return 'summary';
}

/** 过滤消息列表（后端唯一出口；调用方不得绕过） */
export function filterMessagesForViewer(messages: StoredMessage[], viewer: ViewerContext): VisibleMessage[] {
  const out: VisibleMessage[] = [];
  for (const m of messages) {
    const kind = classify(m, viewer);
    if (kind === 'hidden') continue;
    if (kind === 'summary') { out.push(withoutPayload(m, 'cross_domain_summary_only')); continue; }
    // 隔离/阻断态：非 L0 一律不返回正文（§14.5 D4/D5）
    if (m.verdict !== 'allow' && viewer.tier !== 'L0' && viewer.kind !== 'owner') {
      out.push(withoutPayload(m, `verdict_${m.verdict}`));
      continue;
    }
    out.push({ message: m, redacted: false });
  }
  return out;
}

/** 查询入口：按观察者过滤的消息列表 */
export function listVisibleMessages(
  viewer: ViewerContext,
  filter: { taskId?: string; sourceAgentId?: string; targetAgentId?: string; verdict?: string; limit?: number } = {},
): VisibleMessage[] {
  return filterMessagesForViewer(listMessages(filter), viewer);
}

/** 单条查询（不可见返回 null） */
export function getVisibleMessage(messageId: string, viewer: ViewerContext): VisibleMessage | null {
  const all = listMessages({ limit: 2000 }).filter(m => m.envelope.messageId === messageId);
  return filterMessagesForViewer(all, viewer)[0] ?? null;
}

export interface VisibleAlerts {
  items: CollusionAlert[];
  count: number;
  /** 证据是否被摘除（L1 只见计数，D5） */
  evidenceRedacted: boolean;
}

/** 告警可见性：L0/所有者全见；L1 仅计数；L2 不可见 */
export function visibleAlerts(viewer: ViewerContext, filter: { ruleId?: string; disposition?: string; limit?: number } = {}): VisibleAlerts {
  if (viewer.kind === 'owner' || viewer.tier === 'owner' || viewer.tier === 'L0') {
    const items = listAlerts(filter);
    return { items, count: items.length, evidenceRedacted: false };
  }
  if (viewer.tier === 'L1') {
    const count = listAlerts({ ...filter, limit: 1000 }).length;
    return { items: [], count, evidenceRedacted: true };
  }
  return { items: [], count: 0, evidenceRedacted: true };
}

/** 卡片可见性：所有者/L0 全见；agent 仅见自己与直达父 */
export function canViewCard(viewer: ViewerContext, agentId: string): boolean {
  if (viewer.kind === 'owner' || viewer.tier === 'owner' || viewer.tier === 'L0') return true;
  const self = viewer.agentId;
  if (!self) return false;
  if (agentId === self) return true;
  const fatherId = getAgent(self)?.father?.agentId ?? getAgentParent(self);
  return Boolean(fatherId) && agentId === fatherId;
}
