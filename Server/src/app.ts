/**
 * @module app
 * @description 组装 Fastify 应用：插件、限流钩子、鉴权、路由、统一错误处理。
 * 依赖以 `AppContext` 显式注入（便于测试直接构建应用，无需真实监听端口）。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { ServerConfig } from './config.js';
import { setLogLevel, type LogLevel } from './logger.js';
import type { Db } from './db/pool.js';
import { AppError, unavailable } from './http/errors.js';
import { fail, ok } from './http/respond.js';
import { createPostgresRateLimiter, createRateLimiter, type RateLimiter } from './http/rateLimit.js';
import { createAuthService, type AuthService } from './services/authService.js';
import { createSettingsService, type SettingsService } from './services/settingsService.js';
import { createStatsService, type StatsService } from './services/statsService.js';
import { createMemoryService, type MemoryService } from './services/memoryService.js';
import { createTaskService, type TaskService } from './services/taskService.js';
import { createBackupService, type BackupService } from './services/backupService.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMeRoutes } from './routes/me.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerMemoryRoutes } from './routes/memories.js';
import { registerBackupRoutes } from './routes/backup.js';
import { registerTaskRoutes } from './routes/tasks.js';

export interface AppServices {
  auth: AuthService;
  settings: SettingsService;
  stats: StatsService;
  memories: MemoryService;
  /** 任务（会话）元数据：标题 + 归档状态 */
  tasks: TaskService;
  backup: BackupService;
}

export interface AppContext {
  cfg: ServerConfig;
  db: Db;
  services: AppServices;
  rateLimiter: RateLimiter;
}

export interface BuildAppOptions {
  cfg: ServerConfig;
  db: Db;
  /** 关闭 fastify 自带日志（测试用） */
  disableLogger?: boolean;
  /** 复用外部限流器（测试可注入更宽松的限制） */
  rateLimiter?: RateLimiter;
}

/** 不需要限流与鉴权的探测端点 */
const PUBLIC_EXACT = new Set(['/healthz', '/readyz']);

/** 是否需要"写"限流（按用户） */
function isWriteMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

export function buildApp(options: BuildAppOptions): { app: FastifyInstance; ctx: AppContext } {
  const { cfg, db } = options;

  // 让服务层自带的 logger 与 Fastify 保持同一日志级别（测试下 cfg.logLevel='silent' → 静默）
  setLogLevel(options.disableLogger ? 'silent' : (cfg.logLevel as LogLevel));

  const app = Fastify({
    bodyLimit: cfg.limits.bodyLimitBytes,
    trustProxy: cfg.trustProxy,
    logger: options.disableLogger
      ? false
      : {
          level: cfg.logLevel,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              'req.body.currentPassword',
              'req.body.newPassword',
              'req.body.refreshToken',
            ],
            censor: '[REDACTED]',
          },
        },
  });

  // 限流器：多实例部署时用 PG 共享计数（SV-003），否则进程内（零额外往返）
  const rateLimiter =
    options.rateLimiter
    ?? (cfg.rateLimitStore === 'postgres'
      ? createPostgresRateLimiter({ db })
      : createRateLimiter());
  const services: AppServices = {
    auth: createAuthService({ db, cfg }),
    settings: createSettingsService({ db, cfg }),
    stats: createStatsService({ db, cfg }),
    memories: createMemoryService({ db, cfg }),
    tasks: createTaskService({ db }),
    backup: createBackupService({ db, cfg }),
  };
  const ctx: AppContext = { cfg, db, services, rateLimiter };

  // ── 安全响应头（无需额外依赖的最小集合）──
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // ── 限流（onRequest：按 IP 的粗粒度；auth 端点用更严的桶）──
  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_EXACT.has(request.url.split('?')[0] ?? '')) return;

    const path = request.url.split('?')[0] ?? '';
    const isAuth = path.startsWith('/v1/auth/');
    const limit = isAuth ? cfg.limits.authPerMin : cfg.limits.apiPerMin;
    const key = `${isAuth ? 'auth' : 'api'}:${request.ip}`;
    const decision = await rateLimiter.consume(key, limit);
    reply.header('X-RateLimit-Limit', String(decision.limit));
    reply.header('X-RateLimit-Remaining', String(Math.max(0, decision.limit - decision.used)));
    if (!decision.allowed) {
      throw new AppError('RATE_LIMITED', '请求过于频繁，请稍后再试', {
        retryAfterSec: decision.retryAfterSec,
      });
    }
  });

  // 允许浏览器客户端（可选）；Electron 直连时该插件无副作用
  if (cfg.corsOrigins.length > 0) {
    void app.register(cors, {
      origin: cfg.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    });
  }

  // ── 健康检查 ──
  app.get('/healthz', async (_request, reply) => ok(reply, { status: 'ok', uptimeSec: Math.round(process.uptime()) }));
  app.get('/readyz', async (_request, reply) => {
    const alive = await db.ping();
    if (!alive) {
      // SV-008：失败响应走 AppError + fail 统一错误链（503 由 UNAVAILABLE 错误码承载）
      return fail(reply, unavailable('数据库不可用'));
    }
    return ok(reply, { status: 'ready', db: 'up' });
  });

  // ── 业务路由 ──
  registerAuthRoutes(app, ctx);
  registerMeRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerStatsRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerBackupRoutes(app, ctx);
  registerTaskRoutes(app, ctx);

  // ── 写限流（按用户；在鉴权之后执行）──
  app.addHook('preHandler', async (request) => {
    if (!isWriteMethod(request.method)) return;
    const userId = request.auth?.userId;
    if (!userId) return; // 未鉴权的写请求由各自的鉴权守卫拦截
    const decision = await rateLimiter.consume(`write:${userId}`, cfg.limits.writePerMin);
    if (!decision.allowed) {
      throw new AppError('RATE_LIMITED', '写入过于频繁，请稍后再试', {
        retryAfterSec: decision.retryAfterSec,
      });
    }
  });

  // ── 统一错误处理：只暴露安全文案，内部错误进日志 ──
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.status >= 500) request.log.error({ err: error }, '请求处理失败');
      return fail(reply, error);
    }
    const message = error instanceof Error ? error.message : String(error);
    // 校验类错误（如 Fastify 自身的 body 解析失败）
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode === 413) {
      return fail(reply, new AppError('PAYLOAD_TOO_LARGE', '请求体过大'));
    }
    if (statusCode === 415) {
      return fail(reply, new AppError('UNSUPPORTED', '不支持的请求格式（需 application/json）'));
    }
    if (statusCode === 400) {
      return fail(reply, new AppError('VALIDATION_ERROR', '请求格式不正确'));
    }
    request.log.error({ err: error }, '未处理的服务端错误');
    return fail(reply, new AppError('INTERNAL', message));
  });

  app.setNotFoundHandler((_request, reply) => {
    return fail(reply, new AppError('NOT_FOUND', '接口不存在'));
  });

  return { app, ctx };
}
