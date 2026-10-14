package com.civitas.server.integration;

import com.civitas.server.db.Db;
import com.civitas.server.helpers.ApiClient.ApiResponse;
import com.civitas.server.helpers.ApiClient.AuthedUser;
import com.civitas.server.helpers.IntegrationTest;
import com.civitas.server.helpers.TestDb;
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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 集成测试：记忆存储（幂等 upsert / 分页 / 中文与拉丁检索 / 软删除 / 批量 / 隔离）
 * —— 与 TS 版 `test/integration/memories.spec.ts` 对位。
 */
class MemoriesIntegrationTest extends IntegrationTest {

    private Db db() {
        return TestDb.getTestDb();
    }

    /** 便捷构造请求体（键值交替） */
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) map.put((String) kv[i], kv[i + 1]);
        return map;
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private AuthedUser register(String email) {
        return client().register(email);
    }

    @Test
    void 新建返回201_同clientMemoryId再传200且原地更新_幂等() {
        AuthedUser user = register("memory@example.com");
        ApiResponse created = client().post("/v1/memories", map(
                "clientMemoryId", "client-m-1",
                "title", "项目偏好",
                "content", "用户偏好暗色主题",
                "category", "preference",
                "sourceTraceIds", List.of("trace-1")), user.accessToken());
        assertEquals(201, created.status());
        JsonNode first = client().dataOf(created);
        assertTrue(first.path("created").asBoolean());
        assertEquals("client-m-1", first.path("memory").path("clientMemoryId").asText());
        assertEquals(0, first.path("memory").path("accessCount").asInt());

        ApiResponse again = client().post("/v1/memories", map(
                "clientMemoryId", "client-m-1",
                "title", "项目偏好（更新）",
                "content", "改为浅色主题"), user.accessToken());
        assertEquals(200, again.status());
        JsonNode second = client().dataOf(again);
        assertFalse(second.path("created").asBoolean());
        assertEquals(first.path("memory").path("id").asText(), second.path("memory").path("id").asText());
        assertEquals("项目偏好（更新）", second.path("memory").path("title").asText());
        assertEquals("改为浅色主题", second.path("memory").path("content").asText());

        Map<String, Object> count = db().one("SELECT COUNT(*)::int AS count FROM memories");
        assertNotNull(count);
        assertEquals(1L, Db.longOf(count, "count"));
    }

    @Test
    void 无clientMemoryId时每次新建独立记录() {
        AuthedUser user = register("memory2@example.com");
        client().post("/v1/memories", map("title", "a", "content", "x"), user.accessToken());
        client().post("/v1/memories", map("title", "b", "content", "y"), user.accessToken());
        ApiResponse list = client().get("/v1/memories", user.accessToken());
        assertEquals(2, client().dataOf(list).path("items").size());
    }

    @Test
    void 键集分页_limit加nextCursor连续翻页且不重复() throws InterruptedException {
        AuthedUser user = register("memory3@example.com");
        for (int i = 1; i <= 5; i++) {
            client().post("/v1/memories", map(
                    "title", "记忆" + i, "content", "内容" + i, "clientMemoryId", "m" + i), user.accessToken());
            Thread.sleep(5); // 保证 created_at 递增，分页稳定
        }

        ApiResponse page1Res = client().get("/v1/memories?limit=2", user.accessToken());
        JsonNode page1 = client().dataOf(page1Res);
        assertEquals(2, page1.path("items").size());
        String cursor1 = page1.path("nextCursor").asText("");
        assertFalse(cursor1.isEmpty());

        JsonNode page2 = client().dataOf(client().get("/v1/memories?limit=2&cursor=" + cursor1, user.accessToken()));
        assertEquals(2, page2.path("items").size());
        String cursor2 = page2.path("nextCursor").asText("");

        JsonNode page3 = client().dataOf(client().get("/v1/memories?limit=2&cursor=" + cursor2, user.accessToken()));
        assertEquals(1, page3.path("items").size());
        assertTrue(page3.path("nextCursor").isNull());

        List<String> ids = new ArrayList<>();
        for (JsonNode page : List.of(page1, page2, page3)) {
            page.path("items").forEach(item -> ids.add(item.path("id").asText()));
        }
        assertEquals(5, ids.stream().distinct().count());
    }

    @Test
    void 检索_中文走ILIKE_拉丁走全文检索_可按分类与状态过滤() {
        AuthedUser user = register("memory4@example.com");
        client().post("/v1/memories", map("title", "部署流程", "content", "服务器使用 docker compose 启动",
                "category", "ops"), user.accessToken());
        client().post("/v1/memories", map("title", "deployment notes", "content", "use docker compose for release",
                "category", "ops"), user.accessToken());
        client().post("/v1/memories", map("title", "读书笔记", "content", "关于分布式系统",
                "category", "reading"), user.accessToken());
        client().post("/v1/memories", map("title", "归档项", "content", "服务器的旧记录",
                "category", "ops", "status", "archived"), user.accessToken());

        JsonNode cjk = client().dataOf(client().get("/v1/memories?q=" + encode("服务器"), user.accessToken()));
        assertEquals(2, cjk.path("items").size()); // 部署流程 + 归档项（archived 仍在列表中，只是 status 不同）

        JsonNode latin = client().dataOf(client().get("/v1/memories?q=deployment", user.accessToken()));
        assertEquals(1, latin.path("items").size());
        assertEquals("deployment notes", latin.path("items").get(0).path("title").asText());

        JsonNode byCategory = client().dataOf(client().get("/v1/memories?category=reading", user.accessToken()));
        assertEquals(1, byCategory.path("items").size());

        JsonNode byStatus = client().dataOf(client().get("/v1/memories?status=archived", user.accessToken()));
        assertEquals(1, byStatus.path("items").size());
        assertEquals("archived", byStatus.path("items").get(0).path("status").asText());
    }

    @Test
    void 更新PATCH与软删除_默认不出现在列表_hard物理删除() {
        AuthedUser user = register("memory5@example.com");
        JsonNode created = client().dataOf(client().post("/v1/memories",
                map("title", "可更新", "content", "v1"), user.accessToken())).path("memory");

        ApiResponse patchedRes = client().patch("/v1/memories/" + created.path("id").asText(),
                map("content", "v2", "accessCount", 7, "status", "archived"), user.accessToken());
        JsonNode patched = client().dataOf(patchedRes);
        assertEquals("v2", patched.path("content").asText());
        assertEquals(7, patched.path("accessCount").asInt());
        assertEquals("archived", patched.path("status").asText());

        ApiResponse softDeleted = client().delete("/v1/memories/" + created.path("id").asText(), user.accessToken());
        assertFalse(client().dataOf(softDeleted).path("hard").asBoolean());

        JsonNode list = client().dataOf(client().get("/v1/memories", user.accessToken()));
        assertEquals(0, list.path("items").size());

        Map<String, Object> stillThere = db().one(
                "SELECT COUNT(*)::int AS count FROM memories WHERE status = 'deleted'");
        assertNotNull(stillThere);
        assertEquals(1L, Db.longOf(stillThere, "count"));

        // 详情仍可查（墓碑）
        ApiResponse detail = client().get("/v1/memories/" + created.path("id").asText(), user.accessToken());
        assertEquals(200, detail.status());

        // 重复删除 → 404
        ApiResponse again = client().delete("/v1/memories/" + created.path("id").asText(), user.accessToken());
        assertEquals(404, again.status());
    }

    @Test
    void 批量upsert_区分新增与更新_且原子提交() {
        AuthedUser user = register("memory6@example.com");
        client().post("/v1/memories", map("clientMemoryId", "b1", "title", "原有", "content", "c"),
                user.accessToken());

        ApiResponse res = client().post("/v1/memories/bulk", map("items", List.of(
                map("clientMemoryId", "b1", "title", "原有（改）", "content", "c2"),
                map("clientMemoryId", "b2", "title", "新增一", "content", "c3"),
                map("clientMemoryId", "b3", "title", "新增二", "content", "c4"))), user.accessToken());
        assertEquals(200, res.status());
        JsonNode data = client().dataOf(res);
        assertEquals(2, data.path("created").asInt());
        assertEquals(1, data.path("updated").asInt());
        assertEquals(3, data.path("total").asInt());

        JsonNode list = client().dataOf(client().get("/v1/memories", user.accessToken()));
        assertEquals(3, list.path("items").size());
    }

    @Test
    void 批量超过上限413() {
        AuthedUser user = register("memory7@example.com");
        List<Map<String, Object>> items = new ArrayList<>();
        for (int i = 0; i < 101; i++) { // testConfig 上限 100
            items.add(map("title", "t" + i, "content", "c"));
        }
        ApiResponse res = client().post("/v1/memories/bulk", map("items", items), user.accessToken());
        assertEquals(413, res.status());
        assertEquals("PAYLOAD_TOO_LARGE", res.errorCode());
    }

    @Test
    void 用户隔离_不能读取修改删除他人记忆() {
        AuthedUser user = register("memory8@example.com");
        JsonNode mine = client().dataOf(client().post("/v1/memories",
                map("title", "我的秘密", "content", "secret"), user.accessToken())).path("memory");
        String mineId = mine.path("id").asText();

        AuthedUser other = register("memory-other@example.com");
        String otherToken = other.accessToken();

        assertEquals(404, client().get("/v1/memories/" + mineId, otherToken).status());
        assertEquals(404, client().patch("/v1/memories/" + mineId, map("content", "篡改"), otherToken).status());
        assertEquals(404, client().delete("/v1/memories/" + mineId, otherToken).status());

        JsonNode otherList = client().dataOf(client().get("/v1/memories", otherToken));
        assertEquals(0, otherList.path("items").size());

        // 原数据未被篡改
        JsonNode mineAfter = client().dataOf(client().get("/v1/memories/" + mineId, user.accessToken()));
        assertEquals("secret", mineAfter.path("content").asText());
    }

    @Test
    void 校验_标题必填_状态枚举非法400_未鉴权401() {
        AuthedUser user = register("memory9@example.com");
        assertEquals(400, client().post("/v1/memories", map("content", "no title"), user.accessToken()).status());
        assertEquals(400, client().post("/v1/memories",
                map("title", "x", "content", "y", "status", "weird"), user.accessToken()).status());
        assertEquals(401, client().get("/v1/memories", null).status());
    }
}
