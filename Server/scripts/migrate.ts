#!/usr/bin/env tsx
/**
 * 迁移 CLI：`npm run migrate` / `npm run migrate:status` / `--dry-run`
 */
import { resolve } from 'node:path';
import { readEnv, loadConfig, SERVER_ROOT } from '../src/config.js';
import { createDb } from '../src/db/pool.js';
import { runMigrations, listApplied, loadMigrations } from '../src/db/migrate.js';

const args = new Set(process.argv.slice(2));
const MIGRATIONS_DIR = resolve(SERVER_ROOT, 'migrations');

async function main(): Promise<void> {
  const cfgResult = loadConfig(readEnv());
  if (!cfgResult.ok || !cfgResult.config) {
    console.error('✖ 配置校验失败：');
    for (const e of cfgResult.errors ?? []) console.error('  -', e);
    process.exit(1);
  }
  const cfg = cfgResult.config;

  const db = createDb(cfg.databaseUrl, cfg.db);
  if (!(await db.ping())) {
    console.error('✖ 无法连接数据库，请检查 DATABASE_URL 与数据库是否已启动：');
    console.error('  ', cfg.databaseUrl.replace(/:\/\/[^@]+@/, '://***@'));
    await db.close();
    process.exit(1);
  }

  try {
    if (args.has('--status')) {
      const files = loadMigrations(MIGRATIONS_DIR);
      const applied = await listApplied(db);
      const appliedSet = new Set(applied.map((a) => a.name));
      console.log(`迁移目录: ${MIGRATIONS_DIR}`);
      console.log(`已应用: ${applied.length} / 共 ${files.length}\n`);
      for (const f of files) {
        const a = applied.find((x) => x.name === f.name);
        console.log(`  ${appliedSet.has(f.name) ? '✔' : '·'} ${f.name}${a ? `  (${a.applied_at})` : '  [待执行]'}`);
      }
      return;
    }

    const dryRun = args.has('--dry-run');
    const result = await runMigrations(db, MIGRATIONS_DIR, { dryRun });
    if (result.alreadyUpToDate) {
      console.log(`✔ 数据库已是最新（${result.skipped.length} 个迁移全部已应用）`);
      return;
    }
    console.log(`${dryRun ? '（dry-run）将执行' : '✔ 已执行'} ${result.applied.length} 个迁移：`);
    for (const name of result.applied) console.log('  -', name);
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('✖ 迁移失败:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
