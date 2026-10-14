package com.civitas.server.http.validation;

import com.civitas.server.repositories.MemoriesRepository.MemoryInput;
import com.civitas.server.repositories.MemoriesRepository.MemoryPatch;
import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * 记忆相关请求体/查询串校验 —— 与 TS 版 `src/http/schemas.ts` 的 memory 段对位。
 *
 * memoryUpdateSchema = memoryCreateSchema.omit({clientMemoryId}).partial()：
 * 字段与新建相同、全部可选；校验通过后仅取更新补丁实际支持的字段（createdAt 等只校验不生效）。
 */
public final class MemoryBodies {
    private MemoryBodies() {}

    public record ListQuery(int limit, String cursor, String category, String status, String q) {}

    public record BulkBody(List<MemoryInput> items) {}

    private static final String ISO_MESSAGE = "需为 ISO 8601 时间（含时区）";

    // ── 新建（POST /v1/memories 与批量元素共用）──────────────────────────

    public static MemoryInput create(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        MemoryInput input = createFields(v);
        v.finish();
        return input;
    }

    public static BulkBody bulk(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        Validator.Field items = v.field("items").array().minItems(1, "items 不能为空");
        List<MemoryInput> inputs = new ArrayList<>();
        if (items.arrayNode() != null) {
            List<JsonNode> elements = new ArrayList<>();
            items.arrayNode().forEach(elements::add);
            for (int i = 0; i < elements.size(); i++) {
                Validator.Obj item = v.child(elements.get(i), "items." + i);
                inputs.add(createFields(item));
            }
        }
        v.finish();
        return new BulkBody(inputs);
    }

    /** memoryCreateSchema 的字段（校验失败时 finish() 抛 400，兜底值不生效） */
    private static MemoryInput createFields(Validator.Obj v) {
        String clientMemoryId = v.field("clientMemoryId").nullish().str().trim().maxLen(128, null).text();
        String title = v.field("title").str().trim().minLen(1, "标题必填").maxLen(500, null).text();
        String content = v.field("content").str().minLen(1, "内容必填").maxLen(200_000, null).text();
        String category = v.field("category").optional().str().trim().minLen(1, null).maxLen(64, null).text();
        String assertion = v.field("assertion").optional()
                .enumOf("observed", "inferred", "verified", "disputed").text();
        JsonNode sourceTraceIds = v.field("sourceTraceIds").optional().array().arrayNode();
        JsonNode sourceArbitrationIds = v.field("sourceArbitrationIds").nullish().array().arrayNode();
        String status = v.field("status").optional().enumOf("active", "archived", "deleted").text();
        String contradictedBy = v.field("contradictedBy").nullish().str().trim().maxLen(200, null).text();
        Integer accessCount = v.field("accessCount").optional().num().integer().minNumber(0, null).intValue();
        Instant createdAt = v.field("createdAt").optional().str().isoDateTime(ISO_MESSAGE).instant();
        Instant lastAccessedAt = v.field("lastAccessedAt").optional().str().isoDateTime(ISO_MESSAGE).instant();
        return new MemoryInput(clientMemoryId, title, content, category, assertion, sourceTraceIds,
                sourceArbitrationIds, status, contradictedBy, accessCount, createdAt, lastAccessedAt);
    }

    // ── 更新（PATCH /v1/memories/:id）───────────────────────────────────

    public static MemoryPatch update(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        String title = v.field("title").optional().str().trim().minLen(1, "标题必填").maxLen(500, null).text();
        String content = v.field("content").optional().str().minLen(1, "内容必填").maxLen(200_000, null).text();
        String category = v.field("category").optional().str().trim().minLen(1, null).maxLen(64, null).text();
        String assertion = v.field("assertion").optional()
                .enumOf("observed", "inferred", "verified", "disputed").text();
        v.field("sourceTraceIds").optional().array();
        v.field("sourceArbitrationIds").nullish().array();
        String status = v.field("status").optional().enumOf("active", "archived", "deleted").text();
        boolean hasContradictedBy = v.has("contradictedBy");
        String contradictedBy = v.field("contradictedBy").nullish().str().trim().maxLen(200, null).text();
        Integer accessCount = v.field("accessCount").optional().num().integer().minNumber(0, null).intValue();
        v.field("createdAt").optional().str().isoDateTime(ISO_MESSAGE);
        Instant lastAccessedAt = v.field("lastAccessedAt").optional().str().isoDateTime(ISO_MESSAGE).instant();
        v.finish();
        return new MemoryPatch(title, content, category, assertion, status,
                hasContradictedBy, contradictedBy, accessCount, lastAccessedAt);
    }

    // ── 列表查询（GET /v1/memories）─────────────────────────────────────

    /** memoryListQuerySchema = paginationSchema.extend({category, status, q}) */
    public static ListQuery listQuery(JsonNode query) {
        Validator.Obj v = Validator.object(query, "query");
        Double limit = v.field("limit").defaultTo(50).numCoerced()
                .integer().minNumber(1, null).maxNumber(200, null).number();
        String cursor = v.field("cursor").optional().str().maxLen(200, null).text();
        String category = v.field("category").optional().str().trim().maxLen(64, null).text();
        String status = v.field("status").optional().enumOf("active", "archived", "deleted").text();
        String q = v.field("q").optional().str().trim().minLen(1, null).maxLen(200, null).text();
        v.finish();
        return new ListQuery((int) Math.floor(limit), cursor, category, status, q);
    }
}
