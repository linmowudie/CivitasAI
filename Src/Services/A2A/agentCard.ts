/**
 * @module Services/A2A/agentCard
 * @description Agent Card **派生签发**（P0a）—— 设计 §2 + 自审修正 §18 #2/#3。
 *
 * 原则：
 *  1. **单一写入点**：卡片不由 agent 自改，而由注册表快照**派生**（本模块是纯函数，无副作用）；
 *  2. **能力从注册表派生**：`ability.tools` / `dangerCeiling` 均取自 `getVisibleToolsForRole`（不靠人填）；
 *  3. **指纹只覆盖"签发内容"**（角色/父子/能力/权限/有效期），**不含**运行态（`status/health`）——
 *     这样运行态可由事件驱动同步而**无需重签**；能力/权限变更则必须**新版本重签**。
 */

import { createHash } from 'node:crypto';
import { tierOfRole, toApprovalRole } from '../../Infra/Roles/roleVocabulary.js';
import { getVisibleToolsForRole } from '../../Tools/Factory/toolFactory.js';
import { getActiveOwner } from '../../Infra/AccountScope/activeAccount.js';
import type { AgentInstance, AgentRole } from '../../Core/AgentRuntime/types.js';
import type { DangerLevel } from '../../Infra/Security/trustLevels.js';
import type {
  A2AKind, AgentAbility, AgentCard, AgentPermission, AgentTier, FatherRef,
} from './types.js';

/** 卡片默认有效期（24h；过期即须重签，防权限陈旧） */
export const DEFAULT_CARD_TTL_MS = 24 * 60 * 60 * 1000;

/** 危险级偏序（用于取"可见工具的最大危险级"） */
const DANGER_ORDER: readonly DangerLevel[] = ['SAFE', 'CONTROLLED', 'DANGEROUS', 'FORBIDDEN'];

/** 不可通信的状态（fail-closed 白名单之外） */
const COMMUNICATION_BLOCKED_STATUS: readonly string[] = ['destroyed', 'suspended', 'failed'];

/** 各 tier 的 A2A 默认策略 */
const A2A_DEFAULTS_BY_TIER: Record<AgentTier, AgentPermission['a2a']> = {
  owner: { canInitiate: true, maxPeers: 8, maxMessagesPerHour: 120, allowedKinds: [] },
  L0: {
    canInitiate: true, maxPeers: 5, maxMessagesPerHour: 60,
    allowedKinds: ['handoff', 'query', 'answer', 'propose', 'accept', 'reject', 'notify', 'escalate', 'retract'],
  },
  L1: {
    canInitiate: true, maxPeers: 5, maxMessagesPerHour: 60,
    allowedKinds: ['handoff', 'query', 'answer', 'propose', 'accept', 'reject', 'notify', 'escalate', 'retract'],
  },
  // L2 不允许 `propose`（§18 #10：同级横向协商须经 L1 域内，且 L2 只应答）
  L2: {
    canInitiate: true, maxPeers: 3, maxMessagesPerHour: 30,
    allowedKinds: ['handoff', 'query', 'answer', 'accept', 'reject', 'notify', 'escalate', 'retract'],
  },
};

export interface DeriveCardOptions {
  father?: FatherRef | null;
  lineage?: string[];
  cardVersion?: number;
  /** 技能标签（来自 Skills 资产；P0a 允许为空，后续由资产装载补齐） */
  skills?: string[];
  /** 可用模型；默认取 `agent.model` */
  models?: string[];
  languages?: string[];
  maxParallel?: number;
  /** 数据域；默认按 tier 与 `lastTaskId` 推导 */
  dataScopes?: string[];
  a2a?: Partial<AgentPermission['a2a']>;
  ttlMs?: number;
  issuedBy?: string;
  now?: number;
  ownerUserId?: string;
}

/** 由注册表可见工具推导危险级上限（取最大值） */
function deriveDangerCeiling(role: AgentRole): DangerLevel {
  const tools = getVisibleToolsForRole(role);
  let maxIdx = 0;
  for (const t of tools) {
    const lvl = (t as { dangerLevel?: DangerLevel }).dangerLevel;
    const idx = lvl ? DANGER_ORDER.indexOf(lvl) : -1;
    if (idx > maxIdx) maxIdx = idx;
  }
  return DANGER_ORDER[maxIdx] ?? 'SAFE';
}

/** 推导 `ability`（工具来自注册表，口径与执行期硬校验一致） */
export function deriveAbility(agent: AgentInstance, opts: DeriveCardOptions = {}): AgentAbility {
  return {
    skills: [...(opts.skills ?? [])].sort(),
    tools: getVisibleToolsForRole(agent.role).map(t => t.name).sort(),
    models: [...(opts.models ?? [agent.model])].filter(Boolean).sort(),
    languages: [...(opts.languages ?? ['zh-CN'])].sort(),
    maxParallel: Math.max(1, opts.maxParallel ?? 1),
  };
}

/** 推导 `permission`（分层 → 权限；治理键仅 L0） */
export function derivePermission(
  agent: AgentInstance, tier: AgentTier, opts: DeriveCardOptions = {},
): AgentPermission {
  const a2aDefaults = A2A_DEFAULTS_BY_TIER[tier];
  const dataScopes = opts.dataScopes ?? [
    ...(tier === 'L0' ? ['*'] : ['memory:shared']),
    ...(agent.lastTaskId ? [`task:${agent.lastTaskId}`] : []),
  ];
  return {
    tier,
    dataScopes: [...dataScopes].sort(),
    canDelegate: tier === 'L1',
    // L0 可审批**本角色**对应槽位；人类所有者经 REST 身份门审批，不占卡片额度
    canApprove: tier === 'L0' ? [toApprovalRole(agent.role)] : [],
    canWriteSharedMemory: true,               // 记忆治理：共享键所有层级可写
    canWriteGovernanceKeys: tier === 'L0',    // 治理键仅 L0（G-13）
    canBroadcast: tier === 'L0',
    dangerCeiling: deriveDangerCeiling(agent.role),
    a2a: { ...a2aDefaults, ...(opts.a2a ?? {}) },
  };
}

