/**
 * 事务管理（Docs/10 §1.1）
 *
 * 职责：
 * - 提供事务包装函数
 * - 支持嵌套事务（SQLite 使用 SAVEPOINT）
 * - 自动提交/回滚
 */

import type Database from 'better-sqlite3';
import { getMainDb, getEventsDb, getMemoryDb } from './database.js';
import type { Result } from '../types.js';
import { ok, err } from '../types.js';

/**
 * 在主库中执行事务
 */
export function transaction<T>(fn: () => T): Result<T> {
  return runInTransaction(getMainDb(), fn);
}

/**
 * 在事件库中执行事务
 */
export function eventsTransaction<T>(fn: () => T): Result<T> {
  return runInTransaction(getEventsDb(), fn);
}

/**
 * 在记忆库中执行事务
 */
export function memoryTransaction<T>(fn: () => T): Result<T> {
  return runInTransaction(getMemoryDb(), fn);
}

/**
 * 在指定数据库中执行事务
 */
function runInTransaction<T>(db: Database.Database, fn: () => T): Result<T> {
  try {
    const runTx = db.transaction(() => fn());
    const result = runTx();
    return ok(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`事务执行失败: ${message}`, 'ERROR');
  }
}
