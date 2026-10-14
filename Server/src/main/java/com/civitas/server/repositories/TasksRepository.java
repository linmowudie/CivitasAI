package com.civitas.server.repositories;

import com.civitas.server.db.Db;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 任务（会话）**元数据**仓储：标题 + 归档状态 —— 与 TS 版 `src/repositories/tasks.ts` 对位。
 *
 * 正文（消息/工具轨迹）只存本机，服务端仅保存“有哪些任务、叫什么、是否已归档”，
 * 用于跨设备/重装后恢复任务列表与归档状态。
 */
public final class TasksRepository {
    private TasksRepository() {}

    public record UserTaskRow(
            String userId,
            String clientSessionId,
            String title,
            long createdAt,
            long updatedAt,
            Long archivedAt,
            Instant syncedAt) {}

    public record TaskInput(
            String clientSessionId,
            String title,
            long createdAt,
            long updatedAt,
            Long archivedAt) {}

    public record CreatedUpdated(int created, int updated) {}

    private static UserTaskRow mapRow(Map<String, Object> row) {
        if (row == null) return null;
        Long createdAt = Db.longOf(row, "created_at");
        Long updatedAt = Db.longOf(row, "updated_at");
        return new UserTaskRow(
                Db.str(row, "user_id"),
                Db.str(row, "client_session_id"),
                Db.str(row, "title"),
                createdAt == null ? 0 : createdAt,
                updatedAt == null ? 0 : updatedAt,
                Db.longOf(row, "archived_at"),
                Db.instantOf(row, "synced_at"));
    }

    /** 新增或更新一条任务元数据（客户端会话 ID 幂等） */
    public static UserTaskRow upsertTask(Db db, String userId, TaskInput input) {
        Map<String, Object> row = db.one(
                "INSERT INTO user_tasks (user_id, client_session_id, title, created_at, updated_at, archived_at, synced_at) "
                        + "VALUES ($1, $2, $3, $4, $5, $6, now()) "
                        + "ON CONFLICT (user_id, client_session_id) DO UPDATE SET "
                        + "  title = EXCLUDED.title, "
                        + "  created_at = LEAST(user_tasks.created_at, EXCLUDED.created_at), "
                        + "  updated_at = EXCLUDED.updated_at, "
                        + "  archived_at = EXCLUDED.archived_at, "
                        + "  synced_at = now() "
                        + "RETURNING *",
                userId,
                input.clientSessionId(),
                input.title() != null ? input.title() : "",
                input.createdAt(),
                input.updatedAt(),
                input.archivedAt());
        if (row == null) throw new IllegalStateException("任务元数据写入失败：" + input.clientSessionId());
        return mapRow(row);
    }

    /** 批量 upsert（幂等；单批上限由路由层校验） */
    public static CreatedUpdated bulkUpsertTasks(Db db, String userId, List<TaskInput> items) {
        return db.tx(tx -> {
            int created = 0;
            int updated = 0;
            for (TaskInput item : items) {
                Map<String, Object> existing = tx.one(
                        "SELECT COUNT(*)::int AS n FROM user_tasks WHERE user_id = $1 AND client_session_id = $2",
                        userId, item.clientSessionId());
                upsertTask(tx, userId, item);
                Long count = existing == null ? null : Db.longOf(existing, "n");
                if (count != null && count > 0) updated += 1;
                else created += 1;
            }
            return new CreatedUpdated(created, updated);
        });
    }

    /** 列出任务元数据：null = 全部；TRUE/FALSE 按归档状态过滤（对位 TS 的 undefined/true/false） */
    public static List<UserTaskRow> listTasks(Db db, String userId, Boolean archived, Integer limit) {
        int effective = Math.min(Math.max(limit != null ? limit : 500, 1), 2000);
        List<Map<String, Object>> rows = archived == null
                ? db.query(
                        "SELECT * FROM user_tasks WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2",
                        userId, effective)
                : db.query(
                        "SELECT * FROM user_tasks "
                                + "WHERE user_id = $1 AND (archived_at IS NOT NULL) = $2 "
                                + "ORDER BY updated_at DESC LIMIT $3",
                        userId, archived, effective);
        return rows.stream().map(TasksRepository::mapRow).toList();
    }

    /** 导出用：键集分页取全量（不受单页上限静默截断，与记忆/统计一致） */
    public static List<UserTaskRow> listAllTasks(Db db, String userId, int pageSize) {
        List<UserTaskRow> all = new ArrayList<>();
        String cursor = null;
        for (;;) {
            List<UserTaskRow> rows = (cursor != null
                    ? db.query(
                            "SELECT * FROM user_tasks "
                                    + "WHERE user_id = $1 AND client_session_id > $2 "
                                    + "ORDER BY client_session_id ASC LIMIT $3",
                            userId, cursor, pageSize)
                    : db.query(
                            "SELECT * FROM user_tasks WHERE user_id = $1 "
                                    + "ORDER BY client_session_id ASC LIMIT $2",
                            userId, pageSize))
                    .stream()
                    .map(TasksRepository::mapRow)
                    .toList();
            all.addAll(rows);
            if (rows.size() < pageSize) return all;
            UserTaskRow last = rows.get(rows.size() - 1);
            cursor = last.clientSessionId();
        }
    }

    public static List<UserTaskRow> listAllTasks(Db db, String userId) {
        return listAllTasks(db, userId, 1_000);
    }
}
