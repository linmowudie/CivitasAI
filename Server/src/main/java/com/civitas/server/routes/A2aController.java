package com.civitas.server.routes;

import com.civitas.server.http.ApiResponse;
import com.civitas.server.http.AuthContext;
import com.civitas.server.http.RequireAuth;
import com.civitas.server.http.validation.A2aBodies;
import com.civitas.server.json.Json;
import com.civitas.server.services.A2aService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * A2A 镜像面（P0c）—— 与 TS 版 `src/routes/a2a.ts` 对位。设计 §15.3。
 *
 *   POST /v1/a2a/messages/bulk   批量 upsert（幂等，≤500/批；服务端二次脱敏 + 限额截断）
 *   GET  /v1/a2a/messages        增量拉取（游标 `(created_at, message_id)`）
 *   POST /v1/a2a/cards/bulk      卡片镜像上行（≤500/批）
 *
 * 说明：服务端只做**镜像**（本机为权威）。刻意不提供删除/覆盖本机判定的接口。
 */
@RestController
public final class A2aController {
    private final A2aService a2a;

    public A2aController(A2aService a2a) {
        this.a2a = a2a;
    }

    @PostMapping("/v1/a2a/messages/bulk")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<A2aService.UpsertMessagesResult>> messagesBulk(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body) {
        A2aBodies.MessageBulkBody parsed = A2aBodies.messageBulk(body);
        return ApiResponse.okResponse(a2a.upsertMessages(authCtx.userId(), parsed.items()));
    }

    @GetMapping("/v1/a2a/messages")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<A2aService.ListMessagesResult>> messages(
            AuthContext authCtx,
            @RequestParam(value = "taskId", required = false) String taskId,
            @RequestParam(value = "agentId", required = false) String agentId,
            @RequestParam(value = "since", required = false) String since,
            @RequestParam(value = "limit", required = false) String limit,
            @RequestParam(value = "cursor", required = false) String cursor) {
        A2aBodies.ListQuery query = A2aBodies.listQuery(listQueryNode(taskId, agentId, since, limit, cursor));
        return ApiResponse.okResponse(a2a.listMessages(
                authCtx.userId(), query.taskId(), query.agentId(),
                query.since(), query.limit(), query.cursor()));
    }

    @PostMapping("/v1/a2a/cards/bulk")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<A2aService.UpsertCardsResult>> cardsBulk(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body) {
        A2aBodies.CardBulkBody parsed = A2aBodies.cardBulk(body);
        return ApiResponse.okResponse(a2a.upsertCards(authCtx.userId(), parsed.items()));
    }

    /** 组装查询串校验输入（只放入实际出现的参数） */
    private static ObjectNode listQueryNode(
            String taskId, String agentId, String since, String limit, String cursor) {
        ObjectNode node = Json.MAPPER.createObjectNode();
        if (taskId != null) node.put("taskId", taskId);
        if (agentId != null) node.put("agentId", agentId);
        if (since != null) node.put("since", since);
        if (limit != null) node.put("limit", limit);
        if (cursor != null) node.put("cursor", cursor);
        return node;
    }
}
