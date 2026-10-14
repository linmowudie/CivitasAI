package com.civitas.server.services;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.db.Db;
import com.civitas.server.http.Errors;
import com.civitas.server.json.IsoTimes;
import com.civitas.server.json.Json;
import com.civitas.server.repositories.MemoriesRepository;
import com.civitas.server.repositories.MemoriesRepository.MemoryInput;
import com.civitas.server.repositories.MemoriesRepository.MemoryPatch;
import com.civitas.server.repositories.MemoriesRepository.MemoryRow;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/**
 * 记忆存储服务：CRUD + 批量（恢复）+ 分页检索 —— 与 TS 版 `src/services/memoryService.ts` 对位。
 */
public final class MemoryService {
    private final Db db;
    private final ServerConfig cfg;

    public MemoryService(Db db, ServerConfig cfg) {
        this.db = db;
        this.cfg = cfg;
    }

    public record MemoryDto(
            String id,
            String clientMemoryId,
            String title,
            String content,
            String category,
            String assertion,
            String status,
            String contradictedBy,
            JsonNode sourceTraceIds,
            JsonNode sourceArbitrationIds,
            int accessCount,
            String createdAt,
            String lastAccessedAt,
            String updatedAt) {}

    public static MemoryDto toMemoryDto(MemoryRow row) {
        return new MemoryDto(
                row.id(),
                row.clientMemoryId(),
                row.title(),
                row.content(),
                row.category(),
                row.assertion(),
                row.status(),
                row.contradictedBy(),
                row.sourceTraceIds() != null && row.sourceTraceIds().isArray()
                        ? row.sourceTraceIds()
                        : Json.MAPPER.createArrayNode(),
                row.sourceArbitrationIds() != null && row.sourceArbitrationIds().isArray()
                        ? row.sourceArbitrationIds()
                        : null,
                row.accessCount(),
                IsoTimes.format(row.createdAt()),
                IsoTimes.format(row.lastAccessedAt()),
                IsoTimes.format(row.updatedAt()));
    }

    public record ListResult(List<MemoryDto> items, String nextCursor) {}

    public record CreateResult(MemoryDto memory, boolean created) {}

    public ListResult list(String userId, MemoriesRepository.ListMemoriesOptions options) {
        MemoriesRepository.ListMemoriesResult result = MemoriesRepository.listMemories(db, userId, options);
        return new ListResult(
                result.items().stream().map(MemoryService::toMemoryDto).toList(),
                result.nextCursor());
    }

    public MemoryDto get(String userId, String id) {
        MemoryRow row = MemoriesRepository.getMemory(db, userId, id);
        if (row == null) throw Errors.notFound("记忆不存在");
        return toMemoryDto(row);
    }

    public CreateResult create(String userId, MemoryInput input) {
        // 有 clientMemoryId 时先探测是否已存在，用于返回 created 标志（幂等 upsert 语义）
        MemoryRow existing = input.clientMemoryId() != null
                ? MemoriesRepository.getMemoryByClientId(db, userId, input.clientMemoryId())
                : null;
        MemoryRow row = MemoriesRepository.upsertMemory(db, userId, input);
        return new CreateResult(toMemoryDto(row), existing == null);
    }

    public MemoryDto update(String userId, String id, MemoryPatch patch) {
        MemoryRow row = MemoriesRepository.updateMemory(db, userId, id, patch);
        if (row == null) throw Errors.notFound("记忆不存在");
        return toMemoryDto(row);
    }

    public void remove(String userId, String id, boolean hard) {
        boolean ok = MemoriesRepository.deleteMemory(db, userId, id, hard);
        if (!ok) throw Errors.notFound("记忆不存在或已删除");
    }

    public MemoriesRepository.BulkUpsertResult bulkUpsert(String userId, List<MemoryInput> items) {
        if (items.size() > cfg.limits().maxMemoriesPerBulk()) {
            throw Errors.payloadTooLarge(
                    "单次最多上传 " + cfg.limits().maxMemoriesPerBulk() + " 条记忆",
                    Errors.details("max", cfg.limits().maxMemoriesPerBulk(), "submitted", items.size()));
        }
        return MemoriesRepository.bulkUpsertMemories(db, userId, items);
    }

    public int count(String userId, String status) {
        return MemoriesRepository.countMemories(db, userId, status);
    }

    public List<MemoryDto> all(String userId) {
        return MemoriesRepository.listAllMemories(db, userId).stream().map(MemoryService::toMemoryDto).toList();
    }
}
