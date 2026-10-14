package com.civitas.server.http.validation;

import com.civitas.server.json.Json;
import com.civitas.server.services.BackupService;
import com.civitas.server.services.MemoryService;
import com.civitas.server.services.SettingsService;
import com.civitas.server.util.JsNumber;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;

/**
 * 备份 / 恢复请求的校验 —— 与 TS 版 `src/http/schemas.ts` 的 backup 段对位。
 *
 * 说明：
 *  - `includeStats`/`statsLimit` 走 transform + refine（自定义文案），语义手工对位；
 *  - `backupBundleSchema` 的字段级默认值（settings→null、memories→[]、tasks→[]、
 *    stats→null、元素内 title→''、archivedAt→null、accessCount→0）在这里就地展开。
 */
public final class BackupBodies {
    private BackupBodies() {}

    public record ExportQuery(boolean includeStats, Integer statsLimit) {}

    public record RestoreBody(BackupService.BackupBundle bundle, String mode) {}

    // ── 导出查询（GET /v1/backup）──────────────────────────────────────

    public static ExportQuery exportQuery(JsonNode query) {
        Validator.Obj v = Validator.object(query, "query");

        // includeStats: union(string, boolean).optional().transform(v => v === true || v === 'true' || v === '1')
        JsonNode includeRaw = rawOf(query, "includeStats");
        boolean includeStats = includeRaw != null
                && ((includeRaw.isBoolean() && includeRaw.booleanValue())
                || (includeRaw.isTextual()
                && ("true".equals(includeRaw.textValue()) || "1".equals(includeRaw.textValue()))));

        // statsLimit：缺省/空串 → 不设限；否则 Number(v)，必须是 1..100000 的整数（自定义文案）
        Integer statsLimit = null;
        boolean statsLimitInvalid = false;
        JsonNode limitRaw = rawOf(query, "statsLimit");
        if (limitRaw == null || (limitRaw.isTextual() && limitRaw.textValue().isEmpty())) {
            // 缺省即全量导出
        } else if (limitRaw.isNumber()) {
            double value = limitRaw.doubleValue();
            if (value % 1 == 0 && value > 0 && value <= 100_000) statsLimit = (int) value;
            else statsLimitInvalid = true;
        } else if (limitRaw.isTextual()) {
            double value = JsNumber.parse(limitRaw.textValue());
            if (Double.isFinite(value) && value % 1 == 0 && value > 0 && value <= 100_000) statsLimit = (int) value;
            else statsLimitInvalid = true;
        } else {
            statsLimitInvalid = true;
        }
        if (statsLimitInvalid) v.addIssue("statsLimit", "statsLimit 必须是 1..100000 的整数", "custom");

        v.finish();
        return new ExportQuery(includeStats, statsLimit);
    }

    private static JsonNode rawOf(JsonNode query, String name) {
        if (query == null || !query.isObject()) return null;
        JsonNode value = query.get(name);
        return value == null || value.isMissingNode() ? null : value;
    }

    // ── 恢复（POST /v1/restore）────────────────────────────────────────

    public static RestoreBody restore(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        JsonNode bundleNode = body != null && body.isObject() ? body.get("bundle") : null;
        if (bundleNode != null && bundleNode.isMissingNode()) bundleNode = null;

        BackupService.BackupBundle bundle = parseBundle(v.child(bundleNode, "bundle"));
        // mode: z.enum(['replace','merge']).default('merge')
        String mode = v.field("mode").defaultTo("merge").enumOf("replace", "merge").text();
        v.finish();
        return new RestoreBody(bundle, mode);
    }

    /** backupBundleSchema 的字段（校验失败时 finish() 抛 400，兜底值不生效） */
    private static BackupService.BackupBundle parseBundle(Validator.Obj b) {
        // format: z.literal('civitas.backup') —— 任何不匹配（含缺省）都是 invalid_literal
        JsonNode formatRaw = b.field("format").raw();
        if (formatRaw == null || !formatRaw.isTextual()
                || !BackupService.BACKUP_FORMAT.equals(formatRaw.textValue())) {
            b.addIssue("format",
                    "Invalid literal value, expected \"" + BackupService.BACKUP_FORMAT + "\"",
                    "invalid_literal");
        }
        Double version = b.field("version").num().integer().minNumber(1, null).number();
        String exportedAt = b.field("exportedAt").str().text();
        parseAccount(b);
        SettingsService.SettingsDto settings = parseSettings(b);
        List<MemoryService.MemoryDto> memories = parseMemories(b);
        List<BackupService.BackupTaskDto> tasks = parseTasks(b);
        BackupService.BackupStats stats = parseStats(b);
        return new BackupService.BackupBundle(
                BackupService.BACKUP_FORMAT,
                version == null ? 0 : version.intValue(),
                exportedAt,
                null,
                settings,
                memories,
                tasks,
                stats,
                null);
    }

    /** account 仅做结构校验（恢复时以当前登录账号为准，不用于身份判定） */
    private static void parseAccount(Validator.Obj b) {
        JsonNode accountRaw = b.field("account").raw();
        if (accountRaw == null) return;
        Validator.Obj account = b.child(accountRaw, "account");
        account.field("email").str();
        account.field("displayName").nullable().str();
    }

    private static SettingsService.SettingsDto parseSettings(Validator.Obj b) {
        JsonNode settingsRaw = b.field("settings").raw();
        if (settingsRaw == null || settingsRaw.isNull()) return null;
        Validator.Obj s = b.child(settingsRaw, "settings");
        Double revision = s.field("revision").num().integer().minNumber(0, null).number();
        JsonNode data = s.field("data").record().object();
        String updatedAt = s.field("updatedAt").str().text();
        return new SettingsService.SettingsDto(
                revision == null ? 0 : revision.intValue(),
                data != null && data.isObject() ? (ObjectNode) data : Json.MAPPER.createObjectNode(),
                updatedAt);
    }

