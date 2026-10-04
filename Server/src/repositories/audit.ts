/**
 * @module repositories/audit
 * @description 审计日志：登录成功/失败、令牌重用、改密、注销等安全事件。
 * 审计写入失败**不得**影响主流程（吞掉错误并返回 false）。
 */

import type { Db } from '../db/pool.js';

export interface AuditInput {
  userId?: string | null;
  action: string;
  outcome: 'success' | 'failure';
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
}

export async function recordAudit(db: Db, input: AuditInput): Promise<boolean> {
  try {
    await db.execute(
      `INSERT INTO audit_log (user_id, action, outcome, ip, user_agent, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.userId ?? null,
        input.action,
        input.outcome,
        input.ip ?? null,
        input.userAgent ?? null,
        input.detail ? JSON.stringify(input.detail) : null,
      ],
    );
    return true;
  } catch {
    return false;
  }
}

export interface AuditRow {
  id: number;
  user_id: string | null;
  action: string;
  outcome: 'success' | 'failure';
  ip: string | null;
  user_agent: string | null;
  detail: unknown;
  created_at: Date;
}

/** 查询某用户的审计记录（个人中心"登录记录"用） */
export async function listAuditForUser(db: Db, userId: string, limit = 50): Promise<AuditRow[]> {
  return db.query<AuditRow>(
    `SELECT id, user_id, action, outcome, ip, user_agent, detail, created_at
     FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
}
