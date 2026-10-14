package com.civitas.server.integration;

import com.civitas.server.helpers.ApiClient.ApiResponse;
import com.civitas.server.helpers.ApiClient.AuthedUser;
import com.civitas.server.helpers.IntegrationTest;
import com.civitas.server.json.Json;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 集成测试：个人数据统计（批量上报幂等 / 区间汇总 / 按日时区分桶 / 概览 / 清空）
 * —— 与 TS 版 `test/integration/stats.spec.ts` 对位。
 */
class StatsIntegrationTest extends IntegrationTest {

    /** 便捷构造请求体（键值交替） */
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) map.put((String) kv[i], kv[i + 1]);
        return map;
    }

    private static Map<String, Object> event(String kind, double value, String occurredAt) {
        return map("kind", kind, "value", value, "occurredAt", occurredAt);
    }

    private static JsonNode json(String raw) {
        try {
            return Json.MAPPER.readTree(raw);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private AuthedUser register(String email) {
        return client().register(email);
    }

    @Test
    void 批量上报_写入条数正确_clientEventId幂等() {
        AuthedUser user = register("stats@example.com");
        List<Map<String, Object>> events = List.of(
                map("kind", "chat.turn", "value", 120, "occurredAt", "2026-03-01T01:00:00.000Z",
                        "clientEventId", "e1"),
                map("kind", "chat.turn", "value", 80, "occurredAt", "2026-03-01T02:00:00.000Z",
                        "clientEventId", "e2"),
                map("kind", "tool.call", "value", 1, "occurredAt", "2026-03-01T03:00:00.000Z",
                        "clientEventId", "e3"));

        ApiResponse first = client().post("/v1/stats/events", map("events", events), user.accessToken());
        assertEquals(201, first.status());
        assertEquals(3, client().dataOf(first).path("accepted").asInt());
        assertEquals(3, client().dataOf(first).path("submitted").asInt());

        // 重复上报同一批（同 clientEventId）→ 全部忽略
        ApiResponse again = client().post("/v1/stats/events", map("events", events), user.accessToken());
        assertEquals(0, client().dataOf(again).path("accepted").asInt());

        ApiResponse summary = client().get(
                "/v1/stats/summary?from=2026-03-01T00:00:00.000Z&to=2026-03-02T00:00:00.000Z",
                user.accessToken());
        assertEquals(3, client().dataOf(summary).path("totalEvents").asInt());
        assertEquals(201.0, client().dataOf(summary).path("totalValue").asDouble());
    }

    @Test
    void 无clientEventId时允许重复写入_不误判为幂等() {
        AuthedUser user = register("stats2@example.com");
        List<Map<String, Object>> events = List.of(
                map("kind", "app.launch", "value", 0, "occurredAt", "2026-03-01T01:00:00.000Z"));
        client().post("/v1/stats/events", map("events", events), user.accessToken());
        client().post("/v1/stats/events", map("events", events), user.accessToken());

        ApiResponse summary = client().get(
                "/v1/stats/summary?from=2026-03-01T00:00:00.000Z&to=2026-03-02T00:00:00.000Z",
                user.accessToken());
        assertEquals(2, client().dataOf(summary).path("totalEvents").asInt());
    }

    @Test
    void 按种类汇总并按数量排序() {
        AuthedUser user = register("stats3@example.com");
        client().post("/v1/stats/events", map("events", List.of(
                event("tool.call", 1, "2026-03-01T01:00:00.000Z"),
                event("tool.call", 1, "2026-03-01T02:00:00.000Z"),
                event("tool.call", 1, "2026-03-01T03:00:00.000Z"),
                event("chat.turn", 50, "2026-03-01T04:00:00.000Z"))), user.accessToken());

        ApiResponse summary = client().get(
                "/v1/stats/summary?from=2026-03-01T00:00:00.000Z&to=2026-03-02T00:00:00.000Z",
                user.accessToken());
        JsonNode byKind = client().dataOf(summary).path("byKind");
        assertEquals("tool.call", byKind.get(0).path("kind").asText());
        assertEquals(3, byKind.get(0).path("count").asInt());
        assertEquals(3.0, byKind.get(0).path("value").asDouble());
        assertEquals("chat.turn", byKind.get(1).path("kind").asText());
        assertEquals(1, byKind.get(1).path("count").asInt());
        assertEquals(50.0, byKind.get(1).path("value").asDouble());
    }

    @Test
    void 按日分桶遵循配置时区_UTC1630归到次日() {
        AuthedUser user = register("stats4@example.com");
        client().post("/v1/stats/events", map("events", List.of(
                event("chat.turn", 10, "2026-03-01T15:30:00.000Z"), // 沪 03-01 23:30
                event("chat.turn", 20, "2026-03-01T16:30:00.000Z"))), user.accessToken()); // 沪 03-02 00:30

        ApiResponse daily = client().get(
                "/v1/stats/daily?from=2026-02-28T00:00:00.000Z&to=2026-03-04T00:00:00.000Z",
                user.accessToken());
        JsonNode data = client().dataOf(daily);
        assertEquals("Asia/Shanghai", data.path("timezone").asText());
        List<String> days = new ArrayList<>();
        data.path("days").forEach(d -> days.add(d.path("day").asText()));
        assertEquals(List.of("2026-03-01", "2026-03-02"), days);
        for (JsonNode day : data.path("days")) {
            if ("2026-03-02".equals(day.path("day").asText())) {
                assertEquals(20.0, day.path("value").asDouble());
            }
        }

        // 只看某一种类
        ApiResponse filtered = client().get(
                "/v1/stats/daily?from=2026-02-28T00:00:00.000Z&to=2026-03-04T00:00:00.000Z&kind=tool.call",
                user.accessToken());
        assertEquals(0, client().dataOf(filtered).path("days").size());
    }

    @Test
    void 缺省区间为最近30天_活跃天数去重统计() {
        AuthedUser user = register("stats5@example.com");
        long now = System.currentTimeMillis();
        client().post("/v1/stats/events", map("events", List.of(
                event("a", 1, Instant.ofEpochMilli(now - 1_000).toString()),
                event("a", 1, Instant.ofEpochMilli(now - 2_000).toString()),
                // 40 天前 —— 范围外
                event("a", 1, Instant.ofEpochMilli(now - 40L * 86_400_000L).toString()))), user.accessToken());

        ApiResponse summary = client().get("/v1/stats/summary", user.accessToken());
        assertEquals(2, client().dataOf(summary).path("totalEvents").asInt());
        assertEquals(1, client().dataOf(summary).path("activeDays").asInt());

        ApiResponse lifetime = client().get("/v1/stats/overview", user.accessToken());
        assertEquals(3, client().dataOf(lifetime).path("lifetime").path("events").asInt()); // 概览统计终身
    }

    @Test
    void 概览包含记忆数_设置版本与活跃设备数() {
        AuthedUser user = register("stats6@example.com");
        client().post("/v1/stats/events", map("events", List.of(
                event("a", 5, Instant.now().toString()))), user.accessToken());
        client().post("/v1/memories", map("title", "记忆一", "content", "内容"), user.accessToken());
        client().post("/v1/memories", map("title", "记忆二", "content", "内容"), user.accessToken());
        client().put("/v1/settings", map("data", json("{\"theme\":\"dark\"}")), user.accessToken());

        ApiResponse overview = client().get("/v1/stats/overview", user.accessToken());
        JsonNode data = client().dataOf(overview);
        assertEquals(1, data.path("lifetime").path("events").asInt());
        assertEquals(5.0, data.path("lifetime").path("value").asDouble());
        assertEquals(2, data.path("memories").path("total").asInt());
        assertEquals(1, data.path("settings").path("revision").asInt());
        assertEquals(1, data.path("sessions").path("active").asInt());
    }

    @Test
    void 清空统计事件() {
        AuthedUser user = register("stats7@example.com");
        client().post("/v1/stats/events", map("events", List.of(
                event("a", 1, Instant.now().toString()))), user.accessToken());

        ApiResponse cleared = client().delete("/v1/stats/events", user.accessToken());
        assertEquals(1, client().dataOf(cleared).path("deleted").asInt());

        ApiResponse summary = client().get("/v1/stats/summary", user.accessToken());
        assertEquals(0, client().dataOf(summary).path("totalEvents").asInt());
    }

    @Test
    void 校验_空数组非法时间400_超限413() {
        AuthedUser user = register("stats8@example.com");
        assertEquals(400, client().post("/v1/stats/events", map("events", List.of()), user.accessToken()).status());
        assertEquals(400, client().post("/v1/stats/events",
                map("events", List.of(map("kind", "a", "occurredAt", "not-a-date"))), user.accessToken()).status());

        // testConfig: maxStatsEventsPerBatch = 50
        List<Map<String, Object>> many = new ArrayList<>();
        long now = System.currentTimeMillis();
        for (int i = 0; i < 51; i++) {
            many.add(event("a", 1, Instant.ofEpochMilli(now + i).toString()));
        }
        ApiResponse tooMany = client().post("/v1/stats/events", map("events", many), user.accessToken());
        assertEquals(413, tooMany.status());
        assertEquals("PAYLOAD_TOO_LARGE", tooMany.errorCode());
        assertTrue(tooMany.errorMessage().startsWith("单次最多上报"), tooMany.errorMessage());
    }

    @Test
    void 统计在用户间隔离() {
        AuthedUser user = register("stats9@example.com");
        client().post("/v1/stats/events", map("events", List.of(
                event("a", 9, Instant.now().toString()))), user.accessToken());

        AuthedUser other = register("stats-other@example.com");
        ApiResponse otherSummary = client().get("/v1/stats/summary", other.accessToken());
        assertEquals(0, client().dataOf(otherSummary).path("totalEvents").asInt());
    }
}
