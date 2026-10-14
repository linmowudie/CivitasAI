package com.civitas.server.routes;

import com.civitas.server.http.ApiResponse;
import com.civitas.server.http.AuthContext;
import com.civitas.server.http.RequireAuth;
import com.civitas.server.http.validation.MemoryBodies;
import com.civitas.server.json.Json;
import com.civitas.server.repositories.MemoriesRepository;
import com.civitas.server.services.MemoryService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 记忆存储：列表（键集分页 + 检索）/ 详情 / 新建（幂等 upsert）/ 更新 / 删除 / 批量
 * —— 与 TS 版 `src/routes/memories.ts` 对位。
 */
@RestController
public final class MemoriesController {
    private final MemoryService memories;

    public MemoriesController(MemoryService memories) {
        this.memories = memories;
    }

    public record DeleteBody(String deleted, boolean hard) {}

    @GetMapping("/v1/memories")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<MemoryService.ListResult>> list(
            AuthContext authCtx,
            @RequestParam(value = "limit", required = false) String limit,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "category", required = false) String category,
            @RequestParam(value = "status", required = false) String status,
            @RequestParam(value = "q", required = false) String q) {
        MemoryBodies.ListQuery query = MemoryBodies.listQuery(listQueryNode(limit, cursor, category, status, q));
        return ApiResponse.okResponse(memories.list(authCtx.userId(), new MemoriesRepository.ListMemoriesOptions(
                query.limit(), query.cursor(), query.category(), query.status(), query.q())));
    }

    @GetMapping("/v1/memories/{id}")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<MemoryService.MemoryDto>> get(
            AuthContext authCtx, @PathVariable("id") String id) {
        return ApiResponse.okResponse(memories.get(authCtx.userId(), id));
    }

    /** 新建或按 clientMemoryId 幂等更新（重装后重新上传走这里） */
    @PostMapping("/v1/memories")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<MemoryService.CreateResult>> create(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body) {
        MemoriesRepository.MemoryInput input = MemoryBodies.create(body);
        MemoryService.CreateResult result = memories.create(authCtx.userId(), input);
        return ApiResponse.okResponse(result, result.created() ? 201 : 200);
    }

    @PatchMapping("/v1/memories/{id}")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<MemoryService.MemoryDto>> update(
            AuthContext authCtx, @PathVariable("id") String id, @RequestBody(required = false) JsonNode body) {
        MemoriesRepository.MemoryPatch patch = MemoryBodies.update(body);
        return ApiResponse.okResponse(memories.update(authCtx.userId(), id, patch));
    }

    /** 删除（默认软删除，保留墓碑便于多端同步）；?hard=true 物理删除 */
    @DeleteMapping("/v1/memories/{id}")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<DeleteBody>> remove(
            AuthContext authCtx, @PathVariable("id") String id,
            @RequestParam(value = "hard", required = false) String hard) {
        boolean hardDelete = "true".equals(hard);
        memories.remove(authCtx.userId(), id, hardDelete);
        return ApiResponse.okResponse(new DeleteBody(id, hardDelete));
    }

    /** 批量 upsert（恢复/首次全量上传） */
    @PostMapping("/v1/memories/bulk")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<MemoriesRepository.BulkUpsertResult>> bulk(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body) {
        MemoryBodies.BulkBody parsed = MemoryBodies.bulk(body);
        return ApiResponse.okResponse(memories.bulkUpsert(authCtx.userId(), parsed.items()));
    }

    /** 组装查询串校验输入（只放入实际出现的参数） */
    private static ObjectNode listQueryNode(
            String limit, String cursor, String category, String status, String q) {
        ObjectNode node = Json.MAPPER.createObjectNode();
        if (limit != null) node.put("limit", limit);
        if (cursor != null) node.put("cursor", cursor);
        if (category != null) node.put("category", category);
        if (status != null) node.put("status", status);
        if (q != null) node.put("q", q);
        return node;
    }
}
