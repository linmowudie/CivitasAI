package com.civitas.server.services;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.db.Db;
import com.civitas.server.http.Errors;
import com.civitas.server.json.IsoTimes;
import com.civitas.server.json.Json;
import com.civitas.server.repositories.SettingsRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.time.Instant;

/**
 * 设置管理：读取 / 整体写入 / 浅合并 / 概览 —— 与 TS 版 `src/services/settingsService.ts` 对位。
 * 服务端为权威源，返回 revision 供客户端做乐观并发。
 */
public final class SettingsService {
    private final Db db;
    private final ServerConfig cfg;

    public SettingsService(Db db, ServerConfig cfg) {
        this.db = db;
        this.cfg = cfg;
    }

    public record SettingsDto(int revision, JsonNode data, String updatedAt) {}

    public static SettingsDto toSettingsDto(SettingsRepository.SettingsRow row) {
        return new SettingsDto(
                row.revision(),
                row.data(),
                IsoTimes.format(row.updatedAt()));
    }

    public SettingsDto get(String userId) {
        SettingsRepository.SettingsRow row = SettingsRepository.getSettings(db, userId);
        return row != null
                ? toSettingsDto(row)
                : new SettingsDto(0, Json.MAPPER.createObjectNode(), IsoTimes.format(Instant.EPOCH));
    }

    /** 是否已存在设置（备份导出用） */
    public SettingsDto peek(String userId) {
        SettingsRepository.SettingsRow row = SettingsRepository.getSettings(db, userId);
        return row != null ? toSettingsDto(row) : null;
    }

    public SettingsDto put(String userId, ObjectNode data, Long expectedRevision) {
        assertSize(data);
        return toSettingsDto(SettingsRepository.putSettings(db, userId, data, expectedRevision));
    }

    public SettingsDto patch(String userId, ObjectNode patch, Long expectedRevision) {
        // 与现有数据合并后再校验体积，避免"分多次 patch 绕过上限"
        SettingsRepository.SettingsRow current = SettingsRepository.getSettings(db, userId);
        ObjectNode merged = SettingsRepository.merge(current == null ? null : current.data(), patch);
        assertSize(merged);
        return toSettingsDto(SettingsRepository.patchSettings(db, userId, patch, expectedRevision));
    }

    public void reset(String userId) {
        SettingsRepository.deleteSettings(db, userId);
    }

    /** 体积上限：设置是自由 JSON，但要防止超大对象拖垮库与内存 */
    private void assertSize(JsonNode data) {
        int bytes = sizeOf(data);
        if (bytes > cfg.limits().maxSettingsBytes()) {
            throw Errors.payloadTooLarge(
                    "设置体积超限（" + bytes + " > " + cfg.limits().maxSettingsBytes() + " 字节）",
                    Errors.details("maxBytes", cfg.limits().maxSettingsBytes()));
        }
    }

    /** 对位 TS：`Buffer.byteLength(JSON.stringify(data), 'utf8')` */
    static int sizeOf(JsonNode data) {
        try {
            return Json.MAPPER.writeValueAsString(data).getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        } catch (Exception e) {
            throw new IllegalStateException("设置序列化失败", e);
        }
    }
}
