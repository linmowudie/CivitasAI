/**
 * 双轨日志写入器（Docs/02 §2 / Docs/02 §7.1 ②）
 *
 * 职责：
 * - 双轨分离：business.log（业务日志）+ system.log（系统日志）
 * - 文件轮转：按大小轮转，保留最近 N 个文件
 * - 写失败静默丢弃：日志写入失败不阻断主流程（Gate G1 要求）
 * - 格式化：JSON Lines 格式，每行一条日志记录
 * - 缓冲写入：定时刷新，减少 IO 次数
 *
 * 目录结构：
 *   Logs/
 *   ├── business.log          # 当前业务日志
 *   ├── business.log.1        # 轮转后的历史
 *   ├── system.log            # 当前系统日志
 *   ├── system.log.1
 *   └── _Meta/
 *       └── config.json       # 日志元数据（当前轮转索引等）
 */

import { appendFileSync, mkdirSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LogLevel } from '../types.js';

// ===== 类型定义 =====

/** 日志轨道类型 */
export type LogTrack = 'business' | 'system';

/** 日志写入器配置 */
export interface LogWriterConfig {
  /** 日志目录（如 'Logs/'） */
  logDir: string;
  /** 单文件最大字节数（默认 10MB） */
  maxFileSizeBytes?: number;
  /** 保留的历史文件数（默认 5） */
  maxFiles?: number;
  /** 缓冲刷新间隔 ms（默认 1000） */
  flushIntervalMs?: number;
  /** 缓冲最大条数（默认 100，达到即强制刷新） */
  maxBufferedLines?: number;
}

/** 日志行结构（JSON Lines 格式） */
export interface LogLine {
  /** ISO-8601 时间戳 */
  readonly timestamp: string;
  /** epoch 毫秒 */
  readonly epochMs: number;
  /** 日志级别 */
  readonly level: LogLevel;
  /** 日志轨道 */
  readonly track: LogTrack;
  /** 日志消息 */
  readonly message: string;
  /** 附加数据 */
  readonly data?: Record<string, unknown>;
  /** trace_id（Docs/09 §6.1） */
  readonly traceId?: string;
  /** span_id */
  readonly spanId?: string;
  /** operation_id */
  readonly operationId?: string;
  /** 源文件/模块名 */
  readonly source?: string;
}

// ===== 常量 =====

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES = 5;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_BUFFERED_LINES = 100;
const META_DIR = '_Meta';

// ===== LogWriter 类 =====

export class LogWriter {
  private readonly logDir: string;
  private readonly maxFileSizeBytes: number;
  private readonly maxFiles: number;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedLines: number;

  /** 双轨缓冲区 */
  private businessBuffer: string[] = [];
  private systemBuffer: string[] = [];

  /** 定时刷新器 */
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /** 写入失败标记（静默丢弃，但记录状态） */
  private writeFailed = false;

  /** 是否已初始化 */
  private initialized = false;

  /** 日志目录是否可写 */
  private dirWritable = false;

  constructor(config: LogWriterConfig) {
    this.logDir = config.logDir;
    this.maxFileSizeBytes = config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
    this.maxFiles = config.maxFiles ?? DEFAULT_MAX_FILES;
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBufferedLines = config.maxBufferedLines ?? DEFAULT_MAX_BUFFERED_LINES;
  }

