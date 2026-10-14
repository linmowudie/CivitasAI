package com.civitas.server.services;

import com.civitas.server.db.Db;
import com.civitas.server.repositories.TasksRepository;
import com.civitas.server.repositories.TasksRepository.TaskInput;
import com.civitas.server.repositories.TasksRepository.UserTaskRow;

import java.util.List;

/**
 * 任务（会话）**元数据**服务：标题 + 归档状态 —— 与 TS 版 `src/services/taskService.ts` 对位。
 *
 * 语义（与产品决策一致）：
 *  - 服务端权威：以最后一次上行的时间戳为准（客户端上行 archivedAt 决定归档与否）；
 *  - 幂等：以 `clientSessionId` 为键 upsert，重复上行不会产生重复项；
 *  - 正文永不上行：消息与工具轨迹只存本机。
 */
public final class TaskService {
    private final Db db;

    public TaskService(Db db) {
        this.db = db;
    }

    public record TaskDto(
            String clientSessionId,
            String title,
            long createdAt,
            long updatedAt,
            Long archivedAt) {}

    public record ListResult(List<TaskDto> items, int total) {}

    public record UpsertResult(int created, int updated, int total) {}

    public static TaskDto toTaskDto(UserTaskRow row) {
        return new TaskDto(
                row.clientSessionId(), row.title(), row.createdAt(), row.updatedAt(), row.archivedAt());
    }

    public ListResult list(String userId, Boolean archived, Integer limit) {
        List<TaskDto> items = TasksRepository.listTasks(db, userId, archived, limit)
                .stream()
                .map(TaskService::toTaskDto)
                .toList();
        return new ListResult(items, items.size());
    }

    /** 批量 upsert（幂等）；返回新增/更新计数 */
    public UpsertResult upsertMany(String userId, List<TaskInput> items) {
        TasksRepository.CreatedUpdated result = TasksRepository.bulkUpsertTasks(
                db,
                userId,
                items.stream()
                        .map(i -> new TaskInput(
                                i.clientSessionId(),
                                i.title() != null ? i.title() : "",
                                i.createdAt(),
                                i.updatedAt(),
                                i.archivedAt()))
                        .toList());
        return new UpsertResult(result.created(), result.updated(), items.size());
    }

    /** 导出用全量（键集分页，不静默截断） */
    public List<TaskDto> listAll(String userId) {
        return TasksRepository.listAllTasks(db, userId).stream().map(TaskService::toTaskDto).toList();
    }
}
