package com.civitas.server.http.validation;

import com.civitas.server.repositories.StatsRepository.UsageEventInput;
import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * 统计相关请求体/查询串校验 —— 与 TS 版 `src/http/schemas.ts` 的 stats 段对位。
 */
public final class StatsBodies {
    private StatsBodies() {}

    public record IngestBody(List<StatsEvent> events) {}

    /** 单条事件（已过校验与默认值填充） */
    public record StatsEvent(
            String kind,
            double value,
            Instant occurredAt,
            String clientEventId,
            JsonNode meta) {}

    public record RangeQuery(Instant from, Instant to, String kind) {}

    public static IngestBody ingest(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        Validator.Field items = v.field("events").array().minItems(1, "events 不能为空").maxItems(5000, null);
        List<StatsEvent> events = new ArrayList<>();
        if (items.arrayNode() != null) {
            List<JsonNode> elements = new ArrayList<>();
            items.arrayNode().forEach(elements::add);
            for (int i = 0; i < elements.size(); i++) {
                Validator.Obj item = v.child(elements.get(i), "events." + i);
                String kind = item.field("kind").str().trim().minLen(1, null).maxLen(64, null).text();
                Double value = item.field("value").defaultTo(0).num().finite().number();
                Instant occurredAt = item.field("occurredAt")
                        .str().isoDateTime("需为 ISO 8601 时间（含时区）").instant();
                String clientEventId = item.field("clientEventId").nullish().str().trim().maxLen(128, null).text();
                JsonNode meta = item.field("meta").nullish().record().object();
                // 校验失败时 finish() 会抛 400，这里的兜底值不会被使用
                events.add(new StatsEvent(kind, value == null ? 0 : value, occurredAt, clientEventId, meta));
            }
        }
        v.finish();
        return new IngestBody(events);
    }

    /** 区间查询（from/to 为可选 ISO 时间；kind 可选） */
    public static RangeQuery rangeQuery(JsonNode query) {
        Validator.Obj v = Validator.object(query, "query");
        Instant from = v.field("from").optional().str().isoDateTime("需为 ISO 8601 时间（含时区）").instant();
        Instant to = v.field("to").optional().str().isoDateTime("需为 ISO 8601 时间（含时区）").instant();
        String kind = v.field("kind").optional().str().trim().maxLen(64, null).text();
        v.finish();
        return new RangeQuery(from, to, kind);
    }

    /** 转换为仓储层输入（对位路由里的 `body.events.map(...)`） */
    public static List<UsageEventInput> toInputs(List<StatsEvent> events) {
        return events.stream()
                .map(e -> new UsageEventInput(
                        e.kind(),
                        e.value(),
                        e.occurredAt(),
                        e.meta(),
                        e.clientEventId()))
                .toList();
    }
}
