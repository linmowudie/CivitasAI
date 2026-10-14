package com.civitas.server.http.validation;

import com.civitas.server.json.Json;
import com.civitas.server.services.A2aService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;

/**
 * A2A 镜像相关请求的校验 —— 与 TS 版 `src/http/schemas.ts` 的 A2A 段对位。
 *
 * 说明：zod 默认 strip 未知键；嵌套对象（memoryRefs/lineage 元素）按原 schema 逐字段校验，
 * 输出仅保留 schema 声明字段（与 zod 的输出形状一致）。
 */
public final class A2aBodies {
    private A2aBodies() {}

    public record MessageBulkBody(List<A2aService.A2aMessageInputDto> items) {}

    public record CardBulkBody(List<A2aService.A2aCardInputDto> items) {}

    /** 缺失即 null（对位 TS 的可选字段）；since/limit 为 null 表示未提供 */
    public record ListQuery(String taskId, String agentId, Long since, Integer limit, String cursor) {}

    // ── POST /v1/a2a/messages/bulk ─────────────────────────────────────

    public static MessageBulkBody messageBulk(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        Validator.Field items = v.field("items").array()
                .minItems(1, "items 不能为空")
                .maxItems(500, "单批最多 500 条");
        List<A2aService.A2aMessageInputDto> inputs = new ArrayList<>();
        if (items.arrayNode() != null) {
            List<JsonNode> elements = new ArrayList<>();
            items.arrayNode().forEach(elements::add);
            for (int i = 0; i < elements.size(); i++) {
                Validator.Obj item = v.child(elements.get(i), "items." + i);
                inputs.add(messageFields(item));
            }
        }
        v.finish();
        return new MessageBulkBody(inputs);
    }

    /** a2aMessageUpsertSchema 的字段 */
    private static A2aService.A2aMessageInputDto messageFields(Validator.Obj v) {
        String messageId = v.field("messageId").str().minLen(1, null).maxLen(200, null).text();
        String taskId = v.field("taskId").str().minLen(1, null).maxLen(200, null).text();
        String traceId = v.field("traceId").str().minLen(1, null).maxLen(200, null).text();
        String kind = v.field("kind").str().minLen(1, null).maxLen(40, null).text();
        String sourceAgentId = v.field("sourceAgentId").str().minLen(1, null).maxLen(200, null).text();
        String targetAgentId = v.field("targetAgentId").str().minLen(1, null).maxLen(200, null).text();
        String parentMessageId = v.field("parentMessageId").optional().str().maxLen(200, null).text();
        String correlationId = v.field("correlationId").optional().str().maxLen(200, null).text();
        String visibility = v.field("visibility").enumOf("public", "domain", "private").text();
        String contentHash = v.field("contentHash").str().minLen(1, null).maxLen(128, null).text();
        String prevHash = v.field("prevHash").nullable().optional().str().maxLen(128, null).text();
        JsonNode payload = v.field("payload").optional().record().object();
        String summary = v.field("summary").optional().str().maxLen(4000, null).text();
        String verdict = v.field("verdict").enumOf("allow", "block", "quarantine", "redirect").text();
        String blockReason = v.field("blockReason").optional().str().maxLen(2000, null).text();
        String priority = v.field("priority").optional().enumOf("low", "normal", "high", "critical").text();
        JsonNode memoryRefs = parseMemoryRefs(v);
        JsonNode redactedFields = parseRedactedFields(v);
        Double createdAt = v.field("createdAt").num().integer().minNumber(0, null).number();
        return new A2aService.A2aMessageInputDto(
                messageId, taskId, traceId, kind, sourceAgentId, targetAgentId,
                parentMessageId, correlationId, visibility, contentHash, prevHash,
                payload, summary, verdict, blockReason, priority,
                memoryRefs, redactedFields, createdAt == null ? 0 : createdAt.longValue());
    }

    /** `z.array(a2aMemoryRefSchema).max(50)`：仅保留 key/version 两个字段 */
    private static JsonNode parseMemoryRefs(Validator.Obj v) {
        Validator.Field refs = v.field("memoryRefs").optional().array().maxItems(50, null);
        if (refs.arrayNode() == null) return null;
        ArrayNode out = Json.MAPPER.createArrayNode();
        List<JsonNode> elements = new ArrayList<>();
        refs.arrayNode().forEach(elements::add);
        for (int i = 0; i < elements.size(); i++) {
            Validator.Obj ref = v.child(elements.get(i), "memoryRefs." + i);
            String key = ref.field("key").str().minLen(1, null).maxLen(300, null).text();
            Double version = ref.field("version").num().integer().minNumber(0, null).number();
            if (key != null && version != null) {
                ObjectNode node = Json.MAPPER.createObjectNode();
                node.put("key", key);
                node.put("version", version.longValue());
                out.add(node);
            }
        }
        return out;
    }

