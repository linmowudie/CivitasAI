package com.civitas.server.http;

/** 请求体超过限制（由 BodyLimitFilter 在流读取时抛出；等价 Fastify 的 413 中止） */
public class BodyTooLargeException extends RuntimeException {
    public BodyTooLargeException() {
        super("请求体过大");
    }
}
