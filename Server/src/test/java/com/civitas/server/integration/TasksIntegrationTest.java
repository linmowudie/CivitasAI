package com.civitas.server.integration;

import com.civitas.server.db.Db;
import com.civitas.server.helpers.ApiClient;
import com.civitas.server.helpers.ApiClient.AuthedUser;
import com.civitas.server.helpers.IntegrationTest;
import com.civitas.server.helpers.TestDb;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 集成测试：任务（会话）元数据 —— 标题 + 归档状态。
 * 与 TS 版 `test/integration/tasks.spec.ts` 对位。
 *
 * 覆盖：
 *  - upsert 幂等（同一 clientSessionId 重复上行不产生重复项）；
 *  - 归档状态后端权威（archivedAt 置值/清空）；
 *  - 按归档状态过滤（active / archived / all）；
 *  - 账号隔离（B 看不到 A 的任务，批量上行也只落自己名下）；
 *  - 备份包包含任务元数据，且 replace 恢复能重建归档状态。
 */
class TasksIntegrationTest extends IntegrationTest {

    private static final long NOW = 1_800_000_000_000L;

    private Db db() {
        return TestDb.getTestDb();
    }

    /** 便捷构造请求体（键值交替） */
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) map.put((String) kv[i], kv[i + 1]);
        return map;
    }

    private static List<String> sessionIds(JsonNode listData) {
        List<String> ids = new ArrayList<>();
        listData.path("items").forEach(item -> ids.add(item.path("clientSessionId").asText()));
        return ids;
    }

    @Test
    void 批量上行后可按归档状态查询_重复上行幂等() {
        AuthedUser user = client().register("tasks@example.com");
        String token = user.accessToken();

        JsonNode first = ApiClient.dataOf(client().post("/v1/tasks/bulk", map("items", List.of(
                map("clientSessionId", "sess-1", "title", "任务一", "createdAt", NOW, "updatedAt", NOW),
                map("clientSessionId", "sess-2", "title", "任务二", "createdAt", NOW, "updatedAt", NOW + 1))),
                token));
        assertEquals(2, first.path("created").asInt());
        assertEquals(0, first.path("updated").asInt());

        // 再次上行同一批 → 全部为 updated，不产生重复
        JsonNode again = ApiClient.dataOf(client().post("/v1/tasks/bulk", map("items", List.of(
                map("clientSessionId", "sess-1", "title", "任务一（改名）", "createdAt", NOW, "updatedAt", NOW + 5))),
                token));
        assertEquals(0, again.path("created").asInt());
        assertEquals(1, again.path("updated").asInt());

        JsonNode all = ApiClient.dataOf(client().get("/v1/tasks", token));
        assertEquals(2, all.path("items").size());
        for (JsonNode item : all.path("items")) {
            if ("sess-1".equals(item.path("clientSessionId").asText())) {
                assertEquals("任务一（改名）", item.path("title").asText());
            }
        }
    }

    @Test
    void 归档状态_置值后可筛选_清空后回到未归档() {
        AuthedUser user = client().register("tasks2@example.com");
        String token = user.accessToken();

        client().post("/v1/tasks/bulk", map("items", List.of(
                map("clientSessionId", "keep", "title", "保留", "createdAt", NOW, "updatedAt", NOW),
                map("clientSessionId", "old", "title", "旧任务", "createdAt", NOW, "updatedAt", NOW + 1,
                        "archivedAt", NOW + 2))), token);

        JsonNode active = ApiClient.dataOf(client().get("/v1/tasks?archived=false", token));
        assertEquals(List.of("keep"), sessionIds(active));

        JsonNode archived = ApiClient.dataOf(client().get("/v1/tasks?archived=true", token));
        assertEquals(List.of("old"), sessionIds(archived));
        assertEquals(NOW + 2, archived.path("items").get(0).path("archivedAt").asLong());

        JsonNode all = ApiClient.dataOf(client().get("/v1/tasks?archived=all", token));
        assertEquals(2, all.path("items").size());

        // 取消归档（archivedAt 清空）
        client().post("/v1/tasks/bulk", map("items", List.of(
                map("clientSessionId", "old", "title", "旧任务", "createdAt", NOW, "updatedAt", NOW + 9,
                        "archivedAt", null))), token);
        JsonNode activeAfter = ApiClient.dataOf(client().get("/v1/tasks?archived=false", token));
        List<String> ids = sessionIds(activeAfter);
        ids.sort(String::compareTo);
        assertEquals(List.of("keep", "old"), ids);
    }

    @Test
    void 账号隔离_B看不到A的任务() {
        AuthedUser user = client().register("tasks3@example.com");
        String token = user.accessToken();
        client().post("/v1/tasks/bulk", map("items", List.of(
                map("clientSessionId", "a-1", "title", "A 的任务", "createdAt", NOW, "updatedAt", NOW))), token);

        AuthedUser other = client().register("tasks3-b@example.com");
        JsonNode bList = ApiClient.dataOf(client().get("/v1/tasks", other.accessToken()));
        assertEquals(0, bList.path("items").size());

        // B 上行同名 clientSessionId 也只落在 B 名下，不影响 A
        client().post("/v1/tasks/bulk", map("items", List.of(
                map("clientSessionId", "a-1", "title", "B 的同名任务", "createdAt", NOW, "updatedAt", NOW))),
                other.accessToken());

        JsonNode aList = ApiClient.dataOf(client().get("/v1/tasks", token));
        assertEquals(1, aList.path("items").size());
        assertEquals("A 的任务", aList.path("items").get(0).path("title").asText());
    }

    @Test
    void 校验_空items_缺少时间戳_超500条均400() {
        AuthedUser user = client().register("tasks4@example.com");
        String token = user.accessToken();

        assertEquals(400, client().post("/v1/tasks/bulk", map("items", List.of()), token).status());
        assertEquals(400, client().post("/v1/tasks/bulk",
                map("items", List.of(map("clientSessionId", "x"))), token).status());

        List<Map<String, Object>> tooMany = new ArrayList<>();
        for (int i = 0; i < 501; i++) {
            tooMany.add(map("clientSessionId", "s-" + i, "title", "t", "createdAt", NOW, "updatedAt", NOW));
        }
        assertEquals(400, client().post("/v1/tasks/bulk", map("items", tooMany), token).status());
    }

    @Test
    void 未鉴权无法读写任务() {
        assertEquals(401, client().get("/v1/tasks", null).status());
        assertEquals(401, client().post("/v1/tasks/bulk", map("items", List.of(
                map("clientSessionId", "x", "createdAt", NOW, "updatedAt", NOW))), null).status());
    }

    @Test
    void 备份包含任务元数据_replace恢复后归档状态完整回来() {
        AuthedUser user = client().register("tasks5@example.com");
        String token = user.accessToken();

        client().post("/v1/tasks/bulk", map("items", List.of(
                map("clientSessionId", "sess-a", "title", "正常任务", "createdAt", NOW, "updatedAt", NOW),
                map("clientSessionId", "sess-b", "title", "已归档任务", "createdAt", NOW, "updatedAt", NOW + 1,
                        "archivedAt", NOW + 2))), token);

        JsonNode bundle = ApiClient.dataOf(client().get("/v1/backup", token));
        assertEquals(2, bundle.path("tasks").size());
        for (JsonNode task : bundle.path("tasks")) {
            if ("sess-b".equals(task.path("clientSessionId").asText())) {
                assertEquals(NOW + 2, task.path("archivedAt").asLong());
            }
        }

        // 模拟重装：清空服务端任务元数据后再恢复
        db().execute("DELETE FROM user_tasks WHERE user_id = $1", user.user().path("id").asText());
        assertEquals(0, ApiClient.dataOf(client().get("/v1/tasks", token)).path("items").size());

        JsonNode report = ApiClient.dataOf(client().post("/v1/restore",
                map("bundle", bundle, "mode", "replace"), token));
        assertEquals(2, report.path("tasks").path("created").asInt());

        JsonNode restored = ApiClient.dataOf(client().get("/v1/tasks?archived=true", token));
        assertEquals(List.of("sess-b"), sessionIds(restored));
        assertEquals("已归档任务", restored.path("items").get(0).path("title").asText());
    }
}
