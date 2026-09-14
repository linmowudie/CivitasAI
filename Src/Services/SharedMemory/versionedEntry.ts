/**
 * @module SharedMemory/versionedEntry
 * @description
 * 版本化条目——Docs/07 §8.2。
 * GlobalWorkspace 条目携带版本号 + 因果令牌 + 冲突策略。
 */

import type { AssertionLevel } from '../EventBus/eventTypes.js';

// ── WorkspaceEntry（Docs/07 §3.1 + §8.2）───────────────────────────

export type ContentType = 'fact' | 'decision' | 'verdict' | 'contract' | 'status';
export type EntryStatus = 'active' | 'superseded' | 'discarded';
export type ConflictStrategy = 'lww' | 'authority' | 'arbitrate';

export interface WorkspaceEntry {
  entryId: string;
  traceId: string;
  agentId: string;
  taskId?: string;
  key: string;                          // 写入键（乐观锁粒度）

  // 内容
  content: string;
  contentType: ContentType;
  assertion: AssertionLevel;            // Docs/07 §8.4

  // 元数据
  metadata: {
    timestamp: number;
    sourceAgentId: string;
    taskAuthority: number;              // 0.0–1.0
    evidenceChain?: string[];
  };

  // 版本控制（Docs/07 §8.2）
  version: number;
  lastModifiedBy: string;
  conflictStrategy: ConflictStrategy;
  causalTokens: string[];              // 因果一致性向量

  // 状态
  status: EntryStatus;
  supersededBy?: string;

  createdAt: number;
  updatedAt: number;
}

// ── WriteResult ─────────────────────────────────────────────────────

export interface WriteResult {
  success: boolean;
  entry?: WorkspaceEntry;
  conflict?: VersionConflict;
  warning?: string;
}

export interface VersionConflict {
  entryId: string;
  key: string;
  expectedVersion: number;
  actualVersion: number;
  agentId: string;
}

// ── WorkspaceQuery ──────────────────────────────────────────────────

export interface WorkspaceQuery {
  key?: string;
  traceId?: string;
  agentId?: string;
  taskId?: string;
  contentType?: ContentType;
  status?: EntryStatus;
  assertion?: AssertionLevel;
  limit?: number;
}
