package com.civitas.server.services;

import com.civitas.server.db.Db;
import com.civitas.server.json.Json;
import com.civitas.server.repositories.A2aRepository;
import com.civitas.server.util.JsNumber;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A2A 镜像服务（P0c）—— 与 TS 版 `src/services/a2aService.ts` 对位。
 *
 * 三条硬规则：
 *  1. **本机权威**：服务端只镜像，不产生 verdict/签名；拉回时不会反向覆盖本机判定；
 *  2. **脱敏**：客户端应上传前脱敏；服务端再做**防御性扫描**（密钥/令牌模式 → 替换 + 记录字段路径）；
 *  3. **限额**：单条载荷 ≤ 64KB，超出则截断并置 `truncated=true`（保留 `contentHash` 供本机校验）。
 *
 * 刻意不做：告警证据正文、`signature` 的存储与验签（见 Q6）。
 */
public final class A2aService {
    /** 单条载荷上限（序列化后字节） */
    public static final int MAX_PAYLOAD_BYTES = 64 * 1024;

    private final Db db;

    public A2aService(Db db) {
        this.db = db;
    }

    public record A2aMessageInputDto(
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
            long createdAt) {}

    public record A2aMessageDto(
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

    public record A2aCardInputDto(
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

    public record UpsertMessagesResult(int created, int updated, int total, int redacted, int truncated) {}

    public record ListMessagesResult(List<A2aMessageDto> items, String nextCursor, int total) {}

    public record UpsertCardsResult(int created, int updated, int total) {}

    // ── 防御性脱敏 ─────────────────────────────────────────────────────

    /** 常见密钥/令牌模式（防御性扫描；命中即替换为占位符） */
    private static final List<Pattern> SECRET_PATTERNS = List.of(
            Pattern.compile("\\bsk-[A-Za-z0-9_-]{16,}\\b"),
            Pattern.compile("\\bBearer\\s+[A-Za-z0-9._-]{16,}\\b"),
            Pattern.compile("\\bAKIA[0-9A-Z]{12,}\\b"),
            Pattern.compile("\\bgh[pousr]_[A-Za-z0-9]{20,}\\b"),
            Pattern.compile("\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b"));

    /** 键名本身也可能是敏感标记（如 token/password 字段）→ 直接替换值 */
    private static final Pattern SECRET_KEY =
            Pattern.compile("^(token|password|secret|api[_-]?key|authorization)$", Pattern.CASE_INSENSITIVE);

    public record RedactResult(JsonNode value, List<String> redactedFields) {}

    /** 递归脱敏（返回替换后的值与被改动的字段路径） */
    public static RedactResult redactSecrets(JsonNode value) {
        List<String> out = new ArrayList<>();
        return new RedactResult(redactNode(value, "$", out), out);
    }

    private static JsonNode redactNode(JsonNode value, String path, List<String> out) {
        if (value == null || value.isNull()) return value;
        if (value.isTextual()) {
            String next = value.textValue();
            boolean matched = false;
            for (Pattern pattern : SECRET_PATTERNS) {
                Matcher matcher = pattern.matcher(next);
                if (matcher.find()) {
                    next = matcher.replaceAll("«redacted:secret»");
                    matched = true;
                }
            }
            if (matched && !out.contains(path)) out.add(path);
            return Json.MAPPER.getNodeFactory().textNode(next);
        }
        if (value.isArray()) {
            ArrayNode array = Json.MAPPER.createArrayNode();
            int index = 0;
            for (JsonNode element : value) {
                array.add(redactNode(element, path + "[" + index + "]", out));
                index += 1;
            }
            return array;
        }
        if (value.isObject()) {
            ObjectNode obj = Json.MAPPER.createObjectNode();
            Iterator<Map.Entry<String, JsonNode>> fields = value.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> entry = fields.next();
                String key = entry.getKey();
                if (SECRET_KEY.matcher(key).matches()) {
                    obj.put(key, "«redacted:secret»");
                    String keyPath = path + "." + key;
                    if (!out.contains(keyPath)) out.add(keyPath);
                    continue;
                }
                obj.set(key, redactNode(entry.getValue(), path + "." + key, out));
            }
            return obj;
        }
        return value;
    }

    // ── 游标（base64url 编码 `createdAt|messageId`）─────────────────────

    private static String encodeCursor(long createdAt, String messageId) {
        String raw = createdAt + "|" + messageId;
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    public static A2aRepository.Cursor decodeCursor(String cursor) {
        try {
            String raw = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
            int separator = raw.indexOf('|');
            if (separator < 0) return null;
            String createdAtText = raw.substring(0, separator);
            String messageId = raw.substring(separator + 1);
            double createdAt = JsNumber.parse(createdAtText);
            if (!Double.isFinite(createdAt) || messageId.isEmpty()) return null;
            return new A2aRepository.Cursor(createdAt, messageId);
        } catch (RuntimeException e) {
            return null;
        }
    }

    public static A2aMessageDto toA2aMessageDto(A2aRepository.A2aMessageRow row) {
        return new A2aMessageDto(
                row.messageId(), row.taskId(), row.traceId(), row.kind(),
                row.sourceAgentId(), row.targetAgentId(), row.parentMessageId(), row.correlationId(),
                row.visibility(), row.contentHash(), row.prevHash(), row.payloadJson(),
                row.summary(), row.verdict(), row.blockReason(), row.priority(),
                row.memoryRefsJson(),
                row.redactedFields() != null && row.redactedFields().isArray()
                        ? row.redactedFields()
                        : Json.MAPPER.createArrayNode(),
                row.truncated(), row.createdAt());
    }

    // ── 业务 ───────────────────────────────────────────────────────────

    public UpsertMessagesResult upsertMessages(String userId, List<A2aMessageInputDto> items) {
        int redactedCount = 0;
        int truncatedCount = 0;
        List<A2aRepository.A2aMessageInsert> prepared = new ArrayList<>();
        for (A2aMessageInputDto it : items) {
            List<String> declared = new ArrayList<>();
            if (it.redactedFields() != null && it.redactedFields().isArray()) {
                for (JsonNode field : it.redactedFields()) declared.add(field.asText());
            }
            RedactResult redacted = redactSecrets(it.payload() != null ? it.payload() : Json.MAPPER.createObjectNode());
            List<String> serverRedacted = redacted.redactedFields().stream()
                    .filter(f -> !declared.contains(f))
                    .toList();
            if (!serverRedacted.isEmpty()) redactedCount += 1;
            declared.addAll(serverRedacted);

            JsonNode payload = redacted.value();
            boolean truncated = false;
            int size = byteLength(payload != null ? payload : Json.MAPPER.createObjectNode());
            if (size > MAX_PAYLOAD_BYTES) {
                // 截断但**保留 contentHash**（本机据此校验，不作正文权威）
                ObjectNode marker = Json.MAPPER.createObjectNode();
                marker.put("__truncated", true);
                marker.put("originalBytes", size);
                payload = marker;
                truncated = true;
                truncatedCount += 1;
            }

            ArrayNode declaredNode = Json.MAPPER.createArrayNode();
            declared.forEach(declaredNode::add);
            prepared.add(new A2aRepository.A2aMessageInsert(
                    it.messageId(), it.taskId(), it.traceId(), it.kind(),
                    it.sourceAgentId(), it.targetAgentId(), it.parentMessageId(), it.correlationId(),
                    it.visibility(), it.contentHash(), it.prevHash(), payload, it.summary(),
                    it.verdict(), it.blockReason(),
                    it.priority() != null ? it.priority() : "normal",
                    it.memoryRefs() != null ? it.memoryRefs() : Json.MAPPER.createArrayNode(),
                    declaredNode, truncated, it.createdAt()));
        }

        A2aRepository.CreatedUpdated result = A2aRepository.upsertMessages(db, userId, prepared);
        return new UpsertMessagesResult(
                result.created(), result.updated(), prepared.size(), redactedCount, truncatedCount);
    }

    public ListMessagesResult listMessages(
            String userId, String taskId, String agentId, Long since, Integer limit, String cursor) {
        int effective = Math.min(Math.max(limit != null ? limit : 200, 1), 500);
        A2aRepository.Cursor decoded =
                cursor != null && !cursor.isEmpty() ? decodeCursor(cursor) : null;
        List<A2aRepository.A2aMessageRow> rows = A2aRepository.listMessages(db, userId,
                new A2aRepository.ListMessagesOptions(
                        taskId == null || taskId.isEmpty() ? null : taskId,
                        agentId == null || agentId.isEmpty() ? null : agentId,
                        since,
                        effective,
                        decoded));
        List<A2aMessageDto> items = rows.stream().map(A2aService::toA2aMessageDto).toList();
        A2aRepository.A2aMessageRow last = rows.isEmpty() ? null : rows.get(rows.size() - 1);
        String nextCursor = rows.size() == effective && last != null
                ? encodeCursor(last.createdAt(), last.messageId())
                : null;
        return new ListMessagesResult(items, nextCursor, items.size());
    }

    public UpsertCardsResult upsertCards(String userId, List<A2aCardInputDto> items) {
        A2aRepository.CreatedUpdated result = A2aRepository.upsertCards(
                db,
                userId,
                items.stream()
                        .map(c -> new A2aRepository.A2aCardInsert(
                                c.cardId(), c.agentId(), c.cardVersion(), c.role(), c.createTime(),
                                c.fatherAgentId(), c.fatherRole(),
                                c.lineage() != null ? c.lineage() : Json.MAPPER.createArrayNode(),
                                c.status(),
                                c.health() != null ? c.health() : Json.MAPPER.createObjectNode(),
                                c.ability() != null ? c.ability() : Json.MAPPER.createObjectNode(),
                                c.permission() != null ? c.permission() : Json.MAPPER.createObjectNode(),
                                c.fingerprint(), c.expiresAt()))
                        .toList());
        return new UpsertCardsResult(result.created(), result.updated(), items.size());
    }

    /** 对位 TS：`Buffer.byteLength(JSON.stringify(value), 'utf8')` */
    private static int byteLength(JsonNode value) {
        try {
            return Json.MAPPER.writeValueAsString(value).getBytes(StandardCharsets.UTF_8).length;
        } catch (Exception e) {
            throw new IllegalStateException("载荷序列化失败", e);
        }
    }
}