    /** `z.array(z.string().max(300)).max(200)` */
    private static JsonNode parseRedactedFields(Validator.Obj v) {
        Validator.Field fields = v.field("redactedFields").optional().array().maxItems(200, null);
        if (fields.arrayNode() == null) return null;
        ArrayNode out = Json.MAPPER.createArrayNode();
        List<JsonNode> elements = new ArrayList<>();
        fields.arrayNode().forEach(elements::add);
        for (int i = 0; i < elements.size(); i++) {
            String value = v.fieldAt("redactedFields." + i, elements.get(i)).str().maxLen(300, null).text();
            if (value != null) out.add(value);
        }
        return out;
    }

    // ── POST /v1/a2a/cards/bulk ────────────────────────────────────────

    public static CardBulkBody cardBulk(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        Validator.Field items = v.field("items").array()
                .minItems(1, "items 不能为空")
                .maxItems(500, "单批最多 500 条");
        List<A2aService.A2aCardInputDto> inputs = new ArrayList<>();
        if (items.arrayNode() != null) {
            List<JsonNode> elements = new ArrayList<>();
            items.arrayNode().forEach(elements::add);
            for (int i = 0; i < elements.size(); i++) {
                Validator.Obj item = v.child(elements.get(i), "items." + i);
                inputs.add(cardFields(item));
            }
        }
        v.finish();
        return new CardBulkBody(inputs);
    }

    /** a2aCardUpsertSchema 的字段 */
    private static A2aService.A2aCardInputDto cardFields(Validator.Obj v) {
        String cardId = v.field("cardId").str().minLen(1, null).maxLen(200, null).text();
        String agentId = v.field("agentId").str().minLen(1, null).maxLen(200, null).text();
        Double cardVersion = v.field("cardVersion").num().integer().positive().number();
        String role = v.field("role").str().minLen(1, null).maxLen(60, null).text();
        Double createTime = v.field("createTime").num().integer().minNumber(0, null).number();
        String fatherAgentId = v.field("fatherAgentId").nullable().optional().str().maxLen(200, null).text();
        String fatherRole = v.field("fatherRole").nullable().optional().str().maxLen(60, null).text();
        JsonNode lineage = parseLineage(v);
        String status = v.field("status").str().minLen(1, null).maxLen(40, null).text();
        JsonNode health = v.field("health").optional().record().object();
        JsonNode ability = v.field("ability").optional().record().object();
        JsonNode permission = v.field("permission").optional().record().object();
        String fingerprint = v.field("fingerprint").str().minLen(1, null).maxLen(128, null).text();
        Double expiresAt = v.field("expiresAt").num().integer().minNumber(0, null).number();
        return new A2aService.A2aCardInputDto(
                cardId, agentId,
                cardVersion == null ? 0 : (int) Math.floor(cardVersion),
                role,
                createTime == null ? 0 : createTime.longValue(),
                fatherAgentId, fatherRole, lineage, status,
                health, ability, permission, fingerprint,
                expiresAt == null ? 0 : expiresAt.longValue());
    }

    /** `z.array(z.string().max(200)).max(50)` */
    private static JsonNode parseLineage(Validator.Obj v) {
        Validator.Field lineage = v.field("lineage").optional().array().maxItems(50, null);
        if (lineage.arrayNode() == null) return null;
        ArrayNode out = Json.MAPPER.createArrayNode();
        List<JsonNode> elements = new ArrayList<>();
        lineage.arrayNode().forEach(elements::add);
        for (int i = 0; i < elements.size(); i++) {
            String value = v.fieldAt("lineage." + i, elements.get(i)).str().maxLen(200, null).text();
            if (value != null) out.add(value);
        }
        return out;
    }

    // ── GET /v1/a2a/messages ───────────────────────────────────────────

    public static ListQuery listQuery(JsonNode query) {
        Validator.Obj v = Validator.object(query, "query");
        String taskId = v.field("taskId").optional().str().maxLen(200, null).text();
        String agentId = v.field("agentId").optional().str().maxLen(200, null).text();
        Double since = v.field("since").optional().numCoerced().integer().minNumber(0, null).number();
        Double limit = v.field("limit").optional().numCoerced().integer()
                .minNumber(1, null).maxNumber(500, null).number();
        String cursor = v.field("cursor").optional().str().maxLen(600, null).text();
        v.finish();
        return new ListQuery(
                taskId, agentId,
                since == null ? null : since.longValue(),
                limit == null ? null : limit.intValue(),
                cursor);
    }
}
