package com.civitas.server.services;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.json.Json;
import com.civitas.server.logging.JsonLogger;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 验证码等邮件的投递通道（安全审计 SV-013）—— 与 TS 版 `src/services/mailTransport.ts` 对位。
 *
 * 设计：
 *  - 自托管场景不强制引入 SMTP 依赖：用 **webhook**（POST JSON）对接任意发信服务；
 *  - 未配置 webhook 时降级为"控制台打印"（**仅开发环境**，生产会在启动期被 config 拦下）；
 *  - 投递失败**不静默**：抛错由调用方转成 5xx。
 */
public interface MailTransport {
    String name();

    void send(MailMessage message);

    record MailMessage(String to, String subject, String text) {}

    /** webhook 投递：POST { from, to, subject, text } */
    static MailTransport webhookTransport(ServerConfig.MailConfig cfg) {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofMillis(cfg.timeoutMs()))
                .build();
        return new MailTransport() {
            @Override
            public String name() {
                return "webhook";
            }

            @Override
            public void send(MailMessage message) {
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("from", cfg.from());
                payload.put("to", message.to());
                payload.put("subject", message.subject());
                payload.put("text", message.text());
                String body;
                try {
                    body = Json.MAPPER.writeValueAsString(payload);
                } catch (Exception e) {
                    throw new IllegalStateException("邮件 webhook 载荷序列化失败", e);
                }
                HttpRequest request = HttpRequest.newBuilder(URI.create(cfg.webhookUrl()))
                        .timeout(Duration.ofMillis(cfg.timeoutMs()))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build();
                try {
                    HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
                    if (response.statusCode() < 200 || response.statusCode() >= 300) {
                        throw new IllegalStateException("邮件 webhook 返回 HTTP " + response.statusCode());
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("邮件 webhook 投递被中断", e);
                } catch (java.io.IOException e) {
                    throw new IllegalStateException("邮件 webhook 投递失败", e);
                }
            }
        };
    }

    /** 控制台投递：仅用于开发/自测（生产会在启动期被拒） */
    static MailTransport consoleTransport() {
        return new MailTransport() {
            @Override
            public String name() {
                return "console";
            }

            @Override
            public void send(MailMessage message) {
                Map<String, Object> fields = new LinkedHashMap<>();
                fields.put("source", "mailTransport");
                fields.put("to", message.to());
                fields.put("subject", message.subject());
                fields.put("text", message.text());
                JsonLogger.info("验证码邮件（控制台通道，仅开发）", fields);
            }
        };
    }

    /**
     * 选择投递通道。
     *
     * @return 已配置 webhook → webhook 通道；否则 → 控制台通道（调用方需保证仅在开发环境走到这里）
     */
    static MailTransport create(ServerConfig.MailConfig cfg) {
        return cfg.webhookUrl() != null && !cfg.webhookUrl().isEmpty()
                ? webhookTransport(cfg)
                : consoleTransport();
    }

    static boolean isMailConfigured(ServerConfig.MailConfig cfg) {
        return cfg.webhookUrl() != null && !cfg.webhookUrl().isEmpty();
    }
}
