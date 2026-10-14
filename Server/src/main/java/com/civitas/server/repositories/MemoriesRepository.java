package com.civitas.server.repositories;

import com.civitas.server.db.Db;
import com.civitas.server.json.IsoTimes;
import com.civitas.server.json.Json;
import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 记忆存储：与端侧 `long_term_memory` 字段对齐，支持按 client_memory_id 幂等 upsert
 * （这是"卸载重装后无损重建"的关键）—— 与 TS 版 `src/repositories/memories.ts` 对位。
 *
 * 检索说明：`q` 含 CJK 时走 ILIKE（'simple' 分词器无法切中文）；
 * 纯拉丁查询走 tsvector + websearch_to_tsquery，可用 GIN 索引。
 */
public final class MemoriesRepository {
    private MemoriesRepository() {}

    private static final String COLUMNS =
            "id, user_id, client_memory_id, title, content, category, assertion, "
                    + "source_trace_ids, source_arbitration_ids, status, contradicted_by, "
                    + "access_count, created_at, last_accessed_at, updated_at";

    /** 导出分页大小（键集分页；见 `listAllMemories` 的 SV-001 说明） */
    private static final int EXPORT_PAGE_SIZE = 1_000;

    public record MemoryRow(
            String id,
            String userId,
            String clientMemoryId,
            String title,
            String content,
            String category,
            String assertion,
            JsonNode sourceTraceIds,
            JsonNode sourceArbitrationIds,
            String status,
            String contradictedBy,
            int accessCount,
            Instant createdAt,
            Instant lastAccessedAt,
            Instant updatedAt) {}

    public record MemoryInput(
            String clientMemoryId,
            String title,
            String content,
            String category,
            String assertion,
            JsonNode sourceTraceIds,
            JsonNode sourceArbitrationIds,
            String status,
            String contradictedBy,
            Integer accessCount,
            Instant createdAt,
            Instant lastAccessedAt) {}

    /** 局部更新补丁：null 字段表示未传入（contradictedBy 用 hasContradictedBy 区分"置空"与"不改"） */
    public record MemoryPatch(
            String title,
            String content,
            String category,
            String assertion,
            String status,
            boolean hasContradictedBy,
            String contradictedBy,
            Integer accessCount,
            Instant lastAccessedAt) {}

    private static MemoryRow mapRow(Map<String, Object> row) {
        if (row == null) return null;
        Long accessCount = Db.longOf(row, "access_count");
        return new MemoryRow(
                Db.str(row, "id"),
                Db.str(row, "user_id"),
                Db.str(row, "client_memory_id"),
                Db.str(row, "title"),
                Db.str(row, "content"),
                Db.str(row, "category"),
                Db.str(row, "assertion"),
                parseJson(Db.str(row, "source_trace_ids")),
                parseJson(Db.str(row, "source_arbitration_ids")),
                Db.str(row, "status"),
                Db.str(row, "contradicted_by"),
                accessCount == null ? 0 : accessCount.intValue(),
                Db.instantOf(row, "created_at"),
                Db.instantOf(row, "last_accessed_at"),
                Db.instantOf(row, "updated_at"));
    }

    /** jsonb 读出为字符串 → 转回 JSON 结构（与 TS 版 pg 的 JSON 解析行为对位） */
    private static JsonNode parseJson(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        try {
            return Json.MAPPER.readTree(raw);
        } catch (Exception e) {
            return null;
        }
    }

    /** 是否包含 CJK 字符（决定走 ILIKE 还是 tsvector） */
    public static boolean containsCjk(String text) {
        return CJK.matcher(text).find();
    }

    private static final Pattern CJK =
            Pattern.compile("[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]");

