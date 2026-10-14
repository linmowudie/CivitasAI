package com.civitas.server.integration;

import com.civitas.server.db.Db;
import com.civitas.server.helpers.ApiClient;
import com.civitas.server.helpers.ApiClient.AuthedUser;
import com.civitas.server.helpers.IntegrationTest;
import com.civitas.server.helpers.TestDb;
import com.civitas.server.json.Json;
import com.civitas.server.repositories.MemoriesRepository;
import com.civitas.server.services.BackupService;
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
 * 集成测试：备份 / 恢复 —— 核心场景「卸载重装后重建」。
 * 与 TS 版 `test/integration/backup.spec.ts` 对位。
 *
 * 场景：A 设备写入设置（含多次修订）+ 记忆 + 统计 → 导出备份包 →
 *      模拟“软件被卸载、本地数据全丢”（服务端数据清空）→ 用同一账号登录 →
 *      用备份包恢复 → 数据完整回来，且 revision/内容/统计一致。
 */
class BackupIntegrationTest extends IntegrationTest {

    /** 便捷构造请求体（键值交替） */
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) map.put((String) kv[i], kv[i + 1]);
        return map;
    }

    private static JsonNode bundleFromDownload(ApiClient.ApiResponse response) {
        try {
            return Json.MAPPER.readTree(response.rawBody());
        } catch (Exception e) {
            throw new IllegalStateException("下载响应不是 JSON", e);
        }
    }

    /** 写入一批可校验的样例数据；返回期望值 */
    private record Seed(Map<String, Object> settingsData, int memoryCount, int statEventCount) {}

    private Seed seed(String token) {
        Map<String, Object> settingsData = map(
                "theme", "dark", "language", "zh-CN", "providers", map("default", "GLM-5.1"));
        client().put("/v1/settings", map("data", settingsData), token);
        client().patch("/v1/settings", map("patch", map("fontScale", 1.15)), token); // revision → 2

        for (int i = 1; i <= 3; i++) {
            client().post("/v1/memories", map(
                    "clientMemoryId", "local-memory-" + i,
                    "title", "记忆 " + i,
                    "content", "这是第 " + i + " 条记忆内容",
                    "category", i == 1 ? "preference" : "fact",
                    "sourceTraceIds", List.of("trace-" + i)), token);
        }

        client().post("/v1/stats/events", map("events", List.of(
                map("kind", "chat.turn", "value", 100, "occurredAt", "2026-03-01T01:00:00.000Z", "clientEventId", "s1"),
                map("kind", "chat.turn", "value", 200, "occurredAt", "2026-03-01T02:00:00.000Z", "clientEventId", "s2"),
                map("kind", "tool.call", "value", 1, "occurredAt", "2026-03-01T03:00:00.000Z", "clientEventId", "s3"))),
                token);

        return new Seed(settingsData, 3, 3);
    }

    @Test
    void 导出包含账户摘要_设置_记忆与可选统计() {
        AuthedUser user = client().register("backup@example.com", "Passw0rd123", "备份用户");
        String token = user.accessToken();
        Seed expected = seed(token);

        JsonNode withoutStats = ApiClient.dataOf(client().get("/v1/backup", token));
        assertEquals("civitas.backup", withoutStats.path("format").asText());
        assertEquals(1, withoutStats.path("version").asInt());
        assertEquals("backup@example.com", withoutStats.path("account").path("email").asText());
        assertEquals(Json.MAPPER.valueToTree(map(
                        "theme", "dark", "language", "zh-CN", "providers", map("default", "GLM-5.1"),
                        "fontScale", 1.15)),
                withoutStats.path("settings").path("data"));
        assertEquals(2, withoutStats.path("settings").path("revision").asInt());
        assertEquals(3, withoutStats.path("memories").size());
        assertTrue(withoutStats.path("stats").isNull()); // 默认不含统计

        JsonNode withStats = ApiClient.dataOf(client().get("/v1/backup?includeStats=true", token));
        assertEquals(3, withStats.path("stats").path("events").size());
    }

    @Test
    void 下载端点返回附件头与完整JSON内容() {
        AuthedUser user = client().register("backup2@example.com", "Passw0rd123", "备份用户");
        String token = user.accessToken();
        seed(token);

        ApiClient.ApiResponse res = client().get("/v1/backup/download", token);
        assertEquals(200, res.status());
        assertTrue(res.header("Content-Disposition").contains("attachment; filename=\"civitas-backup-"));
        assertTrue(res.header("Content-Type").contains("application/json"));

        JsonNode parsed = bundleFromDownload(res);
        assertEquals("civitas.backup", parsed.path("format").asText());
        assertEquals(3, parsed.path("memories").size());
    }

    @Test
    void SV001_记忆导出键集分页取全量_不受单页上限静默截断() {
        AuthedUser user = client().register("backup3@example.com", "Passw0rd123", "备份用户");
        String token = user.accessToken();
        String userId = user.user().path("id").asText();

        // 直接写入 5 条（固定时间戳，保证分页边界可控）
        for (int i = 1; i <= 5; i++) {
            TestDb.getTestDb().execute(
                    "INSERT INTO memories (user_id, title, content, category, assertion, status, created_at, last_accessed_at) "
                            + "VALUES ($1, $2, $3, 'general', 'observed', 'active', $4, $4)",
                    userId, "分页记忆 " + i, "内容 " + i, Instant.parse("2026-03-01T00:0" + i + ":00.000Z"));
        }

        // 仓库层：pageSize=2 仍返回全部 5 条（旧实现这里只返回 2 条，即“静默截断”复现）
        List<String> titles = MemoriesRepository.listAllMemories(TestDb.getTestDb(), userId, 2)
                .stream().map(MemoriesRepository.MemoryRow::title).toList();
        assertEquals(List.of("分页记忆 1", "分页记忆 2", "分页记忆 3", "分页记忆 4", "分页记忆 5"), titles);

        // HTTP 层：备份包完整包含 5 条，且无 truncated 标记
        JsonNode bundle = ApiClient.dataOf(client().get("/v1/backup", token));
        assertEquals(5, bundle.path("memories").size());
        assertTrue(bundle.path("truncated").isMissingNode());
    }

    @Test
    void SV001_统计默认全量导出_显式statsLimit超限时包内truncated如实标注() {
        AuthedUser user = client().register("backup4@example.com", "Passw0rd123", "备份用户");
        String token = user.accessToken();
        seed(token); // 3 条统计事件

        // 默认（不设 statsLimit）：全量导出，无标记
        JsonNode full = ApiClient.dataOf(client().get("/v1/backup?includeStats=true", token));
        assertEquals(3, full.path("stats").path("events").size());
        assertTrue(full.path("truncated").isMissingNode());

        // 显式设限（statsLimit=2，3 条事件超限）→ 截断必须显式标注
        JsonNode cappedHttp =
                ApiClient.dataOf(client().get("/v1/backup?includeStats=true&statsLimit=2", token));
        assertEquals(2, cappedHttp.path("stats").path("events").size());
        assertEquals(2, cappedHttp.path("truncated").path("stats").path("limit").asInt());
        assertTrue(cappedHttp.path("truncated").path("stats").path("reason").asText().contains("statsLimit"));

        // 未超限（statsLimit=10）→ 无标记
        JsonNode roomyHttp =
                ApiClient.dataOf(client().get("/v1/backup?includeStats=true&statsLimit=10", token));
        assertEquals(3, roomyHttp.path("stats").path("events").size());
        assertTrue(roomyHttp.path("truncated").isMissingNode());

        // 下载端点同样透传（直接返回备份 JSON，非 {ok,data} 包装）
        ApiClient.ApiResponse downloadRes =
                client().get("/v1/backup/download?includeStats=true&statsLimit=1", token);
        assertEquals(200, downloadRes.status());
        JsonNode downloadBundle = bundleFromDownload(downloadRes);
        assertEquals(1, downloadBundle.path("stats").path("events").size());
        assertEquals(1, downloadBundle.path("truncated").path("stats").path("limit").asInt());

        // 非法 statsLimit → 400（校验而非静默忽略）
        ApiClient.ApiResponse bad = client().get("/v1/backup?includeStats=true&statsLimit=abc", token);
        assertEquals(400, bad.status());
        assertEquals("VALIDATION_ERROR", bad.errorCode());
        assertEquals(400, client().get("/v1/backup?includeStats=true&statsLimit=0", token).status());

        // 服务层直调（保持既有覆盖）
        BackupService.BackupBundle capped =
                app.context.getBean(BackupService.class).export(user.user().path("id").asText(), true, 2);
        assertEquals(2, capped.stats().events().size());
        assertEquals(2, capped.truncated().stats().limit());
    }

    @Test
    void 卸载重装场景_导出_数据清空_恢复replace_数据完整回来() {
        AuthedUser user = client().register("backup5@example.com", "Passw0rd123", "备份用户");
        String token = user.accessToken();
        String userId = user.user().path("id").asText();
        Seed expected = seed(token);
        JsonNode bundle = ApiClient.dataOf(client().get("/v1/backup?includeStats=true", token));

        // 模拟“服务端数据丢失/新设备重建”：清掉该用户的所有数据（保留账号与令牌）
        TestDb.getTestDb().execute("DELETE FROM user_settings WHERE user_id = $1", userId);
        TestDb.getTestDb().execute("DELETE FROM memories WHERE user_id = $1", userId);
        TestDb.getTestDb().execute("DELETE FROM usage_events WHERE user_id = $1", userId);

        JsonNode afterWipe = ApiClient.dataOf(client().get("/v1/backup", token));
        assertEquals(0, afterWipe.path("memories").size());
        assertTrue(afterWipe.path("settings").isNull());

        // 用备份包重建
        ApiClient.ApiResponse restore = client().post("/v1/restore", map("bundle", bundle, "mode", "replace"), token);
        assertEquals(200, restore.status());
        JsonNode report = ApiClient.dataOf(restore);
        assertEquals("replace", report.path("mode").asText());
        assertEquals(expected.memoryCount(), report.path("memories").path("created").asInt());
        assertEquals(0, report.path("memories").path("updated").asInt());
        assertEquals(expected.memoryCount(), report.path("memories").path("total").asInt());
        assertEquals(expected.statEventCount(), report.path("stats").path("accepted").asInt());
        assertTrue(report.path("settings").path("restored").asBoolean());

        // 校验设置（内容一致）
        JsonNode settings = ApiClient.dataOf(client().get("/v1/settings", token));
        assertEquals(Json.MAPPER.valueToTree(map(
                        "theme", "dark", "language", "zh-CN", "providers", map("default", "GLM-5.1"),
                        "fontScale", 1.15)),
                settings.path("data"));

        // 校验记忆（clientMemoryId 保留，便于端侧再次对齐）
        JsonNode memories = ApiClient.dataOf(client().get("/v1/memories", token));
        assertEquals(expected.memoryCount(), memories.path("items").size());
        List<String> clientIds = new ArrayList<>();
        memories.path("items").forEach(m -> clientIds.add(m.path("clientMemoryId").asText()));
        clientIds.sort(String::compareTo);
        assertEquals(List.of("local-memory-1", "local-memory-2", "local-memory-3"), clientIds);

        // 校验统计
        JsonNode summary = ApiClient.dataOf(client().get(
                "/v1/stats/summary?from=2026-03-01T00:00:00.000Z&to=2026-03-02T00:00:00.000Z", token));
        assertEquals(expected.statEventCount(), summary.path("totalEvents").asInt());
        assertEquals(301, summary.path("totalValue").asDouble());

        // 重复恢复（replace）应保持幂等，不产生重复记忆
        JsonNode again = ApiClient.dataOf(client().post("/v1/restore", map("bundle", bundle, "mode", "replace"), token));
        assertEquals(expected.memoryCount(), again.path("memories").path("created").asInt());
        assertEquals(expected.memoryCount(),
                ApiClient.dataOf(client().get("/v1/memories", token)).path("items").size());
    }

    @Test
    void merge模式_按clientMemoryId幂等合并_不删除既有数据() {
        AuthedUser user = client().register("backup6@example.com", "Passw0rd123", "备份用户");
        String token = user.accessToken();
        seed(token);
        JsonNode bundle = ApiClient.dataOf(client().get("/v1/backup", token));

        // 新增一条“备份包里没有”的本地记忆
        client().post("/v1/memories",
                map("clientMemoryId", "local-only", "title", "恢复后新增", "content", "x"), token);

        JsonNode report = ApiClient.dataOf(client().post("/v1/restore", map("bundle", bundle, "mode", "merge"), token));
        assertEquals("merge", report.path("mode").asText());
        assertEquals(3, report.path("memories").path("updated").asInt()); // 三条同 clientMemoryId 已存在 → 更新
        assertEquals(0, report.path("memories").path("created").asInt());

        assertEquals(4, ApiClient.dataOf(client().get("/v1/memories", token)).path("items").size()); // 新加的那条仍在
    }

    @Test
    void 非法备份包_格式版本不符400_缺字段400() {
        AuthedUser user = client().register("backup7@example.com", "Passw0rd123", "备份用户");
        String token = user.accessToken();

        ApiClient.ApiResponse wrongFormat = client().post("/v1/restore", map("bundle", map(
                "format", "other.backup", "version", 1,
                "exportedAt", "2026-03-01T00:00:00.000Z", "memories", List.of())), token);
        assertEquals(400, wrongFormat.status());

        ApiClient.ApiResponse missingField =
                client().post("/v1/restore", map("bundle", map("format", "civitas.backup")), token);
        assertEquals(400, missingField.status());
        assertEquals("VALIDATION_ERROR", missingField.errorCode());
    }

    @Test
    void 恢复只影响当前账号() {
        AuthedUser user = client().register("backup8@example.com", "Passw0rd123", "备份用户");
        String token = user.accessToken();
        seed(token);
        JsonNode bundle = ApiClient.dataOf(client().get("/v1/backup", token));

        AuthedUser bob = client().register("bob-backup@example.com");
        ApiClient.ApiResponse bobRestore =
                client().post("/v1/restore", map("bundle", bundle, "mode", "merge"), bob.accessToken());
        assertEquals(200, bobRestore.status());

        assertEquals(3, ApiClient.dataOf(client().get("/v1/memories", bob.accessToken())).path("items").size());

        // A 的数据不受影响（仍是 3 条，没有翻倍）
        assertEquals(3, ApiClient.dataOf(client().get("/v1/memories", token)).path("items").size());

        Map<String, Object> owners = TestDb.getTestDb().one(
                "SELECT COUNT(DISTINCT user_id)::int AS owners FROM memories");
        assertEquals(2, Db.longOf(owners, "owners"));
    }

    @Test
    void 未鉴权无法导出或恢复() {
        assertEquals(401, client().get("/v1/backup", null).status());
        assertEquals(401, client().post("/v1/restore", map("bundle", map(
                "format", "civitas.backup", "version", 1,
                "exportedAt", "2026-03-01T00:00:00.000Z", "memories", List.of())), null).status());
    }
}