    private static List<MemoryService.MemoryDto> parseMemories(Validator.Obj b) {
        List<MemoryService.MemoryDto> memories = new ArrayList<>();
        JsonNode memoriesRaw = b.field("memories").raw();
        if (memoriesRaw == null) return memories; // z.array(...).default([])
        Validator.Field arr = b.field("memories").array();
        if (arr.arrayNode() != null) {
            List<JsonNode> elements = new ArrayList<>();
            arr.arrayNode().forEach(elements::add);
            for (int i = 0; i < elements.size(); i++) {
                memories.add(parseBackupMemory(b.child(elements.get(i), "memories." + i)));
            }
        }
        return memories;
    }

    /** backupMemorySchema 的字段（与 export 的 MemoryDto 形状一致） */
    private static MemoryService.MemoryDto parseBackupMemory(Validator.Obj m) {
        String id = m.field("id").str().minLen(1, null).text();
        String clientMemoryId = m.field("clientMemoryId").nullable().str().text();
        String title = m.field("title").str().minLen(1, null).text();
        String content = m.field("content").str().text();
        String category = m.field("category").str().text();
        String assertion = m.field("assertion")
                .enumOf("observed", "inferred", "verified", "disputed").text();
        String status = m.field("status").enumOf("active", "archived", "deleted").text();
        String contradictedBy = m.field("contradictedBy").nullable().str().text();

        JsonNode traceIdsRaw = m.field("sourceTraceIds").raw();
        JsonNode sourceTraceIds = traceIdsRaw == null
                ? Json.MAPPER.createArrayNode() // z.array(z.unknown()).default([])
                : m.field("sourceTraceIds").array().arrayNode();
        JsonNode sourceArbitrationIds =
                m.field("sourceArbitrationIds").nullable().array().arrayNode();

        JsonNode accessRaw = m.field("accessCount").raw();
        Integer accessCount = accessRaw == null
                ? 0 // 对位 z.number().int().min(0).default(0)
                : m.field("accessCount").num().integer().minNumber(0, null).intValue();
        String createdAt = m.field("createdAt").str().text();
        String lastAccessedAt = m.field("lastAccessedAt").str().text();
        String updatedAt = m.field("updatedAt").str().text();
        return new MemoryService.MemoryDto(
                id, clientMemoryId, title, content, category, assertion, status, contradictedBy,
                sourceTraceIds != null ? sourceTraceIds : Json.MAPPER.createArrayNode(),
                sourceArbitrationIds,
                accessCount == null ? 0 : accessCount,
                createdAt, lastAccessedAt, updatedAt);
    }

    private static List<BackupService.BackupTaskDto> parseTasks(Validator.Obj b) {
        List<BackupService.BackupTaskDto> tasks = new ArrayList<>();
        JsonNode tasksRaw = b.field("tasks").raw();
        if (tasksRaw == null) return tasks; // z.array(...).optional().default([])
        Validator.Field arr = b.field("tasks").array();
        if (arr.arrayNode() != null) {
            List<JsonNode> elements = new ArrayList<>();
            arr.arrayNode().forEach(elements::add);
            for (int i = 0; i < elements.size(); i++) {
                Validator.Obj t = b.child(elements.get(i), "tasks." + i);
                String clientSessionId = t.field("clientSessionId").str().minLen(1, null).text();
                JsonNode titleRaw = t.field("title").raw();
                String title = titleRaw == null ? "" : t.field("title").str().text(); // default('')
                Double createdAt = t.field("createdAt").num().integer().minNumber(0, null).number();
                Double updatedAt = t.field("updatedAt").num().integer().minNumber(0, null).number();
                Long archivedAt = null;
                if (t.field("archivedAt").raw() != null) {
                    Double value = t.field("archivedAt").nullable().num().integer().minNumber(0, null).number();
                    archivedAt = value == null ? null : value.longValue();
                }
                tasks.add(new BackupService.BackupTaskDto(
                        clientSessionId,
                        title,
                        createdAt == null ? 0 : createdAt.longValue(),
                        updatedAt == null ? 0 : updatedAt.longValue(),
                        archivedAt));
            }
        }
        return tasks;
    }

    private static BackupService.BackupStats parseStats(Validator.Obj b) {
        JsonNode statsRaw = b.field("stats").raw();
        if (statsRaw == null || statsRaw.isNull()) return null;
        Validator.Obj s = b.child(statsRaw, "stats");
        Validator.Field eventsField = s.field("events").array();
        List<BackupService.BackupStatEvent> events = new ArrayList<>();
        if (eventsField.arrayNode() != null) {
            List<JsonNode> elements = new ArrayList<>();
            eventsField.arrayNode().forEach(elements::add);
            for (int i = 0; i < elements.size(); i++) {
                Validator.Obj e = s.child(elements.get(i), "events." + i);
                String kind = e.field("kind").str().text();
                Double value = e.field("value").num().number();
                String occurredAt = e.field("occurredAt").str().text();
                String clientEventId = e.field("clientEventId").nullable().str().text();
                JsonNode meta = e.field("meta").nullable().record().object();
                events.add(new BackupService.BackupStatEvent(
                        kind, value == null ? 0 : value, occurredAt, clientEventId, meta));
            }
        }
        return new BackupService.BackupStats(events);
    }
}
