package com.civitas.server.http.validation;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * 设置相关请求体校验 —— 与 TS 版 `src/http/schemas.ts` 的 settingsPutSchema / settingsPatchSchema 对位。
 */
public final class SettingsBodies {
    private SettingsBodies() {}

    public record PutBody(ObjectNode data, Long expectedRevision) {}

    public record PatchBody(ObjectNode patch, Long expectedRevision) {}

    public static PutBody put(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        JsonNode data = v.field("data").record().object();
        Long expectedRevision = revision(v);
        v.finish();
        return new PutBody((ObjectNode) data, expectedRevision);
    }

    public static PatchBody patch(JsonNode body) {
        Validator.Obj v = Validator.object(body, "body");
        JsonNode patch = v.field("patch").record().object();
        Long expectedRevision = revision(v);
        v.finish();
        return new PatchBody((ObjectNode) patch, expectedRevision);
    }

    /** expectedRevision: z.number().int().min(0).optional() */
    private static Long revision(Validator.Obj v) {
        Double value = v.field("expectedRevision").optional().num().integer().minNumber(0, null).number();
        return value == null ? null : (long) Math.floor(value);
    }
}
