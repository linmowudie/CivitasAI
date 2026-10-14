package com.civitas.server.services;

import com.civitas.server.db.Db;
import com.civitas.server.http.Errors;
import com.civitas.server.json.IsoTimes;
import com.civitas.server.json.Json;
import com.civitas.server.repositories.MemoriesRepository;
import com.civitas.server.repositories.SettingsRepository;
import com.civitas.server.repositories.StatsRepository;
import com.civitas.server.repositories.TasksRepository;
import com.civitas.server.repositories.UsersRepository;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 一键备份 / 恢复 —— “卸载重装后重建”的核心能力。
 * 与 TS 版 `src/services/backupService.ts` 对位。
 *
 * 备份包（version=1）自包含：账户摘要 + 设置 + 记忆（+ 可选统计）。
 * 恢复在**单个事务**内完成：
 *   - mode=replace：清空该用户的设置/记忆/统计后写入（“重建”语义）
 *   - mode=merge  ：按 client_memory_id 幂等 upsert，不删除既有数据（“合并”语义）
 *
 * 完整性（安全审计 SV-001）：导出默认**全量**（记忆与统计均走键集分页循环，无 10 000
 * 条静默上限）；仅当调用方显式传入 `statsLimit` 且事件数超限时，包内出现
 * `truncated` 标记如实告知（缺省即完整，绝不静默截断）。
 */
public final class BackupService {
    public static final String BACKUP_FORMAT = "civitas.backup";
    public static final int BACKUP_VERSION = 1;

    /** 统计事件导出分页大小 */
    private static final int STATS_EXPORT_PAGE_SIZE = 1_000;

    private final Db db;

    public BackupService(Db db) {
        this.db = db;
    }

    public record BackupAccount(String email, String displayName) {}

    public record BackupTaskDto(
            String clientSessionId,
            String title,
            long createdAt,
            long updatedAt,
            Long archivedAt) {}

    public record BackupStatEvent(
            String kind,
            double value,
            String occurredAt,
            String clientEventId,
            JsonNode meta) {}

    public record BackupStats(List<BackupStatEvent> events) {}

    public record BackupStatsTruncation(int limit, String reason) {}

    public record BackupTruncation(BackupStatsTruncation stats) {}

    public record BackupBundle(
            String format,
            int version,
            String exportedAt,
            BackupAccount account,
            SettingsService.SettingsDto settings,
            List<MemoryService.MemoryDto> memories,
            List<BackupTaskDto> tasks,
            BackupStats stats,
            @JsonInclude(JsonInclude.Include.NON_NULL) BackupTruncation truncated) {}

    public record SettingsRestore(boolean restored, int revision) {}

    public record MemoriesRestore(int created, int updated, int total) {}

    public record TasksRestore(int created, int updated, int total) {}

    public record StatsRestore(int accepted) {}

    public record RestoreReport(
            String mode,
            SettingsRestore settings,
            MemoriesRestore memories,
            TasksRestore tasks,
            StatsRestore stats) {}

    private record StatEventRow(String id, String kind, double value, Instant occurredAt,
                                String clientEventId, JsonNode meta) {}

    /**
     * 导出统计事件（SV-001：不再静默截断）。
     *
     * - 未指定 `limit`：键集分页 **全量**导出（与记忆导出一致，无上限）；
     * - 指定 `limit`：多取 1 条探测溢出，`truncated` 如实回传，由调用方写进备份包。
     */
    private static ExportStatEventsResult exportStatEvents(Db db, String userId, Integer limit) {
        String columns = "id, kind, value, occurred_at, client_event_id, meta";
        if (limit != null) {
            List<StatEventRow> rows = queryStatEvents(
                    db,
                    "SELECT " + columns + " FROM usage_events WHERE user_id = $1 ORDER BY occurred_at ASC, id ASC LIMIT $2",
                    userId, (long) limit + 1);
            return new ExportStatEventsResult(
                    rows.subList(0, Math.min(limit, rows.size())),
                    rows.size() > limit);
        }

        List<StatEventRow> events = new ArrayList<>();
        StatEventRow cursor = null;
        for (;;) {
            List<StatEventRow> rows = cursor != null
                    ? queryStatEvents(
                            db,
                            "SELECT " + columns + " FROM usage_events "
                                    + "WHERE user_id = $1 AND (occurred_at, id) > ($2, $3) "
                                    + "ORDER BY occurred_at ASC, id ASC LIMIT $4",
                            userId, cursor.occurredAt(), Long.parseLong(cursor.id()), STATS_EXPORT_PAGE_SIZE)
                    : queryStatEvents(
                            db,
                            "SELECT " + columns + " FROM usage_events WHERE user_id = $1 "
                                    + "ORDER BY occurred_at ASC, id ASC LIMIT $2",
                            userId, STATS_EXPORT_PAGE_SIZE);
            events.addAll(rows);
            if (rows.size() < STATS_EXPORT_PAGE_SIZE) {
                return new ExportStatEventsResult(events, false);
            }
            StatEventRow last = rows.isEmpty() ? null : rows.get(rows.size() - 1);
            if (last == null) return new ExportStatEventsResult(events, false);
            cursor = last;
        }
    }

