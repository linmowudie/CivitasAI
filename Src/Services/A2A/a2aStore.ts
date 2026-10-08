/**
 * @module Services/A2A/a2aStore
 * @description A2A 本机持久化（P0a）—— 设计 §8 表结构 + §19.1。
 *
 * 原则：
 *  1. **属主隔离**：所有读写带 `owner_user_id`（与既有一致）；
 *  2. **fail-safe**：库不可用/表缺失时静默降级（与治理台账同口径，不阻塞主链路）；
 *  3. **本机为权威**：`signature`/`verdict`/`prev_hash` 只在本机产生，服务端仅镜像（§15.7）。
 */

import { getMainDb } from '../../Infra/Db/database.js';
import { getActiveOwner } from '../../Infra/AccountScope/activeAccount.js';
import type { AgentCard, A2AEnvelope, BrokerDecision, CollusionAlert, HandoffBundle } from './types.js';

/** 落库的消息记录（信封 + Broker 判定元数据） */
export interface StoredMessage {
  envelope: A2AEnvelope;
  verdict: BrokerDecision['verdict'];
  step?: number;
  reasons: string[];
  rules?: string[];
  /** 跨域摘要（D4：跨域**不返回正文**） */
  summary?: string;
  createdAt: number;
  /** 投递时间（治理队列 drain 时写入） */
  deliveredAt?: number;
  /** 确认时间（requiresAck 的回执） */
  ackedAt?: number;
}

let tablesReady: boolean | null = null;

/** 探测 A2A 表是否就绪（缓存结果，失败后允许重试一次） */
export function canPersist(): boolean {
  if (tablesReady === true) return true;
  try {
    const row = getMainDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='a2a_messages'`)
      .get() as { name?: string } | undefined;
    tablesReady = Boolean(row?.name);
    return tablesReady;
  } catch {
    tablesReady = false;
    return false;
  }
}

/** 测试用：重置就绪缓存 */
export function resetStoreProbe(): void { tablesReady = null; }

function safeRun(fn: () => void): void {
  try { fn(); } catch { /* fail-safe：持久化失败不影响主链路 */ }
}

// ── 卡片 ────────────────────────────────────────────────────────────

export function persistCard(card: AgentCard): void {
  if (!canPersist()) return;
  safeRun(() => {
    getMainDb().prepare(`
      INSERT OR REPLACE INTO agent_cards (
        card_id, agent_id, card_version, role, create_time, update_time,
        father_agent_id, father_role, lineage_json, status, health_json, ability_json,
        permission_json, fingerprint, issued_by, expires_at, owner_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      card.cardId, card.agentId, card.cardVersion, card.role, card.createTime, card.updateTime,
      card.father?.agentId ?? null, card.father?.role ?? null, JSON.stringify(card.lineage), card.status,
      JSON.stringify(card.health), JSON.stringify(card.ability), JSON.stringify(card.permission),
      card.fingerprint, card.issuedBy, card.expiresAt, card.ownerUserId,
    );
  });
}

export function loadCard(agentId: string, options: { version?: number } = {}): AgentCard | null {
  if (!canPersist()) return null;
  try {
    const sql = options.version
      ? `SELECT * FROM agent_cards WHERE agent_id = ? AND card_version = ? AND owner_user_id = ? LIMIT 1`
      : `SELECT * FROM agent_cards WHERE agent_id = ? AND owner_user_id = ? ORDER BY card_version DESC LIMIT 1`;
    const params = options.version
      ? [agentId, options.version, getActiveOwner()]
      : [agentId, getActiveOwner()];
    const row = getMainDb().prepare(sql).get(...params) as Record<string, unknown> | undefined;
    return row ? rowToCard(row) : null;
  } catch { return null; }
}

