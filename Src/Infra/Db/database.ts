/**
 * 数据库连接管理（Docs/02 §7.1 ⑥ / Docs/10 §1）
 *
 * 职责：
 * - 管理三个 SQLite 数据库连接（main / events / memory）
 * - WAL 模式 + busy timeout
 * - 单写者锁（SQLite 限制）
 * - PRAGMA 初始化（foreign_keys = ON）
 *
 * 三库分离：
 * - civitas_main.db：主业务（任务、Agent、Token、会话等）
 * - civitas_events.db：事件溯源 + effect_journal（仅追加）
 * - civitas_memory.db：共享记忆 + 长期记忆
 */

import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

import Database from 'better-sqlite3';

import type { Result } from '../types.js';
import { ok, err } from '../types.js';

// ===== 类型定义 =====

/** 数据库配置 */
export interface DatabaseConfig {
  mainPath: string;
  eventsPath: string;
  memoryPath: string;
  walMode?: boolean;
  busyTimeoutMs?: number;
}

/** 数据库连接集合 */
export interface DatabaseConnections {
  readonly main: Database.Database;
  readonly events: Database.Database;
  readonly memory: Database.Database;
}

// ===== 内部状态 =====

let connections: DatabaseConnections | null = null;

// ===== 公开 API =====

/**
 * 初始化数据库连接
 *
 * 启动 ⑥ 步调用。创建目录、打开连接、设置 PRAGMA。
 * 失败为 FATAL（启动终止）。
 */
export function initDatabase(config: DatabaseConfig): Result<DatabaseConnections> {
  if (connections) return ok(connections);

  try {
    const mainDb = openDatabase(config.mainPath, config);
    const eventsDb = openDatabase(config.eventsPath, config);
    const memoryDb = openDatabase(config.memoryPath, config);

    connections = { main: mainDb, events: eventsDb, memory: memoryDb };
    return ok(connections);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`数据库初始化失败: ${message}`, 'FATAL');
  }
}

/**
 * 获取数据库连接集合
 */
export function getDatabases(): DatabaseConnections {
  if (!connections) throw new Error('数据库未初始化，请先调用 initDatabase()');
  return connections;
}

/**
 * 获取主数据库连接
 */
export function getMainDb(): Database.Database {
  return getDatabases().main;
}

/**
 * 获取事件数据库连接
 */
export function getEventsDb(): Database.Database {
  return getDatabases().events;
}

/**
 * 获取记忆数据库连接
 */
export function getMemoryDb(): Database.Database {
  return getDatabases().memory;
}

/**
 * 关闭所有数据库连接
 */
export function closeDatabase(): void {
  if (!connections) return;
  try { connections.main.close(); } catch { /* ignore */ }
  try { connections.events.close(); } catch { /* ignore */ }
  try { connections.memory.close(); } catch { /* ignore */ }
  connections = null;
}

/**
 * 检查数据库是否已初始化
 */
export function isDatabaseInitialized(): boolean {
  return connections !== null;
}

// ===== 内部函数 =====

/**
 * 打开单个数据库连接
 */
function openDatabase(dbPath: string, config: DatabaseConfig): Database.Database {
  const resolvedPath = resolve(dbPath);

  // 确保目录存在
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);

  // 设置 PRAGMA
  const walMode = config.walMode ?? true;
  const busyTimeout = config.busyTimeoutMs ?? 5000;

  if (walMode) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma(`busy_timeout = ${busyTimeout}`);
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL'); // WAL 模式下 NORMAL 足够

  return db;
}
