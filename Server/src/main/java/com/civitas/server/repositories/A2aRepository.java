package com.civitas.server.repositories;

import com.civitas.server.db.Db;
import com.civitas.server.json.Json;
import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * A2A 镜像仓储 —— 与 TS 版 `src/repositories/a2a.ts` 对位。
 *
 * 幂等：`(user_id, message_id)` 主键 + `ON CONFLICT DO UPDATE`；
 * 服务端**不覆盖**本机权威字段（本机上传什么就是什么）。
 */
public final class A2aRepository {
    private A2aRepository() {}

    private static final String MESSAGE_COLUMNS =
            "user_id, message_id, task_id, trace_id, kind, source_agent_id, target_agent_id, "
                    + "parent_message_id, correlation_id, visibility, content_hash, prev_hash, payload_json, "
                    + "summary, verdict, block_reason, priority, memory_refs_json, redacted_fields, truncated, created_at";

    public record A2aMessageRow(
            String messageId,
            String taskId,
            String traceId,
            String kind,
            String sourceAgentId,
            String targetAgentId,
            String parentMessageId,
            String correlationId,
            String visibility,
            String contentHash,
            String prevHash,
            JsonNode payloadJson,
            String summary,
            String verdict,
            String blockReason,
            String priority,
            JsonNode memoryRefsJson,
            JsonNode redactedFields,
            boolean truncated,
            long createdAt,
            Instant syncedAt) {}

    public record A2aMessageInsert(
            String messageId,
            String taskId,
            String traceId,
            String kind,
            String sourceAgentId,
            String targetAgentId,
            String parentMessageId,
            String correlationId,
            String visibility,
            String contentHash,
            String prevHash,
            JsonNode payload,
            String summary,
            String verdict,
            String blockReason,
            String priority,
            JsonNode memoryRefs,
            JsonNode redactedFields,
            boolean truncated,
            long createdAt) {}

    public record A2aCardInsert(
            String cardId,
            String agentId,
            int cardVersion,
            String role,
            long createTime,
            String fatherAgentId,
            String fatherRole,
            JsonNode lineage,
            String status,
            JsonNode health,
            JsonNode ability,
            JsonNode permission,
            String fingerprint,
            long expiresAt) {}

    public record CreatedUpdated(int created, int updated) {}

    /** 键集游标 `(created_at, message_id)`；createdAt 为 JS Number 语义（可能与 TS 一致地带小数） */
    public record Cursor(double createdAt, String messageId) {}

    public record ListMessagesOptions(
            String taskId,
            String agentId,
            Long since,
            int limit,
            Cursor cursor) {}

    private static A2aMessageRow mapRow(Map<String, Object> row) {
        if (row == null) return null;
        Long createdAt = Db.longOf(row, "created_at");
        return new A2aMessageRow(
                Db.str(row, "message_id"),
                Db.str(row, "task_id"),
                Db.str(row, "trace_id"),
                Db.str(row, "kind"),
                Db.str(row, "source_agent_id"),
                Db.str(row, "target_agent_id"),
                Db.str(row, "parent_message_id"),
                Db.str(row, "correlation_id"),
                Db.str(row, "visibility"),
                Db.str(row, "content_hash"),
                Db.str(row, "prev_hash"),
                parseJson(Db.str(row, "payload_json")),
                Db.str(row, "summary"),
                Db.str(row, "verdict"),
                Db.str(row, "block_reason"),
                Db.str(row, "priority"),
                parseJson(Db.str(row, "memory_refs_json")),
                parseJson(Db.str(row, "redacted_fields")),
                Db.bool(row, "truncated"),
                createdAt == null ? 0 : createdAt,
                Db.instantOf(row, "synced_at"));
    }

    private static JsonNode parseJson(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        try {
            return Json.MAPPER.readTree(raw);
        } catch (Exception e) {
            return null;
        }
    }