    private record ExportStatEventsResult(List<StatEventRow> events, boolean truncated) {}

    private static List<StatEventRow> queryStatEvents(Db db, String sql, Object... params) {
        return db.query(sql, params).stream()
                .map(row -> new StatEventRow(
                        Db.str(row, "id"),
                        Db.str(row, "kind"),
                        numberValue(row.get("value")),
                        Db.instantOf(row, "occurred_at"),
                        Db.str(row, "client_event_id"),
                        parseJsonNode(Db.str(row, "meta"))))
                .toList();
    }

    private static double numberValue(Object raw) {
        return raw instanceof Number number ? number.doubleValue() : 0;
    }

    private static JsonNode parseJsonNode(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        try {
            return Json.MAPPER.readTree(raw);
        } catch (Exception e) {
            return null;
        }
    }

    private static String toIso(Instant instant) {
        return instant == null ? null : IsoTimes.format(instant);
    }

    /** 导出备份包 */
    public BackupBundle export(String userId, boolean includeStats, Integer statsLimit) {
        UsersRepository.UserRow user = UsersRepository.findUserById(db, userId);
        if (user == null) throw Errors.badRequest("用户不存在", null);
        SettingsRepository.SettingsRow settingsRow = SettingsRepository.getSettings(db, userId);
        List<MemoriesRepository.MemoryRow> memories = MemoriesRepository.listAllMemories(db, userId);
        // 任务元数据（标题 + 归档状态）：与记忆/统计一致，键集分页全量导出，无静默截断
        List<TasksRepository.UserTaskRow> taskRows = TasksRepository.listAllTasks(db, userId);
        List<BackupTaskDto> tasks = taskRows.stream()
                .map(r -> new BackupTaskDto(
                        r.clientSessionId(), r.title(), r.createdAt(), r.updatedAt(), r.archivedAt()))
                .toList();

        BackupStats stats = null;
        BackupTruncation truncated = null;
        if (includeStats) {
            ExportStatEventsResult result = exportStatEvents(db, userId, statsLimit);
            stats = new BackupStats(result.events().stream()
                    .map(e -> new BackupStatEvent(
                            e.kind(), e.value(), toIso(e.occurredAt()), e.clientEventId(), e.meta()))
                    .toList());
            if (result.truncated() && statsLimit != null) {
                truncated = new BackupTruncation(new BackupStatsTruncation(
                        statsLimit,
                        "统计事件超过调用方设定的 statsLimit，仅导出前 N 条（省略 statsLimit 可导出全量）"));
            }
        }

        return new BackupBundle(
                BACKUP_FORMAT,
                BACKUP_VERSION,
                IsoTimes.format(Instant.now()),
                new BackupAccount(user.email(), user.displayName()),
                settingsRow != null ? SettingsService.toSettingsDto(settingsRow) : null,
                memories.stream().map(MemoryService::toMemoryDto).toList(),
                tasks,
                stats,
                truncated);
    }

    /** 校验备份包结构（路由层做字段校验，这里做语义检查） */
    public static void assertBundleUsable(BackupBundle bundle) {
        if (!BACKUP_FORMAT.equals(bundle.format())) {
            throw Errors.badRequest("备份格式不支持：期望 " + BACKUP_FORMAT, null);
        }
        if (bundle.version() > BACKUP_VERSION) {
            throw Errors.badRequest(
                    "备份版本 " + bundle.version() + " 高于本服务端支持的 " + BACKUP_VERSION, null);
        }
    }

