/**
 * 会话仓库（Docs/10 §2.8）
 *
 * 职责：sessions 表的 CRUD 操作
 * camelCase ↔ snake_case 映射由本层统一处理
 */

import { getMainDb } from '../database.js';
import type { Result } from '../../types.js';
import { ok, err } from '../../types.js';

// ===== 类型定义 =====

/** Session 领域对象（camelCase） */
export interface Session {
  sessionKey: string;
  traceId?: string;
  userId?: string;
  description?: string;
  status: string;
  createdAt: number;
  lastActiveAt: number;
  archivedAt?: number;
}

/** Session 数据库行（snake_case） */
interface SessionRow {
  session_key: string;
  trace_id: string | null;
  user_id: string | null;
  description: string | null;
  status: string;
  created_at: number;
  last_active_at: number;
  archived_at: number | null;
}

// ===== 映射函数 =====

function rowToSession(row: SessionRow): Session {
  return {
    sessionKey: row.session_key,
    traceId: row.trace_id ?? undefined,
    userId: row.user_id ?? undefined,
    description: row.description ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

// ===== 公开 API =====

/**
 * 创建会话
 */
export function createSession(session: Session): Result<Session> {
  try {
    const db = getMainDb();
    db.prepare(`
      INSERT INTO sessions (session_key, trace_id, user_id, description, status, created_at, last_active_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.sessionKey, session.traceId ?? null, session.userId ?? null,
      session.description ?? null, session.status, session.createdAt, session.lastActiveAt,
    );
    return ok(session);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`创建会话失败: ${message}`, 'ERROR');
  }
}

/**
 * 根据 session_key 查询会话
 */
export function getSession(sessionKey: string): Result<Session | null> {
  try {
    const db = getMainDb();
    const row = db.prepare('SELECT * FROM sessions WHERE session_key = ?').get(sessionKey) as SessionRow | undefined;
    return ok(row ? rowToSession(row) : null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`查询会话失败: ${message}`, 'ERROR');
  }
}

/**
 * 更新会话最后活跃时间
 */
export function updateLastActive(sessionKey: string, lastActiveAt: number): Result<void> {
  try {
    const db = getMainDb();
    db.prepare('UPDATE sessions SET last_active_at = ? WHERE session_key = ?').run(lastActiveAt, sessionKey);
    return ok(undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`更新会话失败: ${message}`, 'ERROR');
  }
}

/**
 * 归档会话
 */
export function archiveSession(sessionKey: string, archivedAt: number): Result<void> {
  try {
    const db = getMainDb();
    db.prepare('UPDATE sessions SET status = ?, archived_at = ? WHERE session_key = ?')
      .run('archived', archivedAt, sessionKey);
    return ok(undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`归档会话失败: ${message}`, 'ERROR');
  }
}

/**
 * 列出所有活跃会话
 */
export function listActiveSessions(): Result<Session[]> {
  try {
    const db = getMainDb();
    const rows = db.prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY last_active_at DESC").all() as SessionRow[];
    return ok(rows.map(rowToSession));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`列出会话失败: ${message}`, 'ERROR');
  }
}
