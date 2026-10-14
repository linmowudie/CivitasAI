package com.civitas.server.http.validation;

import com.civitas.server.repositories.TasksRepository.TaskInput;
import com.civitas.server.util.JsNumber;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;

/**
 * 任务（会话）元数据相关请求体的校验 —— 与 TS 版 `src/http/schemas.ts` 的 task 段对位。
 *
 * 注：`taskListQuerySchema` 的 `archived`/`limit` 走的是 transform + refine（自定义文案），
 * 这里按同样的语义手工实现（查询串强制转型等）。
 */
public final class TaskBodies {
    private TaskBodies() {}

    /** archived 为 null = 全部（对位 TS 的 'all'） */
    public record ListQuery(Boolean archived, Integer limit) {}

    public record BulkBody(List<TaskInput> items) {}

    // ── 列表查询（GET /v1/tasks）────────────────────────────────────────

    public static ListQuery listQuery(JsonNode query) {
        Validator.Obj v = Validator.object(query, "query");

        // archived：true/'true'/'1' → TRUE；false/'false'/'0' → FALSE；其余（含缺省）→ 全部
        Boolean archived = null;
        JsonNode archivedRaw = rawOf(query, "archived");
        if (archivedRaw != null) {
            if (archivedRaw.isBoolean()) {
                archived = archivedRaw.booleanValue();
            } else if (archivedRaw.isTextual()) {
                String value = archivedRaw.textValue();
                if (value.equals("true") || value.equals("1")) archived = Boolean.TRUE;
                else if (value.equals("false") || value.equals("0")) archived = Boolean.FALSE;
            } else {
                v.addIssue("archived", "Invalid input", "invalid_union");
            }
        }

        // limit：缺省/空串 → 500；否则 Number(v)，必须是 1..2000 的整数（自定义文案）
        double limit = 500;
        boolean limitInvalid = false;
        JsonNode limitRaw = rawOf(query, "limit");
        if (limitRaw == null || (limitRaw.isTextual() && limitRaw.textValue().isEmpty())) {
            limitInvalid = false;
        } else if (limitRaw.isNumber()) {
            limit = limitRaw.doubleValue();
            limitInvalid = !(limit % 1 == 0 && limit > 0 && limit <= 2000);
        } else if (limitRaw.isTextual()) {
            limit = JsNumber.parse(limitRaw.textValue());
            limitInvalid = !(Double.isFinite(limit) && limit % 1 == 0 && limit > 0 && limit <= 2000);
        } else {
            limitInvalid = true;
        }
        if (limitInvalid) v.addIssue("limit", "limit 必须是 1..2000 的整数", "custom");

        v.finish();
        return new ListQuery(archived, (int) Math.floor(limit));
    }

    private static JsonNode rawOf(JsonNode query, String name) {
        if (query == null || !query.isObject()) return null;
        JsonNode value = query.get(name);
        return value == null || value.isMissingNode() ? null : value;
    }

    // ── 批量上行（POST /v1/tasks/bulk）──────────────────────────────────

    public static BulkBody bulk(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        Validator.Field items = v.field("items").array()
                .minItems(1, "items 不能为空")
                .maxItems(500, "单批最多 500 条");
        List<TaskInput> inputs = new ArrayList<>();
        if (items.arrayNode() != null) {
            List<JsonNode> elements = new ArrayList<>();
            items.arrayNode().forEach(elements::add);
            for (int i = 0; i < elements.size(); i++) {
                Validator.Obj item = v.child(elements.get(i), "items." + i);
                inputs.add(taskFields(item));
            }
        }
        v.finish();
        return new BulkBody(inputs);
    }

    /** taskUpsertSchema 的字段（title/archivedAt 可缺省，时间戳必填） */
    private static TaskInput taskFields(Validator.Obj v) {
        String clientSessionId = v.field("clientSessionId").str().trim()
                .minLen(1, null).maxLen(128, null).text();
        String title = v.field("title").optional().str().trim().maxLen(200, null).text();
        Double createdAt = v.field("createdAt").num().integer().minNumber(0, null).number();
        Double updatedAt = v.field("updatedAt").num().integer().minNumber(0, null).number();
        Long archivedAt = null;
        if (v.field("archivedAt").raw() != null) {
            Double value = v.field("archivedAt").nullable().num().integer().minNumber(0, null).number();
            archivedAt = value == null ? null : value.longValue();
        }
        return new TaskInput(
                clientSessionId,
                title,
                createdAt == null ? 0 : createdAt.longValue(),
                updatedAt == null ? 0 : updatedAt.longValue(),
                archivedAt);
    }
}
