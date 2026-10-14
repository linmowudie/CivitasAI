package com.civitas.server.integration;

import com.civitas.server.helpers.ApiClient.ApiResponse;
import com.civitas.server.helpers.ApiClient.AuthedUser;
import com.civitas.server.helpers.IntegrationTest;
import com.civitas.server.json.Json;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 集成测试：设置管理（修订号乐观并发 / 浅合并 / 体积上限 / 重置）
 * —— 与 TS 版 `test/integration/settings.spec.ts` 对位。
 */
class SettingsIntegrationTest extends IntegrationTest {

    private AuthedUser register(String email) {
        return client().register(email);
    }

    /** 便捷构造请求体（键值交替） */
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) map.put((String) kv[i], kv[i + 1]);
        return map;
    }

    private static JsonNode json(String raw) {
        try {
            return Json.MAPPER.readTree(raw);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void 初始为空revision为0_写入后revision为1且可读回() {
        AuthedUser user = register("settings@example.com");

        ApiResponse empty = client().get("/v1/settings", user.accessToken());
        JsonNode emptyData = client().dataOf(empty);
        assertEquals(0, emptyData.path("revision").asInt());
        assertEquals(0, emptyData.path("data").size());

        ApiResponse put = client().put("/v1/settings",
                map("data", json("{\"theme\":\"dark\",\"ui\":{\"fontScale\":1.1}}")), user.accessToken());
        assertEquals(200, put.status());
        assertEquals(1, client().dataOf(put).path("revision").asInt());

        ApiResponse read = client().get("/v1/settings", user.accessToken());
        assertEquals(json("{\"theme\":\"dark\",\"ui\":{\"fontScale\":1.1}}"),
                client().dataOf(read).path("data"));
    }

    @Test
    void 每次写入revision递增_服务端权威() {
        AuthedUser user = register("settings2@example.com");
        JsonNode r1 = client().dataOf(client().put("/v1/settings", map("data", json("{\"a\":1}")), user.accessToken()));
        JsonNode r2 = client().dataOf(client().put("/v1/settings", map("data", json("{\"a\":2}")), user.accessToken()));
        JsonNode r3 = client().dataOf(client().put("/v1/settings", map("data", json("{\"a\":3}")), user.accessToken()));
        assertEquals(1, r1.path("revision").asInt());
        assertEquals(2, r2.path("revision").asInt());
        assertEquals(3, r3.path("revision").asInt());
    }

    @Test
    void 乐观并发_expectedRevision不匹配409且附当前版本() {
        AuthedUser user = register("settings3@example.com");
        client().put("/v1/settings", map("data", json("{\"a\":1}")), user.accessToken());

        ApiResponse stale = client().put("/v1/settings",
                map("data", json("{\"a\":2}"), "expectedRevision", 0), user.accessToken());
        assertEquals(409, stale.status());
        assertEquals("REVISION_MISMATCH", stale.errorCode());
        assertEquals(1, stale.error().path("details").path("currentRevision").asInt());

        ApiResponse fresh = client().put("/v1/settings",
                map("data", json("{\"a\":2}"), "expectedRevision", 1), user.accessToken());
        assertEquals(200, fresh.status());
        assertEquals(2, client().dataOf(fresh).path("revision").asInt());
    }

    @Test
    void PATCH浅合并_null删除键() {
        AuthedUser user = register("settings4@example.com");
        client().put("/v1/settings", map("data", json("{\"theme\":\"dark\",\"lang\":\"zh\",\"keep\":true}")),
                user.accessToken());

        ApiResponse patched = client().patch("/v1/settings",
                map("patch", json("{\"theme\":\"light\",\"lang\":null,\"added\":42}")), user.accessToken());
        JsonNode data = client().dataOf(patched);
        assertEquals(json("{\"theme\":\"light\",\"keep\":true,\"added\":42}"), data.path("data"));
        assertEquals(2, data.path("revision").asInt());
    }

    @Test
    void PATCH也支持乐观并发() {
        AuthedUser user = register("settings5@example.com");
        client().put("/v1/settings", map("data", json("{\"a\":1}")), user.accessToken());
        ApiResponse conflict = client().patch("/v1/settings",
                map("patch", json("{\"a\":2}"), "expectedRevision", 5), user.accessToken());
        assertEquals(409, conflict.status());
    }

    @Test
    void 超过体积上限413_含合并后的总体积() {
        AuthedUser user = register("settings6@example.com");
        Map<String, Object> big = map("blob", "x".repeat(5000)); // testConfig 上限 4096 字节
        ApiResponse res = client().put("/v1/settings", map("data", big), user.accessToken());
        assertEquals(413, res.status());
        assertEquals("PAYLOAD_TOO_LARGE", res.errorCode());
        assertTrue(res.errorMessage().startsWith("设置体积超限"), res.errorMessage());

        // 分多次 patch 也不能绕过：合并后的总体积仍受上限约束
        client().put("/v1/settings", map("data", map("first", "x".repeat(3000))), user.accessToken());
        ApiResponse patchBig = client().patch("/v1/settings",
                map("patch", map("second", "y".repeat(3000))), user.accessToken()); // 3000 + 3000 > 4096
        assertEquals(413, patchBig.status());
    }

    @Test
    void 重置设置后回到revision为0() {
        AuthedUser user = register("settings7@example.com");
        client().put("/v1/settings", map("data", json("{\"a\":1}")), user.accessToken());

        ApiResponse reset = client().delete("/v1/settings", user.accessToken());
        assertTrue(client().dataOf(reset).path("reset").asBoolean());

        ApiResponse after = client().get("/v1/settings", user.accessToken());
        JsonNode data = client().dataOf(after);
        assertEquals(0, data.path("revision").asInt());
        assertEquals(0, data.path("data").size());
    }

    @Test
    void 未鉴权访问401_用户间设置互相隔离() {
        assertEquals(401, client().get("/v1/settings", null).status());

        AuthedUser user = register("settings8@example.com");
        AuthedUser other = register("other-settings@example.com");
        client().put("/v1/settings", map("data", map("mine", true)), user.accessToken());
        ApiResponse otherRead = client().get("/v1/settings", other.accessToken());
        assertEquals(0, client().dataOf(otherRead).path("data").size());
    }

    @Test
    void 请求体缺data字段400() {
        AuthedUser user = register("settings9@example.com");
        ApiResponse res = client().put("/v1/settings", map("wrong", true), user.accessToken());
        assertEquals(400, res.status());
        assertEquals("VALIDATION_ERROR", res.errorCode());
    }
}
