package com.civitas.server.json;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

import java.time.Instant;

/**
 * 全局 JSON 工具：唯一的 ObjectMapper（Spring MVC 的消息转换也用它）。
 *
 * 与 TS 版 `JSON.stringify` 的行为对齐：
 *  - 时间为 ISO 8601（毫秒 3 位 + Z，等价 JS `Date.toISOString()`）；
 *  - 未知字段忽略（等价 Zod 的 strip 语义）；
 *  - null 字段正常输出（不做 NON_NULL 全局收敛）。
 */
public final class Json {
    public static final ObjectMapper MAPPER = create();

    private Json() {}

    private static ObjectMapper create() {
        ObjectMapper mapper = new ObjectMapper();
        mapper.registerModule(new JavaTimeModule());
        mapper.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        mapper.disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
        SimpleModule module = new SimpleModule();
        module.addSerializer(Instant.class, new IsoInstantSerializer());
        mapper.registerModule(module);
        return mapper;
    }
}
