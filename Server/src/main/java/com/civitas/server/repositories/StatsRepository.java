package com.civitas.server.repositories;

import com.civitas.server.db.Db;
import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 个人数据统计：事件写入 + 按种类/按日聚合 —— 与 TS 版 `src/repositories/stats.ts` 对位。
 *
 * 设计：直接对 usage_events 聚合（索引 (user_id, occurred_at)），
 * 数据量增大后可加物化日汇总表，接口不变。
 */
public final class StatsRepository {
    private StatsRepository() {}

    public record UsageEventInput(
            String kind,
            double value,
            Instant occurredAt,
            JsonNode meta,
            String clientEventId) {}

    public record KindTotal(String kind, int count, double value) {}

    public record DailyTotal(String day, String kind, int count, double value) {}

    public record RangeTotals(int events, double value, int activeDays) {}

    public record LifetimeTotals(int events, double value, int activeDays, Instant firstAt, Instant lastAt) {}

    /** 批量写入事件（client_event_id 重复即忽略，保证上报幂等） */
    public static int insertEvents(Db db, String userId, List<UsageEventInput> events) {
        if (events.isEmpty()) return 0;
        // 单条 INSERT ... VALUES (...),(...) 批量写入；冲突（同 client_event_id）直接跳过
        List<Object> values = new ArrayList<>();
        values.add(userId);
        StringBuilder tuples = new StringBuilder();
        for (UsageEventInput ev : events) {
            int base = values.size();
            if (!tuples.isEmpty()) tuples.append(", ");
            tuples.append("($1, $").append(base + 1).append(", $").append(base + 2)
                    .append(", $").append(base + 3).append(", $").append(base + 4)
                    .append(", $").append(base + 5).append(')');
            values.add(ev.kind());
            values.add(ev.value());
            values.add(ev.occurredAt());
            values.add(ev.meta());
            values.add(ev.clientEventId());
        }
        return db.execute(
                "INSERT INTO usage_events (user_id, kind, value, occurred_at, meta, client_event_id) "
                        + "VALUES " + tuples
                        + " ON CONFLICT (user_id, client_event_id) WHERE client_event_id IS NOT NULL DO NOTHING",
                values.toArray());
    }

    /** 按种类汇总 */
    public static List<KindTotal> summaryByKind(Db db, String userId, Instant from, Instant to) {
        return db.query(
                "SELECT kind, COUNT(*)::int AS count, COALESCE(SUM(value), 0)::float8 AS value "
                        + "FROM usage_events "
                        + "WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3 "
                        + "GROUP BY kind ORDER BY count DESC, kind ASC",
                userId, from, to)
                .stream()
                .map(row -> new KindTotal(
                        Db.str(row, "kind"),
                        intOf(row, "count"),
                        doubleOf(row, "value")))
                .toList();
    }

    /** 按日（指定时区）汇总；kind 为空则返回全部种类 */
    public static List<DailyTotal> dailyTotals(
            Db db, String userId, Instant from, Instant to, String timezone, String kind) {
        return db.query(
                "SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE $4), 'YYYY-MM-DD') AS day, "
                        + "kind, COUNT(*)::int AS count, COALESCE(SUM(value), 0)::float8 AS value "
                        + "FROM usage_events "
                        + "WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3 "
                        + "  AND ($5::text IS NULL OR kind = $5) "
                        + "GROUP BY 1, 2 ORDER BY 1 ASC, 2 ASC",
                userId, from, to, timezone, kind)
                .stream()
                .map(row -> new DailyTotal(
                        Db.str(row, "day"),
                        Db.str(row, "kind"),
                        intOf(row, "count"),
                        doubleOf(row, "value")))
                .toList();
    }

    /** 区间总计（活跃天数、事件数、数值合计） */
    public static RangeTotals rangeTotals(Db db, String userId, Instant from, Instant to, String timezone) {
        Map<String, Object> row = db.one(
                "SELECT COUNT(*)::int AS events, "
                        + "COALESCE(SUM(value), 0)::float8 AS value, "
                        + "COUNT(DISTINCT date_trunc('day', occurred_at AT TIME ZONE $4))::int AS active_days "
                        + "FROM usage_events "
                        + "WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3",
                userId, from, to, timezone);
        if (row == null) return new RangeTotals(0, 0, 0);
        return new RangeTotals(intOf(row, "events"), doubleOf(row, "value"), intOf(row, "active_days"));
    }

    /** 全部历史总计（不含时间过滤），用于个人中心概览 */
    public static LifetimeTotals lifetimeTotals(Db db, String userId, String timezone) {
        Map<String, Object> row = db.one(
                "SELECT COUNT(*)::int AS events, "
                        + "COALESCE(SUM(value), 0)::float8 AS value, "
                        + "COUNT(DISTINCT date_trunc('day', occurred_at AT TIME ZONE $2))::int AS active_days, "
                        + "MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at "
                        + "FROM usage_events WHERE user_id = $1",
                userId, timezone);
        if (row == null) return new LifetimeTotals(0, 0, 0, null, null);
        return new LifetimeTotals(
                intOf(row, "events"),
                doubleOf(row, "value"),
                intOf(row, "active_days"),
                Db.instantOf(row, "first_at"),
                Db.instantOf(row, "last_at"));
    }

    public static int deleteAllEvents(Db db, String userId) {
        return db.execute("DELETE FROM usage_events WHERE user_id = $1", userId);
    }

    private static int intOf(Map<String, Object> row, String column) {
        Long value = Db.longOf(row, column);
        return value == null ? 0 : value.intValue();
    }

    private static double doubleOf(Map<String, Object> row, String column) {
        Object value = row.get(column);
        if (value instanceof Number number) return number.doubleValue();
        return value == null ? 0 : Double.parseDouble(String.valueOf(value));
    }
}
