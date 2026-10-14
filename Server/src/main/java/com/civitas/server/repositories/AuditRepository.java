package com.civitas.server.repositories;

import com.civitas.server.db.Db;
import com.civitas.server.json.Json;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 审计日志：登录成功/失败、令牌重用、改密、注销等安全事件 —— 与 TS 版 `src/repositories/audit.ts` 对位。
 * 审计写入失败**不得**影响主流程（吞掉错误并返回 false）。
 */
public final class AuditRepository {
    private AuditRepository() {}

    public record AuditInput(String userId, String action, String outcome, String ip, String userAgent, Map<String, Object> detail) {}

    public static boolean recordAudit(Db db, AuditInput input) {
        try {
            String detail = input.detail() == null ? null : Json.MAPPER.writeValueAsString(input.detail());
            db.execute(
                    "INSERT INTO audit_log (user_id, action, outcome, ip, user_agent, detail) "
                            + "VALUES ($1, $2, $3, $4, $5, $6)",
                    input.userId(), input.action(), input.outcome(), input.ip(), input.userAgent(), detail);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** 审计 detail 保存为 jsonb（读出为字符串）→ 转回 JSON 结构供响应输出 */
    public static Object detailToJson(String detail) {
        if (detail == null || detail.isEmpty()) return null;
        try {
            return Json.MAPPER.readTree(detail);
        } catch (Exception e) {
            return null;
        }
    }

    public record AuditRow(
            long id,
            String userId,
            String action,
            String outcome,
            String ip,
            String userAgent,
            String detail,
            Instant createdAt) {}

    /** 查询某用户的审计记录（个人中心"登录记录"用） */
    public static List<AuditRow> listAuditForUser(Db db, String userId, int limit) {
        return db.query(
                "SELECT id, user_id, action, outcome, ip, user_agent, detail, created_at "
                        + "FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
                userId, limit)
                .stream()
                .map(row -> {
                    Long id = Db.longOf(row, "id");
                    return new AuditRow(
                            id == null ? 0 : id,
                            Db.str(row, "user_id"),
                            Db.str(row, "action"),
                            Db.str(row, "outcome"),
                            Db.str(row, "ip"),
                            Db.str(row, "user_agent"),
                            Db.str(row, "detail"),
                            Db.instantOf(row, "created_at"));
                })
                .toList();
    }

    /** 便捷构造：明细键值对（保持插入顺序，JSON 字段顺序与 TS 版一致） */
    public static Map<String, Object> detail(Object... keyValues) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i + 1 < keyValues.length; i += 2) {
            map.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
        }
        return map;
    }
}