    public RestoreReport restore(String userId, BackupBundle bundle, String mode) {
        assertBundleUsable(bundle);

        return db.tx(tx -> {
            // ── 设置 ──
            int restoredRevision = 0;
            if (bundle.settings() != null) {
                ObjectNode data = bundle.settings().data() != null && bundle.settings().data().isObject()
                        ? (ObjectNode) bundle.settings().data()
                        : Json.MAPPER.createObjectNode();
                SettingsRepository.SettingsRow row = SettingsRepository.putSettings(tx, userId, data, null);
                restoredRevision = row.revision();
            } else if ("replace".equals(mode)) {
                SettingsRepository.deleteSettings(tx, userId);
            }

            // ── 统计 ──
            int acceptedStats = 0;
            if (bundle.stats() != null && bundle.stats().events() != null && !bundle.stats().events().isEmpty()) {
                if ("replace".equals(mode)) StatsRepository.deleteAllEvents(tx, userId);
                acceptedStats = StatsRepository.insertEvents(tx, userId, bundle.stats().events().stream()
                        .map(e -> new StatsRepository.UsageEventInput(
                                e.kind(), e.value(), parseJsDate(e.occurredAt()), e.meta(), e.clientEventId()))
                        .toList());
            }

            // ── 记忆 ──
            List<MemoriesRepository.MemoryInput> inputs = bundle.memories().stream()
                    .map(m -> new MemoriesRepository.MemoryInput(
                            m.clientMemoryId() != null ? m.clientMemoryId() : m.id(),
                            m.title(),
                            m.content(),
                            m.category(),
                            m.assertion(),
                            m.sourceTraceIds(),
                            m.sourceArbitrationIds(),
                            m.status(),
                            m.contradictedBy(),
                            m.accessCount(),
                            parseJsDate(m.createdAt()),
                            parseJsDate(m.lastAccessedAt())))
                    .toList();

            if ("replace".equals(mode)) {
                tx.execute("DELETE FROM memories WHERE user_id = $1", userId);
            }

            MemoriesRepository.BulkUpsertResult memoryResult = !inputs.isEmpty()
                    ? MemoriesRepository.bulkUpsertMemories(tx, userId, inputs)
                    : new MemoriesRepository.BulkUpsertResult(0, 0, 0);

            // ── 任务元数据（标题 + 归档状态）──
            // replace 模式先清空该用户的任务元数据，再按包内内容重建，保证与备份一致；
            // merge 模式仅 upsert（幂等，不清空本地既有的其他任务）。
            List<BackupTaskDto> taskItems = bundle.tasks() != null ? bundle.tasks() : List.of();
            if ("replace".equals(mode) && !taskItems.isEmpty()) {
                tx.execute("DELETE FROM user_tasks WHERE user_id = $1", userId);
            }
            TasksRepository.CreatedUpdated taskResult = !taskItems.isEmpty()
                    ? TasksRepository.bulkUpsertTasks(tx, userId, taskItems.stream()
                            .map(t -> new TasksRepository.TaskInput(
                                    t.clientSessionId(), t.title(), t.createdAt(), t.updatedAt(), t.archivedAt()))
                            .toList())
                    : new TasksRepository.CreatedUpdated(0, 0);

            return new RestoreReport(
                    mode,
                    new SettingsRestore(bundle.settings() != null, restoredRevision),
                    new MemoriesRestore(memoryResult.created(), memoryResult.updated(), memoryResult.total()),
                    new TasksRestore(taskResult.created(), taskResult.updated(), taskItems.size()),
                    new StatsRestore(acceptedStats));
        });
    }

    /** 对位 JS `new Date(iso)`（校验只保证是字符串；能解析出时刻即可，坏值直接 500） */
    private static Instant parseJsDate(String text) {
        if (text == null) return null;
        try {
            return Instant.parse(text);
        } catch (RuntimeException ignored) {
            // 继续尝试其它 JS 可解析的形态
        }
        try {
            return OffsetDateTime.parse(text).toInstant();
        } catch (RuntimeException ignored) {
            // 继续尝试日期形态
        }
        try {
            return LocalDate.parse(text).atStartOfDay(ZoneOffset.UTC).toInstant();
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("时间格式解析失败: " + text, e);
        }
    }
}
