/**
 * @module Services/A2A/a2aBroker
 * @description A2A Broker —— **唯一通信通道**（P0a）· 设计 §5.1 八步校验链 + §18 #11（Broker 身份）。
 *
 * 铁律（§18 #11）：
 *  - Broker 以 `actorRole:'system'` 运行，**只做校验/记录/投递**；
 *  - 任何"通过"**不得**代替 L0 授权；**禁止**触发"系统可自动通过"的例外（该例外仅用于自动**拒绝**）；
 *  - 每次判定（放行/阻断/隔离/改道）都落库并可审计。
 */

import { createHash, createHmac } from 'node:crypto';
import { getMainDb } from '../../Infra/Db/database.js';
import { getActiveOwner } from '../../Infra/AccountScope/activeAccount.js';
import { publish, createEvent } from '../EventBus/eventBus.js';
import { EventType } from '../EventBus/eventTypes.js';
import { logger } from '../../Infra/Logging/logger.js';
import {
  cardSemanticSignature, deriveAgentCard, isCardUsable, isKindAllowed, type DeriveCardOptions,
} from './agentCard.js';
import {
  countMessages, getCooldown, getLastContentHash, listMessages, persistAlert, persistCard, persistMessage, loadCard,
  persistHandoff, type StoredMessage,
} from './a2aStore.js';
import {
  DEFAULT_THRESHOLDS, detectA2AAsMemory, detectAuditEvasion, detectCovertChannel, detectDuplicateSource,
  detectFrequencyAnomaly, detectPrivilegeProxy, detectReciprocity, detectTaskDrift,
  makeAlertId, strongestFinding, type CollusionFinding, type CollusionThresholds,
} from './collusion.js';
import type { DangerLevel } from '../../Infra/Security/trustLevels.js';
import { augmentBundleWithSystemFacts, crossCheckSelfLimits } from './handoff.js';
import type { AgentInstance } from '../../Core/AgentRuntime/types.js';
import type {
  A2AEnvelope, A2AKind, AgentCard, AgentTier, BrokerDecision, BrokerStep, CollusionAlert,
  HandoffBundle, HandoffSystemFacts,
} from './types.js';

/** 治理队列标识（`escalate` 的投递目标；非 agent —— §18 #4） */
export const GOVERNANCE_INBOX = 'governance:inbox';

/** Broker 签名密钥（本机治理凭证；服务端不验签 —— Q6） */
const BROKER_SECRET = process.env['CIVITAS_A2A_SECRET'] ?? 'civitas-a2a-local-broker-secret';

/** 配额窗口（1 小时） */
const QUOTA_WINDOW_MS = 60 * 60 * 1000;

/** C1 统计窗口（1 小时） */
const RECIPROCITY_WINDOW_MS = 60 * 60 * 1000;