    /** 单条 upsert（有 clientMemoryId 走幂等更新，否则新建） */
    public static MemoryRow upsertMemory(Db db, String userId, MemoryInput input) {
        Instant now = Instant.now();
        Instant createdAt = input.createdAt() != null ? input.createdAt() : now;
        Instant lastAccessedAt = input.lastAccessedAt() != null ? input.lastAccessedAt() : createdAt;
        String category = input.category() != null ? input.category() : "general";
        String assertion = input.assertion() != null ? input.assertion() : "observed";
        String status = input.status() != null ? input.status() : "active";
        JsonNode traceIds = input.sourceTraceIds() == null ? Json.MAPPER.createArrayNode() : input.sourceTraceIds();
        JsonNode arbitrationIds = input.sourceArbitrationIds() == null ? null : input.sourceArbitrationIds();
        int accessCount = input.accessCount() == null ? 0 : input.accessCount();

        if (input.clientMemoryId() != null) {
            Map<String, Object> row = db.one(
                    "INSERT INTO memories (user_id, client_memory_id, title, content, category, assertion, "
                            + "source_trace_ids, source_arbitration_ids, status, contradicted_by, "
                            + "access_count, created_at, last_accessed_at, updated_at) "
                            + "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now()) "
                            + "ON CONFLICT (user_id, client_memory_id) WHERE client_memory_id IS NOT NULL "
                            + "DO UPDATE SET title = EXCLUDED.title, "
                            + "              content = EXCLUDED.content, "
                            + "              category = EXCLUDED.category, "
                            + "              assertion = EXCLUDED.assertion, "
                            + "              source_trace_ids = EXCLUDED.source_trace_ids, "
                            + "              source_arbitration_ids = EXCLUDED.source_arbitration_ids, "
                            + "              status = EXCLUDED.status, "
                            + "              contradicted_by = EXCLUDED.contradicted_by, "
                            + "              access_count = EXCLUDED.access_count, "
                            + "              last_accessed_at = EXCLUDED.last_accessed_at, "
                            + "              updated_at = now() "
                            + "RETURNING " + COLUMNS,
                    userId, input.clientMemoryId(), input.title(), input.content(), category, assertion,
                    traceIds, arbitrationIds, status, input.contradictedBy(), accessCount,
                    createdAt, lastAccessedAt);
            if (row == null) throw new IllegalStateException("记忆写入失败");
            return mapRow(row);
        }

        Map<String, Object> row = db.one(
                "INSERT INTO memories (user_id, client_memory_id, title, content, category, assertion, "
                        + "source_trace_ids, source_arbitration_ids, status, contradicted_by, "
                        + "access_count, created_at, last_accessed_at, updated_at) "
                        + "VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now()) "
                        + "RETURNING " + COLUMNS,
                userId, input.title(), input.content(), category, assertion,
                traceIds, arbitrationIds, status, input.contradictedBy(), accessCount,
                createdAt, lastAccessedAt);
        if (row == null) throw new IllegalStateException("记忆写入失败");
        return mapRow(row);
    }

    public static MemoryRow getMemory(Db db, String userId, String id) {
        return mapRow(db.one(
                "SELECT " + COLUMNS + " FROM memories WHERE user_id = $1 AND id = $2", userId, id));
    }

    public static MemoryRow getMemoryByClientId(Db db, String userId, String clientMemoryId) {
        return mapRow(db.one(
                "SELECT " + COLUMNS + " FROM memories WHERE user_id = $1 AND client_memory_id = $2",
                userId, clientMemoryId));
    }

    public record ListMemoriesOptions(
            int limit,
            String cursor,
            String category,
            String status,
            String q) {}

    public record ListMemoriesResult(List<MemoryRow> items, String nextCursor) {}