export function listCards(options: { status?: string; limit?: number } = {}): AgentCard[] {
  if (!canPersist()) return [];
  try {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    const rows = options.status
      ? getMainDb().prepare(`SELECT * FROM agent_cards WHERE owner_user_id = ? AND status = ? ORDER BY create_time DESC LIMIT ?`).all(getActiveOwner(), options.status, limit)
      : getMainDb().prepare(`SELECT * FROM agent_cards WHERE owner_user_id = ? ORDER BY create_time DESC LIMIT ?`).all(getActiveOwner(), limit);
    return (rows as Record<string, unknown>[]).map(rowToCard);
  } catch { return []; }
}

function rowToCard(r: Record<string, unknown>): AgentCard {
  const fatherId = r['father_agent_id'] as string | null;
  return {
    cardId: String(r['card_id']), agentId: String(r['agent_id']), cardVersion: Number(r['card_version']),
    role: r['role'] as AgentCard['role'], createTime: Number(r['create_time']), updateTime: Number(r['update_time']),
    father: fatherId ? { agentId: fatherId, role: (r['father_role'] as AgentCard['role']) ?? 'worker' } : null,
    lineage: JSON.parse(String(r['lineage_json'] ?? '[]')) as string[],
    status: r['status'] as AgentCard['status'],
    health: JSON.parse(String(r['health_json'] ?? '{}')) as AgentCard['health'],
    ability: JSON.parse(String(r['ability_json'] ?? '{}')) as AgentCard['ability'],
    permission: JSON.parse(String(r['permission_json'] ?? '{}')) as AgentCard['permission'],
    fingerprint: String(r['fingerprint']), issuedBy: String(r['issued_by']),
    expiresAt: Number(r['expires_at']), ownerUserId: String(r['owner_user_id']),
  };
}

// ── 消息 ────────────────────────────────────────────────────────────

