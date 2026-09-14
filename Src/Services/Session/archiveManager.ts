/**
 * @module Session/archiveManager
 * @description
 * 归档管理器——管理会话和循环的归档存储�?
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

/** 归档类型 */
export type ArchiveType = 'session' | 'operation' | 'decision';

/** 归档条目 */
export interface ArchiveEntry {
  archiveId: string;
  sessionId: string;
  agentId: string;
  archivedAt: number;
  /** 归档类型 */
  type: ArchiveType;
  /** 归档数据摘要 */
  summary: string;
  /** 归档数据 */
  data: Record<string, unknown>;
  /** 归档大小（字节估算） */
  sizeBytes: number;
}

/** 归档配置 */
export interface ArchiveConfig {
  /** 最大归档条目数，默�?1000 */
  maxEntries: number;
  /** 最大归档存储（字节），默认 50MB */
  maxStorageBytes: number;
}

const DEFAULT_CONFIG: ArchiveConfig = {
  maxEntries: 1000,
  maxStorageBytes: 50 * 1024 * 1024,
};

const archives = new Map<string, ArchiveEntry>();
let config: ArchiveConfig = { ...DEFAULT_CONFIG };
let totalSizeBytes = 0;

/** 初始化归档管理器 */
export function initArchiveManager(userConfig?: Partial<ArchiveConfig>): void {
  if (userConfig) config = { ...DEFAULT_CONFIG, ...userConfig };
  archives.clear();
  totalSizeBytes = 0;
}

/** 创建归档 */
export function createArchive(
  sessionId: string,
  agentId: string,
  summary: string,
  data: Record<string, unknown>,
  type: ArchiveType = 'session',
): Result<ArchiveEntry> {
  if (archives.size >= config.maxEntries) {
    return err('LIMIT_REACHED', `归档数已达上�?(${config.maxEntries})`);
  }

  const dataStr = JSON.stringify(data);
  const sizeBytes = new TextEncoder().encode(dataStr).length;

  if (totalSizeBytes + sizeBytes > config.maxStorageBytes) {
    return err('LIMIT_REACHED', `归档存储空间已满 (${config.maxStorageBytes} bytes)`);
  }

  const archiveId = `arc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: ArchiveEntry = {
    archiveId,
    sessionId,
    agentId,
    archivedAt: Date.now(),
    type,
    summary,
    data,
    sizeBytes,
  };

  archives.set(archiveId, entry);
  totalSizeBytes += sizeBytes;

  return ok(entry);
}

/** 获取归档 */
export function getArchive(archiveId: string): Result<ArchiveEntry> {
  const entry = archives.get(archiveId);
  if (!entry) return err('NOT_FOUND', `归档 ${archiveId} 不存在`);
  return ok(entry);
}

/** 按会话查询归档 */
export function getArchivesBySession(sessionId: string): ArchiveEntry[] {
  return Array.from(archives.values()).filter(a => a.sessionId === sessionId);
}

/** 按类型查询归档 */
export function getArchivesByType(type: ArchiveType): ArchiveEntry[] {
  return Array.from(archives.values()).filter(a => a.type === type);
}

/** 归档操作历史 */
export function archiveOperation(
  sessionId: string,
  agentId: string,
  summary: string,
  data: Record<string, unknown>,
): Result<ArchiveEntry> {
  return createArchive(sessionId, agentId, summary, data, 'operation');
}

/** 归档决策历史 */
export function archiveDecision(
  sessionId: string,
  agentId: string,
  summary: string,
  data: Record<string, unknown>,
): Result<ArchiveEntry> {
  return createArchive(sessionId, agentId, summary, data, 'decision');
}

/** 获取归档总数 */
export function getArchiveCount(): number {
  return archives.size;
}

/** 获取存储统计 */
export function getArchiveStats(): { count: number; totalSizeBytes: number; maxEntries: number; maxStorageBytes: number } {
  return { count: archives.size, totalSizeBytes, maxEntries: config.maxEntries, maxStorageBytes: config.maxStorageBytes };
}
