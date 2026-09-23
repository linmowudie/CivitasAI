/**
 * 日志门面（Docs/02 §7.1 ② / Docs/09 §6.1）
 *
 * 职责：
 * - 提供分级日志接口：debug / info / warn / error / fatal
 * - 自动注入 trace_id / span_id / operation_id（从 traceContext 获取）
 * - 双轨路由：业务日志 → business.log，系统日志 → system.log
 * - 级别过滤：低于配置级别的日志直接丢弃
 * - fatal 级别同时输出到 console.error（确保可见）
 *
 * 使用方式：
 * ```ts
 * import { logger } from '@Infra/Logging/logger.js';
 *
 * // 初始化（启动 ② 步）
 * initLogger({ logDir: 'Logs/', level: 'info' });
 *
 * // 记录日志
 * logger.info('系统启动完成', { module: 'main' });
 * logger.error('数据库连接失败', { module: 'db', error: 'ECONNREFUSED' });
 * ```
 *
 * 轨道路由规则：
 * - system 轨道：配置加载、安全、数据库、系统级事件
 * - business 轨道：Agent 运行、工具调用、LLM 交互、业务逻辑
 */

import { resolve } from 'node:path';

import type { LogLevel } from '../types.js';

import { LogWriter, createLogWriter } from './logWriter.js';
import type { LogTrack, LogWriterConfig } from './logWriter.js';
import { currentContext, currentTraceId, currentSpanId, currentOperationId } from './traceContext.js';

// ===== 类型定义 =====

/** 日志初始化配置 */
export interface LoggerConfig {
  /** 日志目录（相对路径或绝对路径） */
  logDir: string;
  /** 最低日志级别（默认 'info'） */
  level?: LogLevel;
  /** 日志写入器配置覆盖 */
  writerOverrides?: Partial<LogWriterConfig>;
}

/** 日志附加数据 */
export interface LogData {
  /** 指定轨道（不指定则自动路由） */
  track?: LogTrack;
  /** 来源模块/文件 */
  source?: string;
  /** 其他附加字段 */
  [key: string]: unknown;
}

// ===== 级别权重 =====

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

// ===== 模块状态 =====

let writer: LogWriter | null = null;
let currentLevel: LogLevel = 'info';
let initialized = false;

// ===== 公开 API =====

/**
 * 初始化日志系统（启动 14 步 ②）
 *
 * 创建日志目录、初始化写入器、设置日志级别。
 * 目录不可写时静默降级（Gate G1）。
 *
 * @returns 初始化是否成功（目录可写）
 */
export function initLogger(config: LoggerConfig): boolean {
  if (initialized) return writer?.isDirWritable() ?? false;

  // 解析日志目录为绝对路径
  const logDir = resolve(config.logDir);
  currentLevel = config.level ?? 'info';

  writer = createLogWriter(logDir, config.writerOverrides);
  initialized = true;

  return writer.isDirWritable();
}

/**
 * 关闭日志系统（关闭 9 步 ⑥）
 *
 * 刷新缓冲区，写入元数据，释放资源。
 */
export function shutdownLogger(): void {
  if (writer) {
    writer.close();
    writer = null;
  }
  initialized = false;
}

/**
 * 获取当前日志级别
 */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * 运行时更改日志级别（L2 热重载）
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * 获取日志写入器（用于高级操作）
 */
export function getWriter(): LogWriter | null {
  return writer;
}

/**
 * 日志门面对象
 *
 * 提供 debug / info / warn / error / fatal 五个方法。
 * 每个方法接受 (message, data?) 参数。
 */
export const logger = {
  /** DEBUG 级别日志（详细调试信息） */
  debug(message: string, data?: LogData): void {
    log('debug', message, data);
  },

  /** INFO 级别日志（一般运行信息） */
  info(message: string, data?: LogData): void {
    log('info', message, data);
  },

  /** WARN 级别日志（警告信息） */
  warn(message: string, data?: LogData): void {
    log('warn', message, data);
  },

  /** ERROR 级别日志（错误信息） */
  error(message: string, data?: LogData): void {
    log('error', message, data);
  },

  /** FATAL 级别日志（致命错误，同时输出到 console.error） */
  fatal(message: string, data?: LogData): void {
    log('fatal', message, data);
    // fatal 级别始终输出到控制台，确保可见
    console.error(`[FATAL] ${message}`, data ? JSON.stringify(data) : '');
  },
};

// ===== 内部函数 =====

/**
 * 核心日志函数
 */
function log(level: LogLevel, message: string, data?: LogData): void {
  // 级别过滤
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) return;

  // 获取 trace 上下文
  const traceCtx = currentContext();
  const traceId = traceCtx?.traceId ?? currentTraceId();
  const spanId = traceCtx?.spanId ?? currentSpanId();
  const operationId = traceCtx?.operationId ?? currentOperationId();

  // 确定轨道：显式指定 > 自动路由
  const track: LogTrack = data?.track ?? routeTrack(level, data);

  // 构建日志行
  const line = {
    timestamp: new Date().toISOString(),
    epochMs: Date.now(),
    level,
    track,
    message,
    traceId: traceId !== 'no-trace' ? traceId : undefined,
    spanId,
    operationId,
    source: data?.source,
    data: extractData(data),
  };

  // 写入（未初始化时降级为 console 输出）
  if (writer) {
    writer.write(line);
  } else {
    // 未初始化 → 降级到控制台
    const prefix = traceId !== 'no-trace' ? `[${traceId}]` : '';
    const output = `[${level.toUpperCase()}] ${prefix} ${message}`;
    if (level === 'error' || level === 'fatal') {
      console.error(output);
    } else {
      console.log(output);
    }
  }
}

/**
 * 自动路由轨道
 *
 * error/fatal → system 轨道（系统级事件）
 * 其他 → business 轨道（默认）
 */
function routeTrack(level: LogLevel, _data?: LogData): LogTrack {
  // error 和 fatal 默认走系统轨道
  if (level === 'error' || level === 'fatal') {
    return 'system';
  }
  return 'business';
}

/**
 * 提取附加数据（排除内部控制字段）
 */
function extractData(data?: LogData): Record<string, unknown> | undefined {
  if (!data) return undefined;

  const EXCLUDE = new Set(['track', 'source']);
  const rest = Object.fromEntries(Object.entries(data).filter(([k]) => !EXCLUDE.has(k)));
  return Object.keys(rest).length > 0 ? rest : undefined;
}