export function persistMessage(record: StoredMessage): void {
  if (!canPersist()) return;
  const e = record.envelope;
  safeRun(() => {
    getMainDb().prepare(`
      INSERT OR REPLACE INTO a2a_messages (
        message_id, schema_version, kind, trace_id, task_id, source_agent_id, target_agent_id,
        parent_message_id, correlation_id, message_type, requires_ack, priority, visibility,
        content_hash, prev_hash, chain_scope,
        payload_json, summary, memory_refs_json, verdict, step, reasons_json, rules_json,
        signature, created_at, owner_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      e.messageId, e.schemaVersion, e.kind, e.traceId, e.taskId, e.sourceAgentId, e.targetAgentId,
      e.parentMessageId ?? null, e.correlationId ?? null, e.type, e.requiresAck ? 1 : 0, e.priority, e.visibility,
      e.contentHash, e.prevHash, e.chainScope, JSON.stringify(e.payload), record.summary ?? e.summary ?? null,
      JSON.stringify(e.memoryRefs ?? []), record.verdict, record.step ?? null,
      JSON.stringify(record.reasons), JSON.stringify(record.rules ?? []),
      e.signature, record.createdAt, getActiveOwner(),
    );
  });
}

export function listMessages(filter: {
  taskId?: string; sourceAgentId?: string; targetAgentId?: string; verdict?: string; limit?: number;
} = {}): StoredMessage[] {
  if (!canPersist()) return [];
  try {
    const where: string[] = ['owner_user_id = ?'];
    const params: unknown[] = [getActiveOwner()];
    if (filter.taskId) { where.push('task_id = ?'); params.push(filter.taskId); }
    if (filter.sourceAgentId) { where.push('source_agent_id = ?'); params.push(filter.sourceAgentId); }
    if (filter.targetAgentId) { where.push('target_agent_id = ?'); params.push(filter.targetAgentId); }
    if (filter.verdict) { where.push('verdict = ?'); params.push(filter.verdict); }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 2000);
    const rows = getMainDb()
      .prepare(`SELECT * FROM a2a_messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  } catch { return []; }
}

/** 标记已投递（治理队列 drain） */
export function markDelivered(messageId: string, at = Date.now()): void {
  if (!canPersist()) return;
  safeRun(() => {
    getMainDb().prepare(
      `UPDATE a2a_messages SET delivered_at = ? WHERE message_id = ? AND owner_user_id = ?`,
    ).run(at, messageId, getActiveOwner());
  });
}

/** 标记已确认（requiresAck 回执） */
export function markAcked(messageId: string, at = Date.now()): void {
  if (!canPersist()) return;
  safeRun(() => {
    getMainDb().prepare(
      `UPDATE a2a_messages SET acked_at = ? WHERE message_id = ? AND owner_user_id = ?`,
    ).run(at, messageId, getActiveOwner());
  });
}

/** 按消息 ID 查询单条（RM7 溯源校验用；属主隔离） */
export function getMessageById(messageId: string): StoredMessage | null {
  if (!canPersist()) return null;
  try {
    const row = getMainDb().prepare(
      `SELECT * FROM a2a_messages WHERE message_id = ? AND owner_user_id = ? LIMIT 1`,
    ).get(messageId, getActiveOwner()) as Record<string, unknown> | undefined;
    return row ? rowToMessage(row) : null;
  } catch { return null; }
}

/** 统计某方向会话在窗口内的消息数（C1/C5 与配额共用） */
export function countMessages(fromAgentId: string, toAgentId: string, windowMs: number, now = Date.now()): number {
  if (!canPersist()) return 0;
  try {
    const row = getMainDb().prepare(
      `SELECT COUNT(*) AS n FROM a2a_messages
       WHERE owner_user_id = ? AND source_agent_id = ? AND target_agent_id = ? AND created_at >= ?`,
    ).get(getActiveOwner(), fromAgentId, toAgentId, now - windowMs) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } catch { return 0; }
}

/** 取 (taskId, from→to) 会话内最近一条 content_hash（hash 链的 prevHash 来源） */
export function getLastContentHash(taskId: string, fromAgentId: string, toAgentId: string): string | null {
  if (!canPersist()) return null;
  try {
    const row = getMainDb().prepare(
      `SELECT content_hash FROM a2a_messages
       WHERE owner_user_id = ? AND task_id = ? AND source_agent_id = ? AND target_agent_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    ).get(getActiveOwner(), taskId, fromAgentId, toAgentId) as { content_hash?: string } | undefined;
    return row?.content_hash ?? null;
  } catch { return null; }
}

function rowToMessage(r: Record<string, unknown>): StoredMessage {
  const envelope: A2AEnvelope = {
    messageId: String(r['message_id']), schemaVersion: 2, kind: r['kind'] as A2AEnvelope['kind'],
    traceId: String(r['trace_id']), taskId: String(r['task_id']),
    sourceAgentId: String(r['source_agent_id']), targetAgentId: String(r['target_agent_id']),
    parentMessageId: (r['parent_message_id'] as string) ?? undefined,
    correlationId: (r['correlation_id'] as string) ?? undefined,
    type: (r['message_type'] as A2AEnvelope['type']) ?? 'BROADCAST',
    payload: JSON.parse(String(r['payload_json'] ?? '{}')) as Record<string, unknown>,
    priority: r['priority'] as A2AEnvelope['priority'], timestamp: Number(r['created_at']),
    requiresAck: Number(r['requires_ack'] ?? 0) === 1, visibility: r['visibility'] as A2AEnvelope['visibility'],
    contentHash: String(r['content_hash']), prevHash: (r['prev_hash'] as string) ?? null,
    chainScope: (r['chain_scope'] as A2AEnvelope['chainScope']) ?? 'local_device',
    policyContext: { requesterTier: 'L2', requesterCardVersion: 0 },
    signature: String(r['signature']), memoryRefs: JSON.parse(String(r['memory_refs_json'] ?? '[]')) as A2AEnvelope['memoryRefs'],
    summary: (r['summary'] as string) ?? undefined,
  };
  return {
    envelope,
    verdict: r['verdict'] as StoredMessage['verdict'],
    step: r['step'] === null || r['step'] === undefined ? undefined : Number(r['step']),
    reasons: JSON.parse(String(r['reasons_json'] ?? '[]')) as string[],
    rules: JSON.parse(String(r['rules_json'] ?? '[]')) as string[],
    summary: (r['summary'] as string) ?? undefined,
    createdAt: Number(r['created_at']),
    ...(r['delivered_at'] !== null && r['delivered_at'] !== undefined ? { deliveredAt: Number(r['delivered_at']) } : {}),
    ...(r['acked_at'] !== null && r['acked_at'] !== undefined ? { ackedAt: Number(r['acked_at']) } : {}),
  };
}

// ── 交接 ────────────────────────────────────────────────────────────

export function persistHandoff(bundle: HandoffBundle, bundleHash: string): void {
  if (!canPersist()) return;
  safeRun(() => {
    getMainDb().prepare(`
      INSERT OR REPLACE INTO a2a_handoffs (
        handoff_id, task_id, from_agent_id, to_agent_id, bundle_json, bundle_hash,
        artifacts_json, verification_status, created_at, owner_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bundle.handoffId, bundle.taskId, bundle.fromAgentId, bundle.toAgentId,
      JSON.stringify(bundle), bundleHash, JSON.stringify(bundle.artifacts),
      'pending', bundle.createTime, getActiveOwner(),
    );
  });
}

export function loadHandoff(handoffId: string): HandoffBundle | null {
  if (!canPersist()) return null;
  try {
    const row = getMainDb().prepare(
      `SELECT bundle_json FROM a2a_handoffs WHERE handoff_id = ? AND owner_user_id = ? LIMIT 1`,
    ).get(handoffId, getActiveOwner()) as { bundle_json?: string } | undefined;
    return row?.bundle_json ? JSON.parse(row.bundle_json) as HandoffBundle : null;
  } catch { return null; }
}

/** R2 复核记录（继任者已承担"独立复核"义务的区域） */
export interface HandoffReview {
  acknowledgedAreas: string[];
  reviewedAt: number;
  reviewerAgentId?: string;
}

/** 读取复核记录（无记录返回 `{ acknowledgedAreas: [], reviewedAt: 0 }`） */
export function loadHandoffReview(handoffId: string): HandoffReview {
  if (!canPersist()) return { acknowledgedAreas: [], reviewedAt: 0 };
  try {
    const row = getMainDb().prepare(
      `SELECT review_json FROM a2a_handoffs WHERE handoff_id = ? AND owner_user_id = ? LIMIT 1`,
    ).get(handoffId, getActiveOwner()) as { review_json?: string } | undefined;
    const parsed = JSON.parse(String(row?.review_json ?? '{}')) as Partial<HandoffReview>;
    return { acknowledgedAreas: parsed.acknowledgedAreas ?? [], reviewedAt: parsed.reviewedAt ?? 0, reviewerAgentId: parsed.reviewerAgentId };
  } catch { return { acknowledgedAreas: [], reviewedAt: 0 }; }
}

/** 写入复核记录（累加确认区域） */
export function setHandoffReview(handoffId: string, review: HandoffReview): void {
  if (!canPersist()) return;
  safeRun(() => {
    getMainDb().prepare(
      `UPDATE a2a_handoffs SET review_json = ? WHERE handoff_id = ? AND owner_user_id = ?`,
    ).run(JSON.stringify(review), handoffId, getActiveOwner());
  });
}

/** 更新交接的对账结果（R1：verified | conflict） */
export function setHandoffVerification(handoffId: string, status: 'verified' | 'conflict'): void {
  if (!canPersist()) return;
  safeRun(() => {
    getMainDb().prepare(
      `UPDATE a2a_handoffs SET verification_status = ?, verified_at = ? WHERE handoff_id = ? AND owner_user_id = ?`,
    ).run(status, Date.now(), handoffId, getActiveOwner());
  });
}

// ── 告警 ────────────────────────────────────────────────────────────

export function persistAlert(alert: CollusionAlert): void {
  if (!canPersist()) return;
  safeRun(() => {
    getMainDb().prepare(`
      INSERT OR REPLACE INTO a2a_collusion_alerts (
        alert_id, rule_id, severity, participants_json, task_id, evidence_json,
        disposition, raised_at, resolved_at, owner_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      alert.alertId, alert.ruleId, alert.severity, JSON.stringify(alert.participants),
      alert.taskId ?? null, JSON.stringify(alert.evidence), alert.disposition,
      alert.raisedAt, alert.resolvedAt ?? null, alert.ownerUserId,
    );
  });
}

export function listAlerts(filter: { ruleId?: string; disposition?: string; limit?: number } = {}): CollusionAlert[] {
  if (!canPersist()) return [];
  try {
    const where: string[] = ['owner_user_id = ?'];
    const params: unknown[] = [getActiveOwner()];
    if (filter.ruleId) { where.push('rule_id = ?'); params.push(filter.ruleId); }
    if (filter.disposition) { where.push('disposition = ?'); params.push(filter.disposition); }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const rows = getMainDb()
      .prepare(`SELECT * FROM a2a_collusion_alerts WHERE ${where.join(' AND ')} ORDER BY raised_at DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToAlert);
  } catch { return []; }
}

/** 单行 → 告警对象 */
function rowToAlert(r: Record<string, unknown>): CollusionAlert {
  return ({
      alertId: String(r['alert_id']), ruleId: r['rule_id'] as CollusionAlert['ruleId'],
      severity: r['severity'] as CollusionAlert['severity'],
      participants: JSON.parse(String(r['participants_json'] ?? '[]')) as string[],
      taskId: (r['task_id'] as string) ?? undefined,
      evidence: JSON.parse(String(r['evidence_json'] ?? '{}')) as Record<string, unknown>,
      disposition: r['disposition'] as CollusionAlert['disposition'],
      raisedAt: Number(r['raised_at']),
      resolvedAt: r['resolved_at'] === null || r['resolved_at'] === undefined ? undefined : Number(r['resolved_at']),
      ownerUserId: String(r['owner_user_id']),
  });
}

/** 按 ID 查告警（处置链用） */
export function getAlertById(alertId: string): CollusionAlert | null {
  if (!canPersist()) return null;
  try {
    const row = getMainDb().prepare(
      `SELECT * FROM a2a_collusion_alerts WHERE alert_id = ? AND owner_user_id = ? LIMIT 1`,
    ).get(alertId, getActiveOwner()) as Record<string, unknown> | undefined;
    return row ? rowToAlert(row) : null;
  } catch { return null; }
}

/** 更新告警处置结果 */
export function updateAlertDisposition(alertId: string, disposition: string, resolvedAt?: number): void {
  if (!canPersist()) return;
  safeRun(() => {
    getMainDb().prepare(
      `UPDATE a2a_collusion_alerts SET disposition = ?, resolved_at = ? WHERE alert_id = ? AND owner_user_id = ?`,
    ).run(disposition, resolvedAt ?? Date.now(), alertId, getActiveOwner());
  });
}

/** 写入配对冷却（双向各写一行） */
export function setCooldown(fromAgentId: string, toAgentId: string, untilAt: number, reason?: string, alertId?: string): void {
  if (!canPersist()) return;
  safeRun(() => {
    getMainDb().prepare(
      `INSERT OR REPLACE INTO a2a_cooldowns (owner_user_id, from_agent_id, to_agent_id, until_at, reason, alert_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(getActiveOwner(), fromAgentId, toAgentId, untilAt, reason ?? null, alertId ?? null);
  });
}

/** 查询生效中的配对冷却（未过期才返回） */
export function getCooldown(fromAgentId: string, toAgentId: string, now = Date.now()): { untilAt: number; reason?: string } | null {
  if (!canPersist()) return null;
  try {
    const row = getMainDb().prepare(
      `SELECT until_at, reason FROM a2a_cooldowns WHERE owner_user_id = ? AND from_agent_id = ? AND to_agent_id = ? AND until_at > ? LIMIT 1`,
    ).get(getActiveOwner(), fromAgentId, toAgentId, now) as { until_at?: number; reason?: string } | undefined;
    return row ? { untilAt: Number(row.until_at), ...(row.reason ? { reason: row.reason } : {}) } : null;
  } catch { return null; }
}

// ── 客户端同步编排用（P0c）──────────────────────────────────────────

/** 待上行的消息（`synced_at IS NULL`；按时间升序，便于游标推进） */
export function listUnsyncedMessages(limit = 200): StoredMessage[] {
  if (!canPersist()) return [];
  try {
    const rows = getMainDb().prepare(
      `SELECT * FROM a2a_messages
        WHERE owner_user_id = ? AND synced_at IS NULL
        ORDER BY created_at ASC, message_id ASC LIMIT ?`,
    ).all(getActiveOwner(), Math.min(Math.max(limit, 1), 2000)) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  } catch { return []; }
}

/** 标记已上行（幂等重试安全：失败不标记，下次重试） */
export function markMessagesSynced(messageIds: string[], at = Date.now()): number {
  if (!canPersist() || messageIds.length === 0) return 0;
  let n = 0;
  safeRun(() => {
    const stmt = getMainDb().prepare(
      `UPDATE a2a_messages SET synced_at = ? WHERE message_id = ? AND owner_user_id = ?`,
    );
    for (const id of messageIds) {
      const r = stmt.run(at, id, getActiveOwner());
      n += Number(r.changes ?? 0);
    }
  });
  return n;
}

/**
 * 应用服务端拉回的消息（**本机优先**：已存在则跳过，不覆盖本机判定/签名）。
 * @returns `{ applied, skipped }`
 */
export function applyPulledMessages(items: Array<{
  messageId: string; taskId: string; kind: string; sourceAgentId: string; targetAgentId: string;
  visibility: string; contentHash: string; prevHash?: string | null; payload?: unknown;
  verdict: string; summary?: string | null; createdAt: number;
}>): { applied: number; skipped: number } {
  if (!canPersist()) return { applied: 0, skipped: 0 };
  let applied = 0; let skipped = 0;
  const owner = getActiveOwner();
  safeRun(() => {
    const exists = getMainDb().prepare(
      `SELECT 1 AS x FROM a2a_messages WHERE message_id = ? AND owner_user_id = ? LIMIT 1`,
    );
    const insert = getMainDb().prepare(`
      INSERT INTO a2a_messages (
        message_id, schema_version, kind, trace_id, task_id, source_agent_id, target_agent_id,
        priority, visibility, content_hash, prev_hash, chain_scope, payload_json, summary,
        memory_refs_json, verdict, reasons_json, rules_json, signature, created_at, owner_user_id, synced_at
      ) VALUES (?, 2, ?, ?, ?, ?, ?, 'normal', ?, ?, ?, 'cross_device', ?, ?, '[]', ?, '[]', '[]', '', ?, ?, ?)
    `);
    for (const it of items) {
      if (exists.get(it.messageId, owner)) { skipped++; continue; }
      insert.run(
        it.messageId, it.kind, it.taskId, it.taskId, it.sourceAgentId, it.targetAgentId,
        it.visibility, it.contentHash, it.prevHash ?? null, JSON.stringify(it.payload ?? {}),
        it.summary ?? null, it.verdict, it.createdAt, owner, Date.now(),
      );
      applied++;
    }
  });
  return { applied, skipped };
}

/** 未上行条数（诊断/UI 用） */
export function countUnsyncedMessages(): number {
  if (!canPersist()) return 0;
  try {
    const row = getMainDb().prepare(
      `SELECT COUNT(*) AS n FROM a2a_messages WHERE owner_user_id = ? AND synced_at IS NULL`,
    ).get(getActiveOwner()) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } catch { return 0; }
}

/** 测试用：清空当前属主的 A2A 数据 */
export function resetA2aStore(): void {
  if (!canPersist()) return;
  const owner = getActiveOwner();
  safeRun(() => {
    for (const t of ['a2a_messages', 'a2a_handoffs', 'a2a_collusion_alerts', 'a2a_cooldowns', 'agent_cards']) {
      getMainDb().prepare(`DELETE FROM ${t} WHERE owner_user_id = ?`).run(owner);
    }
  });
}
