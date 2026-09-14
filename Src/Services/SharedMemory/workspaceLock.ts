/**
 * @module SharedMemory/workspaceLock
 * @description
 * 工作区锁——Docs/07 §8.3。
 * 支持 READ / WRITE / EXCLUSIVE 三种锁模式。
 * 并行 Agent 通过锁机制隔离工作区。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 类型 ────────────────────────────────────────────────────────────

export type LockMode = 'READ' | 'WRITE' | 'EXCLUSIVE';

export interface LockRequest {
  key: string;
  agentId: string;
  mode: LockMode;
  ttlMs: number;
}

export interface LockGrant {
  grantId: string;
  key: string;
  agentId: string;
  mode: LockMode;
  acquiredAt: number;
  expiresAt: number;
}

export interface LockRejected {
  key: string;
  agentId: string;
  reason: string;
}

// ── 内部状态 ────────────────────────────────────────────────────────

interface ActiveLock {
  grantId: string;
  key: string;
  agentId: string;
  mode: LockMode;
  expiresAt: number;
}

const activeLocks: Map<string, ActiveLock[]> = new Map(); // key → locks
let grantCounter = 0;

// ── 获取锁 ──────────────────────────────────────────────────────────

export function acquireLock(request: LockRequest): Result<LockGrant | LockRejected> {
  const now = Date.now();
  const keyLocks = activeLocks.get(request.key) ?? [];

  // 清理过期锁
  const valid = keyLocks.filter(l => l.expiresAt > now);
  activeLocks.set(request.key, valid);

  // EXCLUSIVE 冲突检查
  if (request.mode === 'EXCLUSIVE' || request.mode === 'WRITE') {
    const hasExclusive = valid.some(l => l.mode === 'EXCLUSIVE' || l.mode === 'WRITE');
    if (hasExclusive) {
      return ok({
        key: request.key,
        agentId: request.agentId,
        reason: `Key "${request.key}" 已被其他 Agent 独占/写锁定`,
      } as LockRejected);
    }
  }

  if (request.mode === 'READ') {
    const hasExclusive = valid.some(l => l.mode === 'EXCLUSIVE');
    if (hasExclusive) {
      return ok({
        key: request.key,
        agentId: request.agentId,
        reason: `Key "${request.key}" 已被独占锁定，不可读`,
      } as LockRejected);
    }
  }

  // 授予锁
  const grantId = `lock-${++grantCounter}`;
  const grant: ActiveLock = {
    grantId,
    key: request.key,
    agentId: request.agentId,
    mode: request.mode,
    expiresAt: now + request.ttlMs,
  };

  valid.push(grant);
  activeLocks.set(request.key, valid);

  return ok({
    grantId,
    key: request.key,
    agentId: request.agentId,
    mode: request.mode,
    acquiredAt: now,
    expiresAt: grant.expiresAt,
  } as LockGrant);
}

// ── 释放锁 ──────────────────────────────────────────────────────────

export function releaseLock(grantId: string): Result<void> {
  for (const [key, locks] of activeLocks) {
    const idx = locks.findIndex(l => l.grantId === grantId);
    if (idx >= 0) {
      locks.splice(idx, 1);
      if (locks.length === 0) activeLocks.delete(key);
      return ok(undefined);
    }
  }
  return err(`Lock grant ${grantId} 不存在`);
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getActiveLocks(key?: string): LockGrant[] {
  const now = Date.now();
  if (key) {
    return (activeLocks.get(key) ?? [])
      .filter(l => l.expiresAt > now)
      .map(l => ({
        grantId: l.grantId,
        key: l.key,
        agentId: l.agentId,
        mode: l.mode,
        acquiredAt: 0,
        expiresAt: l.expiresAt,
      }));
  }
  const all: LockGrant[] = [];
  for (const locks of activeLocks.values()) {
    for (const l of locks) {
      if (l.expiresAt > now) {
        all.push({
          grantId: l.grantId,
          key: l.key,
          agentId: l.agentId,
          mode: l.mode,
          acquiredAt: 0,
          expiresAt: l.expiresAt,
        });
      }
    }
  }
  return all;
}

// ── 清理 ────────────────────────────────────────────────────────────

export function resetWorkspaceLock(): void {
  activeLocks.clear();
  grantCounter = 0;
}