    /** 批量 upsert（幂等）；返回新增/更新计数 */
    public static CreatedUpdated upsertMessages(Db db, String userId, List<A2aMessageInsert> items) {
        int created = 0;
        int updated = 0;
        for (A2aMessageInsert it : items) {
            Map<String, Object> row = db.one(
                    "INSERT INTO a2a_messages (" + MESSAGE_COLUMNS + ") "
                            + "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21) "
                            + "ON CONFLICT (user_id, message_id) DO UPDATE SET "
                            + "  task_id = EXCLUDED.task_id, "
                            + "  visibility = EXCLUDED.visibility, "
                            + "  payload_json = EXCLUDED.payload_json, "
                            + "  summary = EXCLUDED.summary, "
                            + "  verdict = EXCLUDED.verdict, "
                            + "  block_reason = EXCLUDED.block_reason, "
                            + "  memory_refs_json = EXCLUDED.memory_refs_json, "
                            + "  redacted_fields = EXCLUDED.redacted_fields, "
                            + "  truncated = EXCLUDED.truncated, "
                            + "  synced_at = now() "
                            + "RETURNING (xmax = 0) AS inserted",
                    userId, it.messageId(), it.taskId(), it.traceId(), it.kind(),
                    it.sourceAgentId(), it.targetAgentId(), it.parentMessageId(), it.correlationId(),
                    it.visibility(), it.contentHash(), it.prevHash(), it.payload(), it.summary(),
                    it.verdict(), it.blockReason(), it.priority(), it.memoryRefs(), it.redactedFields(),
                    it.truncated(), it.createdAt());
            boolean inserted = row != null && Boolean.TRUE.equals(row.get("inserted"));
            if (inserted) created += 1;
            else updated += 1;
        }
        return new CreatedUpdated(created, updated);
    }

    /** 增量查询（游标 `(created_at, message_id)`） */
    public static List<A2aMessageRow> listMessages(Db db, String userId, ListMessagesOptions options) {
        List<String> where = new ArrayList<>();
        List<Object> params = new ArrayList<>();
        where.add("user_id = $1");
        params.add(userId);

        if (options.taskId() != null && !options.taskId().isEmpty()) {
            params.add(options.taskId());
            where.add("task_id = $" + params.size());
        }
        if (options.agentId() != null && !options.agentId().isEmpty()) {
            params.add(options.agentId());
            where.add("(source_agent_id = $" + params.size() + " OR target_agent_id = $" + params.size() + ")");
        }
        if (options.since() != null) {
            params.add(options.since());
            where.add("created_at >= $" + params.size());
        }
        if (options.cursor() != null) {
            params.add(options.cursor().createdAt());
            params.add(options.cursor().messageId());
            where.add("(created_at, message_id) > ($" + (params.size() - 1) + ", $" + params.size() + ")");
        }
        params.add(options.limit());

        return db.query(
                "SELECT message_id, task_id, trace_id, kind, source_agent_id, target_agent_id, "
                        + "       parent_message_id, correlation_id, visibility, content_hash, prev_hash, payload_json, "
                        + "       summary, verdict, block_reason, priority, memory_refs_json, redacted_fields, truncated, "
                        + "       created_at, synced_at "
                        + "  FROM a2a_messages "
                        + " WHERE " + String.join(" AND ", where) + " "
                        + " ORDER BY created_at ASC, message_id ASC "
                        + " LIMIT $" + params.size(),
                params.toArray())
                .stream()
                .map(A2aRepository::mapRow)
                .toList();
    }

    // ── 卡片镜像 ────────────────────────────────────────────────────────

    public static CreatedUpdated upsertCards(Db db, String userId, List<A2aCardInsert> items) {
        int created = 0;
        int updated = 0;
        for (A2aCardInsert c : items) {
            Map<String, Object> row = db.one(
                    "INSERT INTO a2a_agent_cards ("
                            + "  user_id, card_id, agent_id, card_version, role, create_time, father_agent_id, father_role, "
                            + "  lineage_json, status, health_json, ability_json, permission_json, fingerprint, expires_at"
                            + ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15) "
                            + "ON CONFLICT (user_id, card_id) DO UPDATE SET "
                            + "  card_version = EXCLUDED.card_version, "
                            + "  status = EXCLUDED.status, "
                            + "  health_json = EXCLUDED.health_json, "
                            + "  ability_json = EXCLUDED.ability_json, "
                            + "  permission_json = EXCLUDED.permission_json, "
                            + "  fingerprint = EXCLUDED.fingerprint, "
                            + "  expires_at = EXCLUDED.expires_at, "
                            + "  synced_at = now() "
                            + "RETURNING (xmax = 0) AS inserted",
                    userId, c.cardId(), c.agentId(), c.cardVersion(), c.role(), c.createTime(),
                    c.fatherAgentId(), c.fatherRole(), c.lineage(), c.status(),
                    c.health(), c.ability(), c.permission(), c.fingerprint(), c.expiresAt());
            boolean inserted = row != null && Boolean.TRUE.equals(row.get("inserted"));
            if (inserted) created += 1;
            else updated += 1;
        }
        return new CreatedUpdated(created, updated);
    }
}
