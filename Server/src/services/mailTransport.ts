/**
 * @module services/mailTransport
 * @description 验证码等邮件的投递通道（安全审计 SV-013）。
 *
 * 设计：
 *  - 自托管场景不强制引入 SMTP 依赖：用 **webhook**（POST JSON）对接任意发信服务
 *    （自建 SMTP 网关、SendGrid/Mailgun/Resend 等），保持零额外依赖；
 *  - 未配置 webhook 时返回 `null` —— 由调用方降级为"控制台打印"（**仅开发环境**），
 *    生产环境会在启动期被 config 的 fail-closed 校验拦下；
 *  - 投递失败**不静默**：抛错由调用方转成 5xx（避免"验证码发不出去但用户以为已发送"）。
 */

import type { MailConfig } from '../config.js';
import { logger } from '../logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}

/** webhook 投递：POST { from, to, subject, text } */
export function createWebhookTransport(cfg: MailConfig): MailTransport {
  return {
    name: 'webhook',
    async send(message) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const res = await fetch(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: cfg.from,
            to: message.to,
            subject: message.subject,
            text: message.text,
          }),
          signal: controller.signal,
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`邮件 webhook 返回 HTTP ${res.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 控制台投递：仅用于开发/自测（生产会在启动期被拒） */
export function createConsoleTransport(): MailTransport {
  return {
    name: 'console',
    async send(message) {
      logger.info('验证码邮件（控制台通道，仅开发）', {
        source: 'mailTransport',
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

/**
 * 选择投递通道。
 *
 * @returns 已配置 webhook → webhook 通道；否则 → 控制台通道（调用方需保证仅在开发环境走到这里）
 */
export function createMailTransport(cfg: MailConfig): MailTransport {
  return cfg.webhookUrl ? createWebhookTransport(cfg) : createConsoleTransport();
}

export function isMailConfigured(cfg: MailConfig): boolean {
  return cfg.webhookUrl.length > 0;
}
