package com.civitas.server.integration;

import com.civitas.server.helpers.ApiClient;
import com.civitas.server.helpers.ApiClient.AuthedUser;
import com.civitas.server.helpers.IntegrationTest;
import com.civitas.server.json.Json;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 集成测试：A2A 对话消息镜像（P0c）—— 与 TS 版 `test/integration/a2a.spec.ts` 对位。
 *
 * 覆盖（设计 §15）：
 *  - bulk upsert **幂等**（同 messageId 重复上行不产生重复项，且可更新）
 *  - **账号隔离**（B 看不到 A 的消息）
 *  - **游标增量拉取**（`(created_at, message_id)` 键集分页，不重不漏）
 *  - **服务端二次脱敏**（密钥/令牌模式 → 占位符 + 记录 `redactedFields`；敏感键名直接替换）
 *  - **限额截断**（>64KB 载荷 → `truncated=true`，**保留 contentHash**）
 *  - 卡片镜像上行（幂等）
 *  - 契约校验（批量上限、枚举值）与认证（无令牌 → 401）
 */
class A2aIntegrationTest extends IntegrationTest {

    private static final long NOW = 1_800_000_000_000L;

    /** 便捷构造请求体（键值交替） */
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) map.put((String) kv[i], kv[i + 1]);
        return map;
    }

    /** 基准消息（键值参数用于覆盖字段；缺省与 TS 版 `msg()` 一致） */
    private static Map<String, Object> msg(Object... kv) {
        Map<String, Object> message = map(
                "messageId", "m-1", "taskId", "t1", "traceId", "t1", "kind", "answer",
                "sourceAgentId", "agent-worker-1", "targetAgentId", "agent-prime_director-1",
                "visibility", "domain", "contentHash", "hash-1", "verdict", "allow",
                "payload", map("text", "解析层已完成"), "createdAt", NOW);
        for (int i = 0; i < kv.length; i += 2) message.put((String) kv[i], kv[i + 1]);
        return message;
    }

    private static List<String> messageIds(JsonNode listData) {
        List<String> ids = new ArrayList<>();
        listData.path("items").forEach(item -> ids.add(item.path("messageId").asText()));
        return ids;
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    @Test
    void 认证_无令牌401() {
        ApiClient.ApiResponse res = client().post("/v1/a2a/messages/bulk", map("items", List.of(msg())), null);
        assertEquals(401, res.status());
    }

    @Test
    void bulkUpsert幂等_重复上行不新增且可更新() {
        AuthedUser user = client().register("a2a@test.local");
        String token = user.accessToken();

        ApiClient.ApiResponse first = client().post("/v1/a2a/messages/bulk", map("items", List.of(msg())), token);
        assertEquals(200, first.status());
        assertEquals(1, ApiClient.dataOf(first).path("created").asInt());

        JsonNode again = ApiClient.dataOf(client().post("/v1/a2a/messages/bulk", map("items", List.of(msg())), token));
        assertEquals(0, again.path("created").asInt());
        assertEquals(1, again.path("updated").asInt());

        JsonNode updated = ApiClient.dataOf(client().post("/v1/a2a/messages/bulk", map("items", List.of(
                msg("payload", map("text", "更新后的内容"), "verdict", "block"))), token));
        assertEquals(1, updated.path("updated").asInt());

        JsonNode list = ApiClient.dataOf(client().get("/v1/a2a/messages?taskId=t1", token));
        assertEquals(1, list.path("items").size());
        assertEquals("block", list.path("items").get(0).path("verdict").asText());
    }

    @Test
    void 账号隔离_B看不到A的消息() {
        AuthedUser user = client().register("a2a2@test.local");
        client().post("/v1/a2a/messages/bulk", map("items", List.of(msg())), user.accessToken());

        AuthedUser other = client().register("a2a2-b@test.local");
        JsonNode otherList = ApiClient.dataOf(client().get("/v1/a2a/messages", other.accessToken()));
        assertEquals(0, otherList.path("items").size());

        JsonNode ownList = ApiClient.dataOf(client().get("/v1/a2a/messages", user.accessToken()));
        assertEquals(1, ownList.path("items").size());
    }

    @Test
    void 游标增量拉取_limit2分页不重不漏() {
        AuthedUser user = client().register("a2a3@test.local");
        String token = user.accessToken();

        List<Map<String, Object>> items = new ArrayList<>();
        for (int i = 1; i <= 5; i++) {
            items.add(msg("messageId", "m-" + i, "contentHash", "hash-" + i, "createdAt", NOW + i));
        }
        client().post("/v1/a2a/messages/bulk", map("items", items), token);

        JsonNode page1 = ApiClient.dataOf(client().get("/v1/a2a/messages?taskId=t1&limit=2", token));
        assertEquals(List.of("m-1", "m-2"), messageIds(page1));
        String cursor1 = page1.path("nextCursor").asText("");
        assertFalse(cursor1.isEmpty());

        JsonNode page2 = ApiClient.dataOf(client().get(
                "/v1/a2a/messages?taskId=t1&limit=2&cursor=" + encode(cursor1), token));
        assertEquals(List.of("m-3", "m-4"), messageIds(page2));

        JsonNode page3 = ApiClient.dataOf(client().get(
                "/v1/a2a/messages?taskId=t1&limit=2&cursor=" + encode(page2.path("nextCursor").asText()), token));
        assertEquals(List.of("m-5"), messageIds(page3));
        assertTrue(page3.path("nextCursor").isNull());
    }

    @Test
    void 按agent过滤_发送方或接收方命中() {
        AuthedUser user = client().register("a2a4@test.local");
        String token = user.accessToken();

        client().post("/v1/a2a/messages/bulk", map("items", List.of(
                msg("messageId", "m-1"),
                msg("messageId", "m-2", "sourceAgentId", "agent-other-9", "targetAgentId", "agent-other-8"))),
                token);

        JsonNode mine = ApiClient.dataOf(client().get("/v1/a2a/messages?agentId=agent-worker-1", token));
        assertEquals(List.of("m-1"), messageIds(mine));
    }

    @Test
    void 服务端二次脱敏_密钥模式替换_记录字段路径_敏感键名直接替换() {
        AuthedUser user = client().register("a2a5@test.local");
        String token = user.accessToken();

        ApiClient.ApiResponse res = client().post("/v1/a2a/messages/bulk", map("items", List.of(
                msg("messageId", "m-secret", "payload", map(
                        "note", "token is sk-abcdefghijklmnopqrstuvwxyz123456 now",
                        "apiKey", "plain-value",
                        "nested", map("authorization", "Bearer abcdefghijklmnopqrstuvwxyz"))))),
                token);
        assertEquals(200, res.status());

        JsonNode list = ApiClient.dataOf(client().get("/v1/a2a/messages?taskId=t1", token));
        JsonNode payload = list.path("items").get(0).path("payload");
        String payloadJson;
        try {
            payloadJson = Json.MAPPER.writeValueAsString(payload);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        assertFalse(payloadJson.contains("sk-abcdefghijklmnopqrstuvwxyz123456"));
        assertTrue(payloadJson.contains("«redacted:secret»"));
        assertEquals("«redacted:secret»", payload.path("apiKey").asText());
        assertEquals("«redacted:secret»", payload.path("nested").path("authorization").asText());
        assertTrue(list.path("items").get(0).path("redactedFields").size() > 0);
    }

    @Test
    void 限额截断_超过64KB载荷truncated为true且保留contentHash() {
        AuthedUser user = client().register("a2a6@test.local");
        String token = user.accessToken();

        String big = "x".repeat(70 * 1024);
        client().post("/v1/a2a/messages/bulk", map("items", List.of(
                msg("messageId", "m-big", "contentHash", "hash-big", "payload", map("text", big)))), token);

        JsonNode list = ApiClient.dataOf(client().get("/v1/a2a/messages?taskId=t1", token));
        assertTrue(list.path("items").get(0).path("truncated").asBoolean());
        assertEquals("hash-big", list.path("items").get(0).path("contentHash").asText());
        assertFalse(list.path("items").get(0).path("payload").toString().contains(big.substring(0, 100)));
    }

    @Test
    void 卡片镜像上行_幂等() {
        AuthedUser user = client().register("a2a7@test.local");
        String token = user.accessToken();

        Map<String, Object> card = map(
                "cardId", "card-agent-worker-1-v1", "agentId", "agent-worker-1", "cardVersion", 1,
                "role", "worker", "createTime", NOW,
                "fatherAgentId", "agent-prime_director-1", "fatherRole", "prime_director",
                "lineage", List.of("agent-prime_director-1"), "status", "ready",
                "ability", map("tools", List.of("file.read")), "permission", map("tier", "L2"),
                "fingerprint", "fp-1", "expiresAt", NOW + 86_400_000L);

        JsonNode first = ApiClient.dataOf(client().post("/v1/a2a/cards/bulk", map("items", List.of(card)), token));
        assertEquals(1, first.path("created").asInt());

        JsonNode again = ApiClient.dataOf(client().post("/v1/a2a/cards/bulk", map("items", List.of(card)), token));
        assertEquals(0, again.path("created").asInt());
        assertEquals(1, again.path("updated").asInt());
    }

    @Test
    void 契约_批量上限与字段校验() {
        AuthedUser user = client().register("a2a8@test.local");
        String token = user.accessToken();

        List<Map<String, Object>> tooMany = new ArrayList<>();
        for (int i = 0; i < 501; i++) tooMany.add(msg("messageId", "m-" + i));
        assertEquals(400, client().post("/v1/a2a/messages/bulk", map("items", tooMany), token).status());

        assertEquals(400, client().post("/v1/a2a/messages/bulk",
                map("items", List.of(msg("verdict", "unknown"))), token).status());
    }
}
