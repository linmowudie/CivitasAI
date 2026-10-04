/**
 * @module db/pool
 * @description PostgreSQL 连接池与查询辅助。
 *
 * 所有 SQL 一律参数化（`$1, $2, ...`），杜绝拼接注入。
 * 事务通过 `db.tx()` 提供，回调抛错即回滚。
 */

import pg from 'pg';
import type { DbConfig } from '../config.js';

/** pg 把 int8/numeric 默认解析为字符串（防精度丢失）；这里保持原样，由上层决定转换 */
pg.types.setTypeParser(20, (v) => Number(v)); // int8 -> number（计数场景安全）

export interface QueryParams extends Array<unknown> {}

export interface Db {
  /** 执行查询，返回行数组 */
  query<T = Record<string, unknown>>(sql: string, params?: QueryParams): Promise<T[]>;
  /** 执行查询，返回首行或 null */
  one<T = Record<string, unknown>>(sql: string, params?: QueryParams): Promise<T | null>;
  /** 执行写操作，返回受影响行数 */
  execute(sql: string, params?: QueryParams): Promise<number>;
  /** 事务：回调内使用同一连接；抛错自动回滚 */
  tx<T>(fn: (client: Db) => Promise<T>): Promise<T>;
  /** 连通性探测 */
  ping(): Promise<boolean>;
  /** 关闭连接池 */
  close(): Promise<void>;
}

function wrap(queryable: pg.Pool | pg.PoolClient): Omit<Db, 'tx' | 'close' | 'ping'> & { tx?: Db['tx'] } {
  return {
    async query<T>(sql: string, params: QueryParams = []): Promise<T[]> {
      const res = await queryable.query(sql, params as unknown[]);
      return res.rows as T[];
    },
    async one<T>(sql: string, params: QueryParams = []): Promise<T | null> {
      const res = await queryable.query(sql, params as unknown[]);
      return (res.rows[0] as T | undefined) ?? null;
    },
    async execute(sql: string, params: QueryParams = []): Promise<number> {
      const res = await queryable.query(sql, params as unknown[]);
      return res.rowCount ?? 0;
    },
  };
}

/** 创建连接池 Db 实例 */
export function createDb(databaseUrl: string, cfg: DbConfig): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: cfg.poolMax,
    idleTimeoutMillis: cfg.idleTimeoutMs,
    connectionTimeoutMillis: cfg.connectionTimeoutMs,
    statement_timeout: cfg.statementTimeoutMs,
    application_name: 'civitas-server',
  });

  // 池级错误（连接被后端断开等）不应让进程崩溃
  pool.on('error', () => { /* 交由各请求的错误处理与日志记录 */ });

  const base = wrap(pool);

  return {
    ...base,
    async tx<T>(fn: (client: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const clientDb: Db = {
        ...wrap(client),
        tx: (inner) => inner(clientDb),
        async ping() { return true; },
        async close() { /* 事务内不允许关闭池 */ },
      };
      try {
        await client.query('BEGIN');
        const result = await fn(clientDb);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch { /* 回滚失败：连接可能已断，忽略并抛出原始错误 */ }
        throw err;
      } finally {
        client.release();
      }
    },
    async ping(): Promise<boolean> {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