// ── 工具函数 ────────────────────────────────────────────────────────

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function hashContent(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

/** Broker 签名（覆盖信封关键字段；agent 无法伪造） */
export function signEnvelope(e: Omit<A2AEnvelope, 'signature'>): string {
  return createHmac('sha256', BROKER_SECRET).update(canonicalize({
    messageId: e.messageId, kind: e.kind, taskId: e.taskId, sourceAgentId: e.sourceAgentId,
    targetAgentId: e.targetAgentId, contentHash: e.contentHash, prevHash: e.prevHash,
    visibility: e.visibility, policyContext: e.policyContext, memoryRefs: e.memoryRefs ?? [],
    summary: e.summary ?? null, retractsMessageId: e.retractsMessageId ?? null,
  })).digest('hex');
}

/** 校验签名 + **载荷完整性**（篡改 payload 而不更新 contentHash 必须被发现） */
export function verifySignature(e: A2AEnvelope): boolean {
  if (e.contentHash !== hashContent(e.payload)) return false;
  const { signature, ...rest } = e;
  return signEnvelope(rest) === signature;
}

/** 数据域匹配（支持 `*` 通配与前缀） */
function scopeMatches(scope: string, ref: string): boolean {
  if (scope === '*') return true;
  if (scope.endsWith('*')) return ref.startsWith(scope.slice(0, -1));
  return scope === ref;
}

function block(step: BrokerStep, verdict: BrokerDecision['verdict'], reason: string, extra: Partial<BrokerDecision> = {}): BrokerDecision {
  return { verdict, step, reasons: [reason], ...extra };
}

// ── ① 卡片签发（治理层动作）──────────────────────────────────────────

/**
 * 由注册表快照派生签发卡片（§18 #2：注册表为唯一写入点）。
 *
 * 两条**身份连续性**规则（实现中发现的缺陷修正）：
 *  1. 未显式给 `father/lineage` 时**继承上一版卡片** —— 避免重签把 agent 变成"无父 L2"（将无法向上通信）；
 *  2. 未显式给 `cardVersion` 时：签发语义内容**未变 → 保持同版本**（幂等重签），
 *     **已变 → 自动升版本**（遵守"能力/权限变更即新版本"）。
 */
export function issueCardForAgent(agent: AgentInstance, opts: DeriveCardOptions = {}): AgentCard {
  const previous = loadCard(agent.agentId);
  const inherited: DeriveCardOptions = {
    father: opts.father ?? previous?.father ?? null,
    lineage: opts.lineage ?? previous?.lineage ?? [],
  };
  let card = deriveAgentCard(agent, { ...inherited, ...opts });
  if (previous && opts.cardVersion === undefined) {
    const changed = cardSemanticSignature(previous) !== cardSemanticSignature(card);
    if (changed) card = deriveAgentCard(agent, { ...inherited, ...opts, cardVersion: previous.cardVersion + 1 });
    else card = deriveAgentCard(agent, { ...inherited, ...opts, cardVersion: previous.cardVersion });
  }
  persistCard(card);
  publish(createEvent({
    eventType: EventType.A2A_CARD_ISSUED,
    source: 'a2a-broker',
    traceId: agent.traceId,
    payload: { cardId: card.cardId, agentId: card.agentId, cardVersion: card.cardVersion, role: card.role, fingerprint: card.fingerprint, tier: card.permission.tier },
  }));
  return card;
}

// ── ② 发送（八步校验链）─────────────────────────────────────────────

export interface SendA2AInput {
  sourceAgentId: string;
  targetAgentId: string;
  kind: A2AKind;
  taskId: string;
  traceId?: string;
  payload: Record<string, unknown>;
  priority?: A2AEnvelope['priority'];
  requiresAck?: boolean;
  visibility?: A2AEnvelope['visibility'];
  memoryRefs?: Array<{ key: string; version: number }>;
  summary?: string;
  /** 广播型/多收件人（C7-A 输入） */
  recipientCount?: number;
  /** 任务目标（C2 输入） */
  taskGoal?: string;
  crossTaskReference?: boolean;
  parentMessageId?: string;
  correlationId?: string;
  capabilityRequired?: string[];
  /** 引用的数据域（step ⑤ 输入，如 `task:t1`、`file:src/x.ts`） */
  dataRefs?: string[];
  /** 是否含不可逆动作（step ⑥：必须携带 approvalId） */
  requiresApproval?: boolean;
  approvalId?: string;
  /** C3 补充信号：文本描述的是发送方自身动作 */
  targetsSelfAction?: boolean;
  /** C4：任务工作区前缀（用于判定"写非任务路径"旁路） */
  taskWorkspacePrefix?: string;
  /** C4：载荷熵（bits/char） */
  payloadEntropy?: number;
  /** C4：内容是否结构化（JSON/代码）—— 高熵需与"非结构化"组合才告警 */
  structuredContent?: boolean;
  /** C5：任务规模上限（消息数 > 迭代数 × k） */
  expectedMaxMessages?: number;
  /** C6：动作危险级（与执行者上限比较） */
  actionDangerLevel?: DangerLevel;
  /** C6：执行者 / 受益人（不同才构成代偿） */
  executorAgentId?: string;
  beneficiaryAgentId?: string;
  /** C6：动作所需数据域 */
  requiredScopes?: string[];
  now?: number;
}

export interface SendA2AResult {
  decision: BrokerDecision;
  messageId: string;
  envelope?: A2AEnvelope;
  /** 命中的反串通判据（若有） */
  finding?: CollusionFinding;
}

export interface SendA2ADeps {
  /** C8 需要读取记忆条目正文（注入以避免耦合 GlobalWorkspace 查询形状） */
  lookupMemory?: (key: string) => string | undefined;
  thresholds?: CollusionThresholds;
  /** §18 #6：系统事实采集器（默认由 `handoff.collectSystemFacts` 提供；注入便于测试与扩展） */
  collectSystemFacts?: (params: { loopId?: string }) => HandoffSystemFacts;
}

/** 主入口：发送一条 A2A 消息（**所有通信必须经此**） */
export function sendA2A(input: SendA2AInput, deps: SendA2ADeps = {}): SendA2AResult {
  const now = input.now ?? Date.now();
  const thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;
  /** 统一出口：**任何**判定（含阻断/隔离/改道）都落库留痕（设计 §5.1） */
  const finish = (d: BrokerDecision, extra: { envelope?: A2AEnvelope; finding?: CollusionFinding } = {}) =>
    finalize(d, { messageId, input, now, tier: loadCard(input.sourceAgentId)?.permission.tier, ...extra });
  const messageId = `a2a-${now}-${Math.random().toString(36).slice(2, 10)}`;
  const trail: Array<CollusionFinding | null> = [];

  // ── ① 卡片有效性与可用性（双向；治理队列例外）───────────────
  const sourceCard = loadCard(input.sourceAgentId);
  if (!sourceCard) {
    return finish(block(1, 'block', 'source_card_missing'));
  }
  const sourceUsable = isCardUsable(sourceCard, now);
  if (!sourceUsable.usable) {
    return finish(block(1, 'block', `source_card_unusable:${sourceUsable.reason}`));
  }
  const isQueueTarget = input.targetAgentId === GOVERNANCE_INBOX;
  const targetCard = isQueueTarget ? null : loadCard(input.targetAgentId);
  if (!isQueueTarget) {
    if (!targetCard) return finish(block(1, 'block', 'target_card_missing'));
    const targetUsable = isCardUsable(targetCard, now);
    if (!targetUsable.usable) {
      return finish(block(1, 'block', `target_card_unusable:${targetUsable.reason}`));
    }
  }

  // ── ② 越级规则（§4）─────────────────────────────────────────
  const fromTier = sourceCard.permission.tier;
  const toTier: AgentTier = targetCard ? targetCard.permission.tier : 'L0';   // 治理队列视为 L0 面
  const leap = checkLeapRule(input, sourceCard, targetCard, fromTier, toTier);
  if (leap) return finish(leap);

  // ── ③ 权限点 + 配额 ─────────────────────────────────────────
  if (!isKindAllowed(sourceCard, input.kind)) {
    return finish(block(3, 'block', `kind_not_allowed:${input.kind}`));
  }
  // ③b 配对冷却（处置「cooled」的**执行效力**：冷却期内该对不得再通信）
  const cooled = getCooldown(input.sourceAgentId, input.targetAgentId, now);
  if (cooled) {
    return finish(block(3, 'block', 'pair_cooled_down', {
      reasons: [`pair_cooled_down:${cooled.reason ?? 'cooled'}（至 ${new Date(cooled.untilAt).toISOString()}）`],
    }));
  }
  const quotaUsed = countMessages(input.sourceAgentId, input.targetAgentId, QUOTA_WINDOW_MS, now);
  if (quotaUsed >= sourceCard.permission.a2a.maxMessagesPerHour) {
    return finish(block(3, 'block', 'quota_exceeded', { reasons: [`quota_exceeded:${quotaUsed}/${sourceCard.permission.a2a.maxMessagesPerHour}`] }));
  }

  // ── ④ 能力匹配 ─────────────────────────────────────────────
  if (targetCard && input.capabilityRequired?.length) {
    const have = new Set([...targetCard.ability.tools, ...targetCard.ability.skills]);
    const missing = input.capabilityRequired.filter(c => !have.has(c));
    if (missing.length > 0) return finish(block(4, 'block', `capability_missing:${missing.join(',')}`));
  }

  // ── ⑤ 数据域校验 ───────────────────────────────────────────
  if (input.dataRefs?.length) {
    const scopes = sourceCard.permission.dataScopes;
    const violated = input.dataRefs.filter(ref => !scopes.some(s => scopeMatches(s, ref)));
    if (violated.length > 0) return finish(block(5, 'block', `data_scope_violation:${violated.join(',')}`));
  }

  // ── ⑥ 敏感动作联动审批门 ───────────────────────────────────
  if (input.requiresApproval && !input.approvalId) {
    return finish(block(6, 'block', 'approval_required'));
  }

  // ── ⑦ 反串通判定（C1 / C2 / C7-A / C8）────────────────────
  const payloadText = Object.values(input.payload).map(v => (typeof v === 'string' ? v : canonicalize(v))).join(' ');
  const forward = countMessages(input.sourceAgentId, input.targetAgentId, RECIPROCITY_WINDOW_MS, now);
  const backward = countMessages(input.targetAgentId, input.sourceAgentId, RECIPROCITY_WINDOW_MS, now);
  const relationship: 'parent_child' | 'siblings' | 'cross_domain' =
    sourceCard.father?.agentId === input.targetAgentId || targetCard?.father?.agentId === input.sourceAgentId
      ? 'parent_child'
      : fromTier === toTier ? 'siblings' : 'cross_domain';

  trail.push(detectReciprocity({ fromAgentId: input.sourceAgentId, toAgentId: input.targetAgentId, forwardCount: forward, backwardCount: backward, relationship }, thresholds));
  trail.push(detectTaskDrift({ messageText: payloadText, taskGoal: input.taskGoal ?? '', crossTaskReference: input.crossTaskReference, taskId: input.taskId }, thresholds));
  trail.push(detectA2AAsMemory({
    kind: input.kind, recipientCount: input.recipientCount ?? 1, payloadText,
    memoryRefs: input.memoryRefs, taskId: input.taskId,
    suggestedMemoryKey: `task.${input.taskId}.facts`,
  }, thresholds));
  // C3 绕审意图（意图 + 审计对象双条件）
  trail.push(detectAuditEvasion({ text: payloadText, targetsSelfAction: input.targetsSelfAction }));
  // C4 隐蔽信道（文件旁路 / 记忆旁路 / 高熵+非结构化）
  trail.push(detectCovertChannel({
    filePaths: (input.dataRefs ?? []).filter(r => r.startsWith('file:')).map(r => r.slice(5)),
    taskWorkspacePrefix: input.taskWorkspacePrefix,
    memoryKeys: (input.memoryRefs ?? []).map(r => r.key),
    taskId: input.taskId,
    payloadEntropy: input.payloadEntropy,
    structuredContent: input.structuredContent,
  }));
  // C5 频率异常（任务规模或 σ）
  trail.push(detectFrequencyAnomaly({
    // C5 语义是「任务规模」：用**任务内消息总数**而非单对窗口计数
    currentCount: listMessages({ taskId: input.taskId, limit: 2000 }).length + 1,
    expectedMax: input.expectedMaxMessages,
  }));
  // C6 权限代偿（执行者权限交叉校验）
  if (input.executorAgentId) {
    const executorCard = loadCard(input.executorAgentId);
    trail.push(detectPrivilegeProxy({
      executorAgentId: input.executorAgentId,
      beneficiaryAgentId: input.beneficiaryAgentId,
      actionDangerLevel: input.actionDangerLevel,
      executorDangerCeiling: executorCard?.permission.dangerCeiling,
      requiredScopes: input.requiredScopes,
      executorScopes: executorCard?.permission.dataScopes,
    }));
  }
  if (deps.lookupMemory) {
    trail.push(detectDuplicateSource({ payloadText, memoryRefs: input.memoryRefs, lookupMemory: deps.lookupMemory }, thresholds));
  }
  const finding = strongestFinding(trail);
  if (finding && finding.action === 'block') {
    raiseAlert(finding, input, now);
    return finish(block(7, 'block', `collusion:${finding.ruleId}`, { rules: [finding.ruleId] }), { finding });
  }
  if (finding && finding.action === 'redirect') {
    return finish({ verdict: 'redirect', step: 7, reasons: [`collusion:${finding.ruleId}`], rules: [finding.ruleId], suggestion: finding.suggestion }, { finding });
  }
  if (finding && (finding.action === 'quarantine' || finding.action === 'alert')) {
    raiseAlert(finding, input, now);
    return finish({ verdict: 'quarantine', step: 7, reasons: [`collusion:${finding.ruleId}`], rules: [finding.ruleId] }, { finding });
  }

  // ── ⑧ 落库 + hash 链 + 签名 + 投递 ─────────────────────────
  const contentHash = hashContent(input.payload);
  const prevHash = getLastContentHash(input.taskId, input.sourceAgentId, input.targetAgentId);
  const base: Omit<A2AEnvelope, 'signature'> = {
    messageId, schemaVersion: 2, kind: input.kind, taskId: input.taskId,
    traceId: input.traceId ?? input.taskId,
    sourceAgentId: input.sourceAgentId, targetAgentId: input.targetAgentId,
    type: 'BROADCAST', payload: input.payload, priority: input.priority ?? 'normal',
    timestamp: now, requiresAck: input.requiresAck ?? false,
    visibility: input.visibility ?? 'domain', contentHash, prevHash,
    chainScope: 'local_device',
    capabilityRequired: input.capabilityRequired, policyContext: {
      requesterTier: fromTier, requesterCardVersion: sourceCard.cardVersion, approvalId: input.approvalId,
    },
    memoryRefs: input.memoryRefs, summary: input.summary,
    parentMessageId: input.parentMessageId, correlationId: input.correlationId,
  };
  const envelope: A2AEnvelope = { ...base, signature: signEnvelope(base) };
  return finish({ verdict: 'allow', step: 8, reasons: [] }, { envelope });
}

/** 越级规则（返回非空 = 拒绝） */
function checkLeapRule(
  input: SendA2AInput, sourceCard: AgentCard, targetCard: AgentCard | null, fromTier: AgentTier, toTier: AgentTier,
): BrokerDecision | null {
  if (targetCard === null) {                                     // 治理队列
    return input.kind === 'escalate' ? null : block(2, 'block', 'governance_inbox_only_for_escalate');
  }
  if (toTier === 'L0' && fromTier !== 'L0' && input.kind !== 'escalate') {
    return block(2, 'block', 'l2_to_l0_requires_escalate');
  }
  if (fromTier === 'L2' && toTier === 'L2') {
    const sameDomain = sourceCard.permission.dataScopes.some(s => targetCard.permission.dataScopes.includes(s));
    if (!sameDomain) return block(2, 'block', 'l2_cross_domain_forbidden');
  }
  if (fromTier === 'L2' && toTier === 'L1' && sourceCard.father?.agentId !== input.targetAgentId) {
    return block(2, 'block', 'l2_can_only_reach_father_or_l0');
  }
  return null;
}

/** 落库 + 发事件 + 返回（第 ⑧ 步与各类拒绝的统一出口） */
function finalize(
  decision: BrokerDecision,
  ctx: { messageId: string; envelope?: A2AEnvelope; input?: SendA2AInput; now?: number; finding?: CollusionFinding; tier?: AgentTier },
): SendA2AResult {
  const now = ctx.now ?? ctx.input?.now ?? Date.now();
  let envelope = ctx.envelope;
  if (decision.verdict === 'allow' && !envelope) envelope = undefined;

  // 阻断/隔离/改道：仍**落库留痕**（治理事实），但不投递
  const base = envelope ?? (ctx.input ? {
    messageId: ctx.messageId, schemaVersion: 2 as const, kind: ctx.input.kind, taskId: ctx.input.taskId,
    traceId: ctx.input.traceId ?? ctx.input.taskId, sourceAgentId: ctx.input.sourceAgentId,
    targetAgentId: ctx.input.targetAgentId, type: 'BROADCAST' as const, payload: ctx.input.payload,
    priority: ctx.input.priority ?? 'normal' as const, timestamp: now, requiresAck: ctx.input.requiresAck ?? false,
    visibility: ctx.input.visibility ?? 'domain' as const, contentHash: hashContent(ctx.input.payload),
    prevHash: null, chainScope: 'local_device' as const, policyContext: { requesterTier: (ctx.tier ?? 'L2') as AgentTier, requesterCardVersion: 0 },
    memoryRefs: ctx.input.memoryRefs, summary: ctx.input.summary, signature: '',
  } satisfies A2AEnvelope : undefined);

  if (base) {
    const record: StoredMessage = {
      envelope: base, verdict: decision.verdict, step: decision.step, reasons: decision.reasons,
      rules: decision.rules, summary: base.summary, createdAt: now,
    };
    persistMessage(record);
  }

  publish(createEvent({
    eventType: decision.verdict === 'allow' ? EventType.A2A_MESSAGE_RECORDED : EventType.A2A_MESSAGE_BLOCKED,
    source: 'a2a-broker',
    traceId: base?.traceId,
    payload: {
      messageId: ctx.messageId, kind: base?.kind, sourceAgentId: base?.sourceAgentId,
      targetAgentId: base?.targetAgentId, taskId: base?.taskId, verdict: decision.verdict,
      step: decision.step, reasons: decision.reasons, rules: decision.rules ?? [],
      contentHash: base?.contentHash, suggestion: decision.suggestion,
    },
  }));

  return { decision, messageId: ctx.messageId, envelope: decision.verdict === 'allow' ? envelope : undefined, finding: ctx.finding };
}

/** 产生串通告警（落库 + 事件；处置默认 `pending`，由 L0 裁决 —— 不自动冻结） */
function raiseAlert(finding: CollusionFinding, input: SendA2AInput, now: number): CollusionAlert {
  const alert: CollusionAlert = {
    alertId: makeAlertId(finding.ruleId, now),
    ruleId: finding.ruleId, severity: finding.severity,
    participants: [input.sourceAgentId, input.targetAgentId],
    taskId: input.taskId, evidence: finding.evidence,
    disposition: 'pending', raisedAt: now, ownerUserId: getActiveOwner(),
  };
  persistAlert(alert);
  publish(createEvent({
    eventType: EventType.A2A_COLLUSION_SUSPECTED,
    source: 'a2a-broker', traceId: input.traceId,
    payload: { alertId: alert.alertId, ruleId: alert.ruleId, severity: alert.severity, participants: alert.participants, taskId: alert.taskId, evidence: alert.evidence },
  }));
  logger.warn(`[A2A] 反串通命中 ${finding.ruleId}：${input.sourceAgentId} → ${input.targetAgentId}（${finding.action}）`);
  return alert;
}

// ── ③ 升级到治理队列（§18 #4）───────────────────────────────────────

/** `escalate`：投递到治理队列（L0 由治理层按需唤醒/创建，不要求 L0 常驻） */
export function escalateToGovernance(input: {
  sourceAgentId: string; taskId: string; reason: string; traceId?: string; evidence?: Record<string, unknown>;
  now?: number;
}, deps: SendA2ADeps = {}): SendA2AResult {
  return sendA2A({
    sourceAgentId: input.sourceAgentId,
    targetAgentId: GOVERNANCE_INBOX,
    kind: 'escalate',
    taskId: input.taskId,
    traceId: input.traceId,
    payload: { reason: input.reason, evidence: input.evidence ?? {} },
    priority: 'high',
    visibility: 'domain',
    now: input.now,
  }, deps);
}

// ── ④ 交接（§6；R1 对账在 P1 接入）─────────────────────────────────

/** 发送交接：包落库 + 消息只带**指针**（§16.0.2 H2） */
export function sendHandoff(input: {
  bundle: HandoffBundle; sourceAgentId: string; targetAgentId: string; traceId?: string;
  memoryKey?: string; now?: number;
}, deps: SendA2ADeps = {}): SendA2AResult & { handoffBundleHash: string } {
  const now = input.now ?? Date.now();
  // §18 #6：系统事实采集 + 自动附加（**不依赖前任自述**）
  let factsBundle = input.bundle;
  if (deps.collectSystemFacts) {
    const facts = deps.collectSystemFacts({ loopId: input.bundle.provenance.loopId });
    const total = facts.failedAttempts.length + facts.rejectedApprovals.length + facts.revertedEdits.length;
    if (total > 0) factsBundle = augmentBundleWithSystemFacts(input.bundle, facts, now);
    const check = crossCheckSelfLimits(factsBundle);
    if (check.missingDeclarations.length > 0) {
      publish(createEvent({
        eventType: EventType.A2A_SELFREPORT_MISMATCH,
        source: 'a2a-broker',
        traceId: input.traceId,
        payload: {
          handoffId: factsBundle.handoffId, taskId: factsBundle.taskId, fromAgentId: input.sourceAgentId,
          systemFactCount: check.systemFactCount,
          missingDeclarations: check.missingDeclarations.map(d => d.detail),
          unsupportedClaims: check.unsupportedClaims,
        },
      }));
    }
  }
  const bundleHash = hashContent(factsBundle as unknown as Record<string, unknown>);
  persistHandoff(factsBundle, bundleHash);
  const memoryKey = input.memoryKey ?? `handoff.${factsBundle.taskId}.${input.sourceAgentId}`;
  const result = sendA2A({
    sourceAgentId: input.sourceAgentId, targetAgentId: input.targetAgentId, kind: 'handoff',
    taskId: factsBundle.taskId, traceId: input.traceId, priority: 'high', requiresAck: true,
    payload: { handoffId: factsBundle.handoffId, bundleHash, goal: factsBundle.intent.goal, remaining: factsBundle.intent.remaining, openQuestions: factsBundle.openQuestions },
    memoryRefs: [{ key: memoryKey, version: 1 }],
    summary: `交接 ${factsBundle.artifacts.length} 个产物；未决 ${factsBundle.openQuestions.length} 项`,
    now,
  }, deps);
  if (result.decision.verdict === 'allow') {
    publish(createEvent({
      eventType: EventType.A2A_HANDOFF_CREATED, source: 'a2a-broker', traceId: input.traceId,
      payload: { handoffId: factsBundle.handoffId, bundleHash, fromAgentId: input.sourceAgentId, toAgentId: input.targetAgentId, taskId: factsBundle.taskId, artifacts: factsBundle.artifacts.length },
    }));
  }
  return { ...result, handoffBundleHash: bundleHash };
}

/** 诊断：Broker 不得作为审批决策者（§18 #11 的可测断言） */
export function brokerActsAsSystemRole(): 'system' {
  return 'system';
}

/** 诊断：A2A 表是否就绪（供启动自检） */
export function a2aTablesReady(): boolean {
  try {
    const row = getMainDb().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='a2a_messages'`).get();
    return Boolean(row);
  } catch { return false; }
}