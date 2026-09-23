/**
 * @module Session/sessionManager
 * @description
 * 会话管理器——管�?Agent 会话生命周期�?
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

/** 会话状�?*/
export type SessionStatus = 'active' | 'paused' | 'archived' | 'closed';

/** 会话信息 */
export interface SessionInfo {
  sessionId: string;
  agentId: string;
  status: SessionStatus;
  createdAt: number;
  lastActiveAt: number;
  metadata: Record<string, unknown>;
}

/** 会话管理器配�?*/
export interface SessionManagerConfig {
  /** 最大并发会话数，默�?50 */
  maxConcurrentSessions: number;
  /** 会话超时（ms），默认 1 小时 */
  sessionTimeoutMs: number;
}

const DEFAULT_CONFIG: SessionManagerConfig = {
  maxConcurrentSessions: 50,
  sessionTimeoutMs: 60 * 60 * 1000,
};

const sessions = new Map<string, SessionInfo>();
let config: SessionManagerConfig = { ...DEFAULT_CONFIG };

/** 初始化会话管理器 */
export function initSessionManager(userConfig?: Partial<SessionManagerConfig>): void {
  if (userConfig) config = { ...DEFAULT_CONFIG, ...userConfig };
  sessions.clear();
}

/** 创建会话 */
export function createSession(agentId: string, metadata: Record<string, unknown> = {}): Result<SessionInfo> {
  const activeCount = Array.from(sessions.values()).filter(s => s.status === 'active').length;
  if (activeCount >= config.maxConcurrentSessions) {
    return err('LIMIT_REACHED', `并发会话数已达上�?(${config.maxConcurrentSessions})`);
  }

  const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const session: SessionInfo = {
    sessionId,
    agentId,
    status: 'active',
    createdAt: now,
    lastActiveAt: now,
    metadata,
  };

  sessions.set(sessionId, session);
  return ok(session);
}

/** 获取会话 */
export function getSession(sessionId: string): Result<SessionInfo> {
  const session = sessions.get(sessionId);
  if (!session) return err('NOT_FOUND', `会话 ${sessionId} 不存在`);
  return ok(session);
}

/** 更新会话活动时间 */
export function touchSession(sessionId: string): Result<void> {
  const session = sessions.get(sessionId);
  if (!session) return err('NOT_FOUND', `会话 ${sessionId} 不存在`);
  session.lastActiveAt = Date.now();
  return ok(undefined);
}

/** 关闭会话 */
export function closeSession(sessionId: string): Result<void> {
  const session = sessions.get(sessionId);
  if (!session) return err('NOT_FOUND', `会话 ${sessionId} 不存在`);
  session.status = 'closed';
  return ok(undefined);
}

/** 获取所有活跃会�?*/
export function getActiveSessions(): SessionInfo[] {
  return Array.from(sessions.values()).filter(s => s.status === 'active');
}

/** 获取会话总数 */
export function getSessionCount(): number {
  return sessions.size;
}

/** 清理超时会话 */
export function cleanupExpiredSessions(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [, session] of sessions) {
    if (session.status === 'active' && (now - session.lastActiveAt) > config.sessionTimeoutMs) {
      session.status = 'archived';
      cleaned++;
    }
  }

  return cleaned;
}