/** 规范化 JSON（键排序、递归稳定）→ 用于指纹 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/**
 * 指纹载荷：**只含签发内容**（角色/父子/能力/权限/有效期/签发者）。
 * 运行态 `status/health/updateTime` 被刻意排除 → 运行态同步无需重签。
 */
function fingerprintPayload(card: AgentCard): string {
  return canonicalize({
    agentId: card.agentId,
    cardVersion: card.cardVersion,
    role: card.role,
    createTime: card.createTime,
    father: card.father,
    lineage: card.lineage,
    ability: card.ability,
    permission: card.permission,
    issuedBy: card.issuedBy,
    expiresAt: card.expiresAt,
    ownerUserId: card.ownerUserId,
  });
}

/** 计算指纹（sha256） */
export function computeCardFingerprint(card: AgentCard): string {
  return createHash('sha256').update(fingerprintPayload(card)).digest('hex');
}

/** 校验指纹（防篡改） */
export function verifyCardFingerprint(card: AgentCard): boolean {
  return computeCardFingerprint(card) === card.fingerprint;
}

/**
 * 签发**语义**内容（角色/父子/能力/权限；**不含**时间与有效期）。
 * 用途：判断"重签是否真的改了东西" —— 未变则保持同版本（幂等重签），
 * 变了则自动升版本（遵守 §18 #21「能力/权限变更即新版本」）。
 */
export function cardSemanticSignature(card: Pick<AgentCard, 'role' | 'father' | 'lineage' | 'ability' | 'permission'>): string {
  return canonicalize({
    role: card.role, father: card.father, lineage: card.lineage,
    ability: card.ability, permission: card.permission,
  });
}

/**
 * 派生签发卡片。
 * @param agent 注册表快照（**唯一事实源**）
 * @param opts 可选覆盖（父子链、技能、配额等）
 */
export function deriveAgentCard(agent: AgentInstance, opts: DeriveCardOptions = {}): AgentCard {
  const now = opts.now ?? Date.now();
  const tier: AgentTier = (tierOfRole(agent.role) as AgentTier | undefined) ?? 'L2'; // 未知角色按最低层 fail-safe
  const cardVersion = opts.cardVersion ?? 1;
  const draft: AgentCard = {
    cardId: `card-${agent.agentId}-v${cardVersion}`,
    agentId: agent.agentId,
    cardVersion,
    role: agent.role,
    createTime: agent.createdAt ?? now,
    updateTime: now,
    father: opts.father ?? null,
    lineage: [...(opts.lineage ?? [])],
    status: agent.status,
    health: { consecutiveFailures: agent.consecutiveFailures ?? 0, lastActiveAt: agent.updatedAt ?? now },
    ability: deriveAbility(agent, opts),
    permission: derivePermission(agent, tier, opts),
    fingerprint: '',
    issuedBy: opts.issuedBy ?? 'governance:broker',
    expiresAt: now + (opts.ttlMs ?? DEFAULT_CARD_TTL_MS),
    ownerUserId: opts.ownerUserId ?? getActiveOwner(),
  };
  return { ...draft, fingerprint: computeCardFingerprint(draft) };
}

/**
 * 运行态同步（§18 #2）：`status/health/updateTime` 由注册表事件驱动更新，
 * **不改指纹、不升版本**（因为指纹只覆盖签发内容）。
 */
export function syncRuntimeState(card: AgentCard, agent: AgentInstance, now = Date.now()): AgentCard {
  return {
    ...card,
    status: agent.status,
    health: { consecutiveFailures: agent.consecutiveFailures ?? 0, lastActiveAt: agent.updatedAt ?? now },
    updateTime: now,
  };
}

/**
 * 重签（能力/权限/有效期变更时必须新版本）——旧版本保留可审计。
 */
export function reissueCard(
  card: AgentCard, agent: AgentInstance, changes: Partial<DeriveCardOptions> = {}, now = Date.now(),
): AgentCard {
  return deriveAgentCard(agent, {
    father: card.father,
    lineage: card.lineage,
    cardVersion: card.cardVersion + 1,
    skills: card.ability.skills,
    models: card.ability.models,
    languages: card.ability.languages,
    maxParallel: card.ability.maxParallel,
    dataScopes: card.permission.dataScopes,
    a2a: card.permission.a2a,
    issuedBy: card.issuedBy,
    ownerUserId: card.ownerUserId,
    ...changes,
    now,
  });
}

/** 卡片可用性（通信前置校验的第一步） */
export function isCardUsable(card: AgentCard, now = Date.now()): { usable: boolean; reason?: string } {
  if (!verifyCardFingerprint(card)) return { usable: false, reason: 'fingerprint_mismatch' };
  if (now >= card.expiresAt) return { usable: false, reason: 'expired' };
  if (COMMUNICATION_BLOCKED_STATUS.includes(card.status)) return { usable: false, reason: `status_${card.status}` };
  if (!card.permission.a2a.canInitiate) return { usable: false, reason: 'a2a_not_permitted' };
  return { usable: true };
}

/** 某 kind 是否被该卡片允许（越级/种类校验的输入之一） */
export function isKindAllowed(card: AgentCard, kind: A2AKind): boolean {
  return card.permission.a2a.allowedKinds.includes(kind);
}
