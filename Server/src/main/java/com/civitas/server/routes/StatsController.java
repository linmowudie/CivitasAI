package com.civitas.server.routes;

import com.civitas.server.http.ApiResponse;
import com.civitas.server.http.AuthContext;
import com.civitas.server.http.RequireAuth;
import com.civitas.server.http.validation.StatsBodies;
import com.civitas.server.json.Json;
import com.civitas.server.services.StatsService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;

/**
 * 个人数据统计：上报事件 / 区间汇总 / 按日曲线 / 概览 / 清空
 * —— 与 TS 版 `src/routes/stats.ts` 对位。
 */
@RestController
public final class StatsController {
    private final StatsService stats;

    public StatsController(StatsService stats) {
        this.stats = stats;
    }

    /** 上报事件（批量、可带 clientEventId 做幂等） */
    @PostMapping("/v1/stats/events")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<StatsService.IngestResult>> ingest(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body) {
        StatsBodies.IngestBody parsed = StatsBodies.ingest(body);
        StatsService.IngestResult result = stats.ingest(authCtx.userId(), StatsBodies.toInputs(parsed.events()));
        return ApiResponse.okResponse(result, 201);
    }

    /** 区间汇总（按种类） */
    @GetMapping("/v1/stats/summary")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<StatsService.StatsSummaryDto>> summary(
            AuthContext authCtx,
            @RequestParam(value = "from", required = false) String from,
            @RequestParam(value = "to", required = false) String to,
            @RequestParam(value = "kind", required = false) String kind) {
        StatsBodies.RangeQuery query = StatsBodies.rangeQuery(rangeQueryNode(from, to, kind));
        Instant[] range = resolveRange(query);
        return ApiResponse.okResponse(stats.summary(authCtx.userId(), range[0], range[1]));
    }

    /** 按日曲线（可指定 kind） */
    @GetMapping("/v1/stats/daily")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<StatsService.StatsDailyDto>> daily(
            AuthContext authCtx,
            @RequestParam(value = "from", required = false) String from,
            @RequestParam(value = "to", required = false) String to,
            @RequestParam(value = "kind", required = false) String kind) {
        StatsBodies.RangeQuery query = StatsBodies.rangeQuery(rangeQueryNode(from, to, kind));
        Instant[] range = resolveRange(query);
        return ApiResponse.okResponse(stats.daily(authCtx.userId(), range[0], range[1], query.kind()));
    }

    /** 个人中心概览（终身统计 + 记忆数 + 活跃设备数） */
    @GetMapping("/v1/stats/overview")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<StatsService.StatsOverviewDto>> overview(AuthContext authCtx) {
        return ApiResponse.okResponse(stats.overview(authCtx.userId()));
    }

    /** 清空统计事件 */
    @DeleteMapping("/v1/stats/events")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<StatsService.ClearResult>> clear(AuthContext authCtx) {
        return ApiResponse.okResponse(stats.clear(authCtx.userId()));
    }

    /** 解析区间：缺省为最近 30 天；to 缺省为当前时间（与 JS `new Date()` 同为毫秒精度） */
    private static Instant[] resolveRange(StatsBodies.RangeQuery query) {
        Instant now = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS);
        return StatsService.resolveRange(query.from(), query.to(), now);
    }

    /** 组装查询串校验输入（只放入实际出现的参数） */
    private static ObjectNode rangeQueryNode(String from, String to, String kind) {
        ObjectNode node = Json.MAPPER.createObjectNode();
        if (from != null) node.put("from", from);
        if (to != null) node.put("to", to);
        if (kind != null) node.put("kind", kind);
        return node;
    }
}