  /**
   * 初始化日志写入器
   *
   * - 创建日志目录和 _Meta 子目录
   * - 验证目录可写
   * - 启动定时刷新
   *
   * 目录不可写时静降级（Gate G1：日志目录不可写时主流程不阻塞）。
   */
  init(): void {
    if (this.initialized) return;

    try {
      // 确保日志目录存在
      if (!existsSync(this.logDir)) {
        mkdirSync(this.logDir, { recursive: true });
      }
      // 确保 _Meta 目录存在
      const metaDir = join(this.logDir, META_DIR);
      if (!existsSync(metaDir)) {
        mkdirSync(metaDir, { recursive: true });
      }

      // 验证可写：尝试写入测试文件
      const testFile = join(this.logDir, '.write_test');
      writeFileSync(testFile, 'test');
      // 清理测试文件（失败也不影响）
      try { renameSync(testFile, testFile + '.tmp'); } catch { /* ignore */ }

      this.dirWritable = true;
    } catch {
      // 目录不可写 → 静默降级
      this.dirWritable = false;
      this.writeFailed = true;
    }

    // 启动定时刷新
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);
    // 允许 Node.js 在只有 flush timer 时正常退出
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }

    this.initialized = true;
  }

  /**
   * 写入一条日志
   *
   * 日志行先入缓冲区，达到阈值或定时刷新时写入文件。
   * 写入失败静默丢弃（不抛异常、不阻断主流程）。
   */
  write(line: LogLine): void {
    if (!this.dirWritable) return; // 目录不可写，静默丢弃

    const serialized = JSON.stringify(line);
    const track = line.track;

    if (track === 'business') {
      this.businessBuffer.push(serialized);
    } else {
      this.systemBuffer.push(serialized);
    }

    // 缓冲满 → 立即刷新
    if (this.businessBuffer.length + this.systemBuffer.length >= this.maxBufferedLines) {
      this.flush();
    }
  }

  /**
   * 刷新缓冲区到文件
   *
   * 写入失败时静默丢弃（Gate G1），但标记 writeFailed。
   */
  flush(): void {
    if (!this.dirWritable) return;

    // 刷新业务日志
    if (this.businessBuffer.length > 0) {
      const lines = this.businessBuffer;
      this.businessBuffer = [];
      this.appendToFile('business.log', lines.join('\n') + '\n');
    }

    // 刷新系统日志
    if (this.systemBuffer.length > 0) {
      const lines = this.systemBuffer;
      this.systemBuffer = [];
      this.appendToFile('system.log', lines.join('\n') + '\n');
    }
  }

  /**
   * 关闭写入器
   *
   * 停止定时器，刷新剩余缓冲，写 _Meta/config.json。
   */
  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // 最终刷新
    this.flush();

    // 写元数据
    this.writeMeta();

    this.initialized = false;
  }

  /** 获取目录可写状态 */
  isDirWritable(): boolean {
    return this.dirWritable;
  }

  /** 获取写入失败状态 */
  hasWriteFailed(): boolean {
    return this.writeFailed;
  }

  /** 获取日志目录路径 */
  getLogDir(): string {
    return this.logDir;
  }

  // ===== 内部方法 =====

  /**
   * 追加内容到日志文件，必要时触发轮转
   */
  private appendToFile(filename: string, content: string): void {
    const filePath = join(this.logDir, filename);

    try {
      // 检查是否需要轮转
      if (existsSync(filePath)) {
        const stat = statSync(filePath);
        if (stat.size >= this.maxFileSizeBytes) {
          this.rotateFile(filename);
        }
      }

      appendFileSync(filePath, content, 'utf-8');
    } catch {
      // 写入失败 → 静默丢弃（Gate G1）
      this.writeFailed = true;
    }
  }

  /**
   * 轮转日志文件
   *
   * 策略：filename.N → filename.N+1（N 从 maxFiles-1 到 1），
   *       filename → filename.1
   * 超出 maxFiles 的最旧文件被覆盖。
   */
  private rotateFile(filename: string): void {
    const basePath = join(this.logDir, filename);

    try {
      // 从最大编号开始，依次向后移动
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const src = `${basePath}.${i}`;
        const dst = `${basePath}.${i + 1}`;
        if (existsSync(src)) {
          renameSync(src, dst);
        }
      }

      // 当前文件 → .1
      renameSync(basePath, `${basePath}.1`);
    } catch {
      // 轮转失败 → 静默丢弃（不阻断主流程）
      this.writeFailed = true;
    }
  }

  /**
   * 写入日志元数据（_Meta/config.json）
   */
  private writeMeta(): void {
    if (!this.dirWritable) return;

    const meta = {
      lastFlushAt: new Date().toISOString(),
      writeFailed: this.writeFailed,
      logDir: this.logDir,
    };

    try {
      const metaPath = join(this.logDir, META_DIR, 'config.json');
      writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {
      // 元数据写入失败 → 静默丢弃
    }
  }
}

// ===== 便捷工厂 =====

/**
 * 创建并初始化日志写入器
 *
 * @param logDir 日志目录路径
 * @param overrides 可选配置覆盖
 */
export function createLogWriter(logDir: string, overrides?: Partial<LogWriterConfig>): LogWriter {
  const writer = new LogWriter({ logDir, ...overrides });
  writer.init();
  return writer;
}