    public static String encodeCursor(MemoryRow row) {
        String raw = IsoTimes.format(row.createdAt()) + "|" + row.id();
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    public record DecodedCursor(Instant createdAt, String id) {}

    public static DecodedCursor decodeCursor(String cursor) {
        try {
            String raw = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
            int sep = raw.lastIndexOf('|');
            if (sep <= 0) return null;
            Instant createdAt = Instant.parse(raw.substring(0, sep));
            String id = raw.substring(sep + 1);
            if (id.isEmpty()) return null;
            return new DecodedCursor(createdAt, id);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** 列表（键集分页，按 created_at DESC, id DESC） */
    public static ListMemoriesResult listMemories(Db db, String userId, ListMemoriesOptions options) {
        List<String> where = new ArrayList<>();
        List<Object> params = new ArrayList<>();
        where.add("user_id = $1");
        params.add(userId);

        if (options.status() != null) {
            params.add(options.status());
            where.add("status = $" + params.size());
        } else {
            where.add("status <> 'deleted'");
        }
        if (options.category() != null) {
            params.add(options.category());
            where.add("category = $" + params.size());
        }
        if (options.q() != null) {
            if (containsCjk(options.q())) {
                params.add("%" + options.q() + "%");
                where.add("(title ILIKE $" + params.size() + " OR content ILIKE $" + params.size() + ")");
            } else {
                params.add(options.q());
                where.add("to_tsvector('simple', title || ' ' || content) "
                        + "@@ websearch_to_tsquery('simple', $" + params.size() + ")");
            }
        }
        if (options.cursor() != null) {
            DecodedCursor decoded = decodeCursor(options.cursor());
            if (decoded != null) {
                params.add(decoded.createdAt());
                params.add(decoded.id());
                where.add("(created_at, id) < ($" + (params.size() - 1) + ", $" + params.size() + ")");
            }
        }

        params.add(options.limit() + 1);
        List<MemoryRow> rows = db.query(
                "SELECT " + COLUMNS + " FROM memories "
                        + "WHERE " + String.join(" AND ", where) + " "
                        + "ORDER BY created_at DESC, id DESC "
                        + "LIMIT $" + params.size(),
                params.toArray())
                .stream()
                .map(MemoriesRepository::mapRow)
                .toList();

        boolean hasMore = rows.size() > options.limit();
        List<MemoryRow> items = hasMore ? rows.subList(0, options.limit()) : rows;
        MemoryRow last = items.isEmpty() ? null : items.get(items.size() - 1);
        return new ListMemoriesResult(items, hasMore && last != null ? encodeCursor(last) : null);
    }

    /** 局部更新（只更新传入字段） */
    public static MemoryRow updateMemory(Db db, String userId, String id, MemoryPatch patch) {
        List<String> sets = new ArrayList<>();
        List<Object> params = new ArrayList<>();
        params.add(userId);
        params.add(id);

        if (patch.title() != null) {
            params.add(patch.title());
            sets.add("title = $" + params.size());
        }
        if (patch.content() != null) {
            params.add(patch.content());
            sets.add("content = $" + params.size());
        }
        if (patch.category() != null) {
            params.add(patch.category());
            sets.add("category = $" + params.size());
        }
        if (patch.assertion() != null) {
            params.add(patch.assertion());
            sets.add("assertion = $" + params.size());
        }
        if (patch.status() != null) {
            params.add(patch.status());
            sets.add("status = $" + params.size());
        }
        if (patch.hasContradictedBy()) {
            params.add(patch.contradictedBy());
            sets.add("contradicted_by = $" + params.size());
        }
        if (patch.accessCount() != null) {
            params.add(patch.accessCount());
            sets.add("access_count = $" + params.size());
        }
        if (patch.lastAccessedAt() != null) {
            params.add(patch.lastAccessedAt());
            sets.add("last_accessed_at = $" + params.size());
        }

        if (sets.isEmpty()) return getMemory(db, userId, id);

        sets.add("updated_at = now()");
        return mapRow(db.one(
                "UPDATE memories SET " + String.join(", ", sets)
                        + " WHERE user_id = $1 AND id = $2 RETURNING " + COLUMNS,
                params.toArray()));
    }

    /** 删除：默认软删除（保留墓碑，便于多端同步） */
    public static boolean deleteMemory(Db db, String userId, String id, boolean hard) {
        if (hard) {
            return db.execute("DELETE FROM memories WHERE user_id = $1 AND id = $2", userId, id) > 0;
        }
        return db.execute(
                "UPDATE memories SET status = 'deleted', updated_at = now() "
                        + "WHERE user_id = $1 AND id = $2 AND status <> 'deleted'",
                userId, id) > 0;
    }

    public static int countMemories(Db db, String userId, String status) {
        Map<String, Object> row = status != null
                ? db.one("SELECT COUNT(*)::int AS count FROM memories WHERE user_id = $1 AND status = $2",
                        userId, status)
                : db.one("SELECT COUNT(*)::int AS count FROM memories WHERE user_id = $1 AND status <> 'deleted'",
                        userId);
        Long count = Db.longOf(row, "count");
        return count == null ? 0 : count.intValue();
    }

    public record BulkUpsertResult(int created, int updated, int total) {}

    /**
     * 批量 upsert（恢复/首次上传用）。在同一事务内完成，保证原子性。
     * 通过先查已存在的 client_memory_id 来区分新增与更新（避免依赖 xmax 这类实现细节）。
     */
    public static BulkUpsertResult bulkUpsertMemories(Db db, String userId, List<MemoryInput> items) {
        return db.tx(tx -> {
            List<String> clientIds = items.stream()
                    .map(MemoryInput::clientMemoryId)
                    .filter(v -> v != null)
                    .toList();
            Set<String> existing = new HashSet<>();
            if (!clientIds.isEmpty()) {
                List<Map<String, Object>> rows = tx.query(
                        "SELECT client_memory_id FROM memories "
                                + "WHERE user_id = $1 AND client_memory_id = ANY($2::text[])",
                        userId, clientIds.toArray(new String[0]));
                for (Map<String, Object> row : rows) {
                    existing.add(Db.str(row, "client_memory_id"));
                }
            }

            int created = 0;
            int updated = 0;
            for (MemoryInput item : items) {
                boolean before = item.clientMemoryId() != null && existing.contains(item.clientMemoryId());
                upsertMemory(tx, userId, item);
                if (before) updated += 1;
                else created += 1;
            }
            return new BulkUpsertResult(created, updated, items.size());
        });
    }

    /**
     * 导出全部记忆（备份用）。
     *
     * 安全审计 SV-001：改为**键集分页循环**取全量，不再 `LIMIT 10000` 静默截断——
     * 备份是"卸载重装无损重建"的前提，隐性丢数据不可接受。键集游标 (created_at, id)
     * 避免深分页 OFFSET 的线性退化；`pageSize` 仅影响每次查询行数，不影响结果完整性。
     */
    public static List<MemoryRow> listAllMemories(Db db, String userId, int pageSize) {
        List<MemoryRow> all = new ArrayList<>();
        DecodedCursor cursor = null;
        for (;;) {
            List<MemoryRow> rows = (cursor != null
                    ? db.query(
                            "SELECT " + COLUMNS + " FROM memories "
                                    + "WHERE user_id = $1 AND (created_at, id) > ($2, $3) "
                                    + "ORDER BY created_at ASC, id ASC LIMIT $4",
                            userId, cursor.createdAt(), cursor.id(), pageSize)
                    : db.query(
                            "SELECT " + COLUMNS + " FROM memories WHERE user_id = $1 "
                                    + "ORDER BY created_at ASC, id ASC LIMIT $2",
                            userId, pageSize))
                    .stream()
                    .map(MemoriesRepository::mapRow)
                    .toList();
            all.addAll(rows);
            if (rows.size() < pageSize) return all;
            MemoryRow last = rows.get(rows.size() - 1);
            cursor = new DecodedCursor(last.createdAt(), last.id());
        }
    }

    public static List<MemoryRow> listAllMemories(Db db, String userId) {
        return listAllMemories(db, userId, EXPORT_PAGE_SIZE);
    }
}
