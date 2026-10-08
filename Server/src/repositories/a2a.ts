/**
 * @module repositories/a2a
 * @description A2A 镜像仓储（P0c）—— SQL 层，照 `repositories/tasks.ts` 范式。
 *
 * 幂等：`(user_id, message_id)` 主键 + `ON CONFLICT DO UPDATE`；
 * 服务端**不覆盖**本机权威字段（本机上传什么就是什么；本机已有则不会被服务端"拉回"改写）。
 */

import type { Db } from '../db/pool.js';

export interface A2AMessageRow {
  message_id: string;
  task_id: string;
  trace_id: string;
  kind: string;
  source_agent_id: string;
  target_agent_id: string;
  parent_message_id: string | null;
  correlation_id: string | null;
  visibility: string;
  content_hash: string;
  prev_hash: string | null;
  payload_json: unknown;
  summary: string | null;
  verdict: string;
  block_reason: string | null;
  priority: string;
  memory_refs_json: unknown;
  redacted_fields: unknown;
  truncated: boolean;
  created_at: string | number;
  synced_at: Date | string;
}

export interface A2AMessageInsert {
  messageId: string;
  taskId: string;
  traceId: string;
  kind: string;
  sourceAgentId: string;
  targetAgentId: string;
  parentMessageId: string | null;
  correlationId: string | null;
  visibility: string;
  contentHash: string;
  prevHash: string | null;
  payload: unknown;
  summary: string | null;
  verdict: string;
  blockReason: string | null;
  priority: string;
  memoryRefs: unknown;
  redactedFields: string[];
  truncated: boolean;
  createdAt: number;
}

const MESSAGE_COLUMNS = `
  user_id, message_id, task_id, trace_id, kind, source_agent_id, target_agent_id,
  parent_message_id, correlation_id, visibility, content_hash, prev_hash, payload_json,
  summary, verdict, block_reason, priority, memory_refs_json, redacted_fields, truncated, created_at
`;

/** 批量 upsert（幂等）；返回新增/更新计数 */
export async function upsertMessages(
  db: Db, userId: string, items: A2AMessageInsert[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const it of items) {
    const rows = await db.query<{ inserted: boolean }>(
      `INSERT INTO a2a_messages (${MESSAGE_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21)
       ON CONFLICT (user_id, message_id) DO UPDATE SET
         task_id = EXCLUDED.task_id,
         visibility = EXCLUDED.visibility,
         payload_json = EXCLUDED.payload_json,
         summary = EXCLUDED.summary,
         verdict = EXCLUDED.verdict,
         block_reason = EXCLUDED.block_reason,
         memory_refs_json = EXCLUDED.memory_refs_json,
         redacted_fields = EXCLUDED.redacted_fields,
         truncated = EXCLUDED.truncated,
         synced_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        userId, it.messageId, it.taskId, it.traceId, it.kind, it.sourceAgentId, it.targetAgentId,
        it.parentMessageId, it.correlationId, it.visibility, it.contentHash, it.prevHash,
        JSON.stringify(it.payload ?? {}), it.summary, it.verdict, it.blockReason, it.priority,
        JSON.stringify(it.memoryRefs ?? []), JSON.stringify(it.redactedFields ?? []),
        it.truncated, it.createdAt,
      ],
    );
    if (rows[0]?.inserted) created++;
    else updated++;
  }
  return { created, updated };
}

/** 增量查询（游标 `(created_at, message_id)`） */
export async function listMessages(
  db: Db, userId: string,
  options: { taskId?: string; agentId?: string; since?: number; limit: number; cursor?: { createdAt: number; messageId: string } },
): Promise<A2AMessageRow[]> {
  const where: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];
  const push = (clause: string, value: unknown) => { params.push(value); where.push(clause.replace('$?', `$${params.length}`)); };
  if (options.taskId) push('task_id = $?', options.taskId);
  if (options.agentId) {
    params.push(options.agentId);
    where.push(`(source_agent_id = $${params.length} OR target_agent_id = $${params.length})`);
  }
  if (options.since !== undefined) push('created_at >= $?', options.since);
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.messageId);
    where.push(`(created_at, message_id) > ($${params.length - 1}, $${params.length})`);
  }
  params.push(options.limit);
  const rows = await db.query<A2AMessageRow>(
    `SELECT message_id, task_id, trace_id, kind, source_agent_id, target_agent_id,
            parent_message_id, correlation_id, visibility, content_hash, prev_hash, payload_json,
            summary, verdict, block_reason, priority, memory_refs_json, redacted_fields, truncated,
            created_at, synced_at
       FROM a2a_messages
      WHERE ${where.join(' AND ')}
      ORDER BY created_at ASC, message_id ASC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

// ── 卡片镜像 ────────────────────────────────────────────────────────

export interface A2ACardInsert {
  cardId: string;
  agentId: string;
  cardVersion: number;
  role: string;
  createTime: number;
  fatherAgentId: string | null;
  fatherRole: string | null;
  lineage: string[];
  status: string;
  health: unknown;
  ability: unknown;
  permission: unknown;
  fingerprint: string;
  expiresAt: number;
}

export async function upsertCards(
  db: Db, userId: string, items: A2ACardInsert[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const c of items) {
    const rows = await db.query<{ inserted: boolean }>(
      `INSERT INTO a2a_agent_cards (
         user_id, card_id, agent_id, card_version, role, create_time, father_agent_id, father_role,
         lineage_json, status, health_json, ability_json, permission_json, fingerprint, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15)
       ON CONFLICT (user_id, card_id) DO UPDATE SET
         card_version = EXCLUDED.card_version,
         status = EXCLUDED.status,
         health_json = EXCLUDED.health_json,
         ability_json = EXCLUDED.ability_json,
         permission_json = EXCLUDED.permission_json,
         fingerprint = EXCLUDED.fingerprint,
         expires_at = EXCLUDED.expires_at,
         synced_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        userId, c.cardId, c.agentId, c.cardVersion, c.role, c.createTime,
        c.fatherAgentId, c.fatherRole, JSON.stringify(c.lineage ?? []), c.status,
        JSON.stringify(c.health ?? {}), JSON.stringify(c.ability ?? {}),
        JSON.stringify(c.permission ?? {}), c.fingerprint, c.expiresAt,
      ],
    );
    if (rows[0]?.inserted) created++;
    else updated++;
  }
  return { created, updated };
}
