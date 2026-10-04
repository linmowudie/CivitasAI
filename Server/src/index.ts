#!/usr/bin/env tsx
/**
 * 服务端入口：加载配置 → 连接数据库 → 构建应用 → 监听 → 优雅退出。
 *
 * 失败即退出（fail-fast）：配置错误、数据库不可用都不会"半启动"。
 */

import { loadConfig, readEnv } from './config.js';
import { createDb } from './db/pool.js';
import { buildApp } from './app.js';
import { purgeInactive } from './repositories/refreshTokens.js';

/** 历史刷新令牌保留天数：已吊销/已过期且签发超过该天数的记录会被定期清理（SV-004） */
const TOKEN_RETENTION_DAYS = 60;
/** 令牌清理间隔：6 小时 */
const TOKEN_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

async function main(): Promise<void> {
  const cfgResult = loadConfig(readEnv());
  if (!cfgResult.ok || !cfgResult.config) {
    console.error('✖ 配置校验失败，服务端拒绝启动：');
    for (const err of cfgResult.errors ?? []) console.error('  -', err);
    process.exit(1);
  }
  const cfg = cfgResult.config;
  for (const warn of cfgResult.warnings ?? []) console.warn('⚠ ', warn);

  const db = createDb(cfg.databaseUrl, cfg.db);
  if (!(await db.ping())) {
    console.error('✖ 数据库不可用，请检查 DATABASE_URL 或先启动数据库（npm run db:up）');
    await db.close();
    process.exit(1);
  }

  const { app, ctx } = buildApp({ cfg, db });

  // 定期清理历史令牌（SV-004）：启动即扫一次，此后每 6 小时一次；失败不阻断服务
  const sweepTokens = async (): Promise<void> => {
    try {
      const purged = await purgeInactive(db, TOKEN_RETENTION_DAYS);
      if (purged > 0) {
        app.log.info({ purged, olderThanDays: TOKEN_RETENTION_DAYS }, '已清理历史刷新令牌');
      }
    } catch (err) {
      app.log.warn({ err }, '历史刷新令牌清理失败（不影响服务）');
    }
  };
  void sweepTokens();
  const purgeTimer = setInterval(() => void sweepTokens(), TOKEN_PURGE_INTERVAL_MS);
  purgeTimer.unref(); // 定时器不阻止进程自然退出

  const shutdown = async (signal: string): Promise<void> => {
    clearInterval(purgeTimer);
    app.log.info({ signal }, '收到退出信号，正在优雅关闭');
    try {
      await app.close();
      await db.close();
      ctx.rateLimiter.dispose();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info(
    { env: cfg.env, host: cfg.host, port: cfg.port, statsTimezone: cfg.statsTimezone },
    `Civitas 服务端已就绪 — http://${cfg.host}:${cfg.port}`,
  );
}

main().catch((err: unknown) => {
  console.error('✖ 服务端启动失败:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
