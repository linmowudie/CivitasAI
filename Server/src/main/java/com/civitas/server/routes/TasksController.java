package com.civitas.server.routes;

import com.civitas.server.http.ApiResponse;
import com.civitas.server.http.AuthContext;
import com.civitas.server.http.RequireAuth;
import com.civitas.server.http.validation.TaskBodies;
import com.civitas.server.json.Json;
import com.civitas.server.services.TaskService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 任务（会话）元数据：标题 + 归档状态 —— 与 TS 版 `src/routes/tasks.ts` 对位。
 *
 * 说明：仅元数据；消息正文与工具轨迹只存本机（见 Docs/Server/01 与 Docs/Client/04）。
 */
@RestController
public final class TasksController {
    private final TaskService tasks;

    public TasksController(TaskService tasks) {
        this.tasks = tasks;
    }

    @GetMapping("/v1/tasks")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<TaskService.ListResult>> list(
            AuthContext authCtx,
            @RequestParam(value = "archived", required = false) String archived,
            @RequestParam(value = "limit", required = false) String limit) {
        ObjectNode query = Json.MAPPER.createObjectNode();
        if (archived != null) query.put("archived", archived);
        if (limit != null) query.put("limit", limit);
        TaskBodies.ListQuery parsed = TaskBodies.listQuery(query);
        return ApiResponse.okResponse(tasks.list(authCtx.userId(), parsed.archived(), parsed.limit()));
    }

    @PostMapping("/v1/tasks/bulk")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<TaskService.UpsertResult>> bulk(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body) {
        TaskBodies.BulkBody parsed = TaskBodies.bulk(body);
        return ApiResponse.okResponse(tasks.upsertMany(authCtx.userId(), parsed.items()));
    }
}
