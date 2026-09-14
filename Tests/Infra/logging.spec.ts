/**
 * S1-② Infra/Logging 模块测试
 *
 * 覆盖：traceContext / logWriter / logger
 * Gate G1 要求：日志目录不可写时主流程不阻塞
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdirSync, existsSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

import {
  runInTrace, runInSpan, runWithOperation,
  currentContext, currentTraceId, currentSpanId, currentOperationId,
} from '../../Src/Infra/Logging/traceContext.js';

import { LogWriter, createLogWriter } from '../../Src/Infra/Logging/logWriter.js';

import {
  initLogger, shutdownLogger, logger, getLogLevel, setLogLevel,
} from '../../Src/Infra/Logging/logger.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TEST_LOG_DIR = join(ROOT, 'Logs', '_test');

// 清理测试日志目录
function cleanupTestLogs(): void {
  if (existsSync(TEST_LOG_DIR)) {
    rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  }
}

describe('S1-② Logging 模块', () => {
  afterEach(() => {
    shutdownLogger();
    cleanupTestLogs();
  });

  // ===== traceContext =====
  describe('traceContext', () => {
    it('runInTrace 创建 trace 上下文并传递 trace_id', async () => {
      await runInTrace({ agentId: 'agent-001' }, async (ctx) => {
        expect(ctx.traceId).toBeTruthy();
        expect(ctx.traceId).toMatch(/^[0-9a-f-]{36}$/); // UUID v4 格式
        expect(ctx.agentId).toBe('agent-001');
        expect(ctx.createdAt).toBeGreaterThan(0);

        // 子调用可获取上下文
        const inner = currentContext();
        expect(inner?.traceId).toBe(ctx.traceId);
      });
    });

    it('runInTrace 支持指定 traceId', async () => {
      await runInTrace({ traceId: 'custom-trace-id' }, async (ctx) => {
        expect(ctx.traceId).toBe('custom-trace-id');
      });
    });

    it('runInTrace 支持 parentAgentId（T6 场景）', async () => {
      await runInTrace({ parentAgentId: 'director-001', agentId: 'worker-001' }, async (ctx) => {
        expect(ctx.parentAgentId).toBe('director-001');
        expect(ctx.agentId).toBe('worker-001');
      });
    });

    it('runInSpan 在 trace 内创建 span', async () => {
      await runInTrace({}, async (traceCtx) => {
        await runInSpan({ type: 'llm_call' }, async (spanCtx) => {
          expect(spanCtx.traceId).toBe(traceCtx.traceId); // trace_id 不变
          expect(spanCtx.spanId).toBeTruthy();
          expect(spanCtx.spanType).toBe('llm_call');
          expect(currentSpanId()).toBe(spanCtx.spanId);
        });
      });
    });

    it('runWithOperation 设置 operation_id', async () => {
      await runInTrace({}, async () => {
        await runInSpan({ type: 'tool_exec' }, async () => {
          await runWithOperation(async (opCtx) => {
            expect(opCtx.operationId).toBeTruthy();
            // operation_id 格式：{base36_ts}-{4位hex}
            expect(opCtx.operationId).toMatch(/^[a-z0-9]+-[a-f0-9]{4}$/);
            expect(currentOperationId()).toBe(opCtx.operationId);
          });
        });
      });
    });

    it('currentTraceId 无上下文时返回 no-trace', () => {
      expect(currentTraceId()).toBe('no-trace');
      expect(currentSpanId()).toBeUndefined();
      expect(currentOperationId()).toBeUndefined();
    });

    it('runInSpan 无活跃 trace 时降级执行', async () => {
      const result = await runInSpan({ type: 'custom' }, async (ctx) => {
        expect(ctx.traceId).toBe('');
        return 42;
      });
      expect(result).toBe(42);
    });
  });

  // ===== logWriter =====
  describe('logWriter', () => {
    beforeEach(() => {
      cleanupTestLogs();
    });

    it('创建日志目录并初始化成功', () => {
      const w = createLogWriter(TEST_LOG_DIR);
      expect(w.isDirWritable()).toBe(true);
      expect(existsSync(TEST_LOG_DIR)).toBe(true);
      expect(existsSync(join(TEST_LOG_DIR, '_Meta'))).toBe(true);
      w.close();
    });

    it('写入日志到 business.log', () => {
      const w = createLogWriter(TEST_LOG_DIR, { flushIntervalMs: 10000 });
      w.write({
        timestamp: new Date().toISOString(),
        epochMs: Date.now(),
        level: 'info',
        track: 'business',
        message: '测试业务日志',
      });
      w.flush();

      const logFile = join(TEST_LOG_DIR, 'business.log');
      expect(existsSync(logFile)).toBe(true);
      const content = readFileSync(logFile, 'utf-8');
      expect(content).toContain('测试业务日志');
      w.close();
    });

    it('写入日志到 system.log', () => {
      const w = createLogWriter(TEST_LOG_DIR);
      w.write({
        timestamp: new Date().toISOString(),
        epochMs: Date.now(),
        level: 'error',
        track: 'system',
        message: '测试系统日志',
      });
      w.flush();

      const logFile = join(TEST_LOG_DIR, 'system.log');
      expect(existsSync(logFile)).toBe(true);
      const content = readFileSync(logFile, 'utf-8');
      expect(content).toContain('测试系统日志');
      w.close();
    });

    it('目录不可写时静默降级（Gate G1）', () => {
      // 创建一个文件来阻止目录创建（mkdirSync 会在已存在的文件处失败）
      const blockingFile = join(TEST_LOG_DIR, 'blocker');
      mkdirSync(TEST_LOG_DIR, { recursive: true });
      writeFileSync(blockingFile, 'block');

      const w = createLogWriter(blockingFile); // 文件路径，无法作为目录
      expect(w.isDirWritable()).toBe(false);
      // 写入不抛异常
      w.write({
        timestamp: new Date().toISOString(),
        epochMs: Date.now(),
        level: 'info',
        track: 'business',
        message: '不会写入',
      });
      w.close();
    });

    it('文件轮转：超过大小限制时轮转', () => {
      // 设置极小的文件大小限制以触发轮转
      const w = createLogWriter(TEST_LOG_DIR, {
        maxFileSizeBytes: 100, // 100 bytes
        maxFiles: 3,
      });

      // 写入足够多的数据触发轮转
      for (let i = 0; i < 20; i++) {
        w.write({
          timestamp: new Date().toISOString(),
          epochMs: Date.now(),
          level: 'info',
          track: 'business',
          message: `轮转测试日志行 ${i} `.repeat(5), // 每行足够长
        });
        w.flush();
      }

      // 检查是否有轮转文件
      const files = readdirSync(TEST_LOG_DIR);
      const rotated = files.filter(f => f.startsWith('business.log.'));
      expect(rotated.length).toBeGreaterThan(0);
      w.close();
    });

    it('close 写入 _Meta/config.json', () => {
      const w = createLogWriter(TEST_LOG_DIR);
      w.close();

      const metaPath = join(TEST_LOG_DIR, '_Meta', 'config.json');
      expect(existsSync(metaPath)).toBe(true);
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      expect(meta).toHaveProperty('lastFlushAt');
      expect(meta).toHaveProperty('writeFailed');
      expect(meta.logDir).toBe(TEST_LOG_DIR);
    });
  });

  // ===== logger（门面） =====
  describe('logger', () => {
    it('initLogger 初始化成功', () => {
      const result = initLogger({ logDir: TEST_LOG_DIR, level: 'debug' });
      expect(result).toBe(true);
      expect(getLogLevel()).toBe('debug');
    });

    it('logger.info 写入 business.log', () => {
      initLogger({ logDir: TEST_LOG_DIR, level: 'info' });
      logger.info('测试信息日志', { source: 'test' });
      shutdownLogger();

      const content = readFileSync(join(TEST_LOG_DIR, 'business.log'), 'utf-8');
      expect(content).toContain('测试信息日志');
    });

    it('logger.error 写入 system.log', () => {
      initLogger({ logDir: TEST_LOG_DIR, level: 'info' });
      logger.error('测试错误日志', { source: 'test' });
      shutdownLogger();

      const content = readFileSync(join(TEST_LOG_DIR, 'system.log'), 'utf-8');
      expect(content).toContain('测试错误日志');
    });

    it('级别过滤：低于设置级别的日志被丢弃', () => {
      initLogger({ logDir: TEST_LOG_DIR, level: 'warn' });
      logger.debug('不应出现 debug');
      logger.info('不应出现 info');
      logger.warn('应该出现 warn');
      shutdownLogger();

      const businessLog = join(TEST_LOG_DIR, 'business.log');
      if (existsSync(businessLog)) {
        const content = readFileSync(businessLog, 'utf-8');
        expect(content).not.toContain('不应出现');
        expect(content).toContain('应该出现 warn');
      }
    });

    it('setLogLevel 运行时更改级别', () => {
      initLogger({ logDir: TEST_LOG_DIR, level: 'error' });
      logger.info('不应出现');
      setLogLevel('debug');
      expect(getLogLevel()).toBe('debug');
      logger.info('应该出现');
      shutdownLogger();

      const businessLog = join(TEST_LOG_DIR, 'business.log');
      if (existsSync(businessLog)) {
        const content = readFileSync(businessLog, 'utf-8');
        expect(content).not.toContain('不应出现');
        expect(content).toContain('应该出现');
      }
    });

    it('trace_id 自动注入日志', async () => {
      initLogger({ logDir: TEST_LOG_DIR, level: 'debug' });

      await runInTrace({ agentId: 'test-agent' }, async (ctx) => {
        logger.info('带 trace 的日志');
      });

      shutdownLogger();

      const content = readFileSync(join(TEST_LOG_DIR, 'business.log'), 'utf-8');
      const parsed = JSON.parse(content.trim().split('\n').pop()!);
      expect(parsed.traceId).toBeTruthy();
      expect(parsed.traceId).not.toBe('no-trace');
    });

    it('未初始化时降级到控制台（不抛异常）', () => {
      // 不调用 initLogger，直接使用 logger
      expect(() => {
        logger.info('未初始化测试');
      }).not.toThrow();
    });
  });
});
