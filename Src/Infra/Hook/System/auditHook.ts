/**
 * @module Infra/Hook/System/auditHook
 * @description
 * 系统内置 Hook——审计日志记录。
 * 在关键事件发生时自动记录审计日志。
 */

import { logger } from '../../Logging/logger.js';

/**
 * 系统审计 Hook。
 * 拦截 UserInputReceived / PreToolExecute / PostToolExecute / OnError 事件。
 */
export function systemAuditHook(event: {
  eventType: string;
  traceId?: string;
  source?: string;
  payload?: unknown;
}): void {
  logger.info('系统审计', {
    source: 'SystemHook/audit',
    eventType: event.eventType,
    traceId: event.traceId,
    hookSource: event.source,
  });
}

/**
 * 系统备份 Hook。
 * 在 SessionEnd 事件时触发数据备份。
 */
export function systemBackupHook(event: {
  eventType: string;
  sessionId?: string;
}): void {
  if (event.eventType === 'SessionEnd') {
    logger.info('会话结束，触发备份', {
      source: 'SystemHook/backup',
      sessionId: event.sessionId,
    });
  }
}

/**
 * 系统指标采集 Hook。
 * 在 PreModelCall / PostModelCall 时记录延迟和 Token 消耗。
 */
export function systemMetricsHook(event: {
  eventType: string;
  model?: string;
  tokensUsed?: number;
  latencyMs?: number;
}): void {
  if (event.eventType === 'PostModelCall') {
    logger.debug('模型调用指标', {
      source: 'SystemHook/metrics',
      model: event.model,
      tokensUsed: event.tokensUsed,
      latencyMs: event.latencyMs,
    });
  }
}
