package com.civitas.server.repositories;

import com.civitas.server.db.Db;
import com.civitas.server.http.Errors;
import com.civitas.server.json.Json;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.util.Iterator;
import java.util.Map;

/**
 * 用户设置读写（服务端为权威源，revision 单调递增做乐观并发）
 * —— 与 TS 版 `src/repositories/settings.ts` 对位。
 */
public final class SettingsRepository {
    private SettingsRepository() {}

    private static final String COLUMNS = "user_id, revision, data, updated_at";

    public record SettingsRow(String userId, int revision, ObjectNode data, Instant updatedAt) {}

    private static SettingsRow map(Map<String, Object> row) {
        if (row == null) return null;
        Long revision = Db.longOf(row, "revision");
        return new SettingsRow(
                Db.str(row, "user_id"),
                revision == null ? 0 : revision.intValue(),
                parseData(Db.str(row, "data")),
                Db.instantOf(row, "updated_at"));
    }

    /** jsonb 读出为字符串 → 转回对象（与 TS 版 pg 的 JSON 解析行为对位） */
    private static ObjectNode parseData(String raw) {
        if (raw == null || raw.isEmpty()) return Json.MAPPER.createObjectNode();
        try {
            JsonNode parsed = Json.MAPPER.readTree(raw);
            return parsed != null && parsed.isObject() ? (ObjectNode) parsed : Json.MAPPER.createObjectNode();
        } catch (Exception e) {
            throw new IllegalStateException("设置数据解析失败", e);
        }
    }

    public static SettingsRow getSettings(Db db, String userId) {
        return map(db.one("SELECT " + COLUMNS + " FROM user_settings WHERE user_id = $1", userId));
    }

    /**
     * 写入设置（整体替换 data）。
     *
     * @param expectedRevision 传入时做乐观并发校验：与当前 revision 不一致则抛 REVISION_MISMATCH
     *                         （无记录时当前版本视为 0）
     */
    public static SettingsRow putSettings(Db db, String userId, ObjectNode data, Long expectedRevision) {
        return db.tx(tx -> {
            SettingsRow current = getSettings(tx, userId);
            int currentRevision = current == null ? 0 : current.revision();

            if (expectedRevision != null && expectedRevision != currentRevision) {
                throw Errors.revisionMismatch(currentRevision);
            }

            if (current == null) {
                Map<String, Object> inserted = tx.one(
                        "INSERT INTO user_settings (user_id, revision, data) VALUES ($1, 1, $2) RETURNING " + COLUMNS,
                        userId, data);
                if (inserted == null) throw new IllegalStateException("设置写入失败");
                return map(inserted);
            }

            Map<String, Object> updated = tx.one(
                    "UPDATE user_settings SET data = $2, revision = revision + 1, updated_at = now() "
                            + "WHERE user_id = $1 RETURNING " + COLUMNS,
                    userId, data);
            if (updated == null) throw new IllegalStateException("设置更新失败");
            return map(updated);
        });
    }

    /**
     * 浅合并（PATCH 语义）：只覆盖传入的顶层键。
     * `null` 值表示删除该键（便于客户端清理设置项）。
     */
    public static SettingsRow patchSettings(Db db, String userId, ObjectNode patch, Long expectedRevision) {
        SettingsRow current = getSettings(db, userId);
        return putSettings(db, userId, merge(current == null ? null : current.data(), patch), expectedRevision);
    }

    /** 合并：现有键保持顺序，新键追加；patch 中值为 null 的键删除 —— 对位 JS 展开 + delete */
    public static ObjectNode merge(JsonNode base, JsonNode patch) {
        ObjectNode merged = base != null && base.isObject()
                ? ((ObjectNode) base).deepCopy()
                : Json.MAPPER.createObjectNode();
        if (patch != null && patch.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> fields = patch.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> entry = fields.next();
                if (entry.getValue().isNull()) merged.remove(entry.getKey());
                else merged.set(entry.getKey(), entry.getValue());
            }
        }
        return merged;
    }

    public static void deleteSettings(Db db, String userId) {
        db.execute("DELETE FROM user_settings WHERE user_id = $1", userId);
    }
}
