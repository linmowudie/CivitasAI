/**
 * @module services/memoryService
 * @description 记忆存储服务：CRUD + 批量（恢复）+ 分页检索。
 */

import type { ServerConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { notFound, payloadTooLarge } from '../http/errors.js';
import * as repo from '../repositories/memories.js';

export interface MemoryDto {
  id: string;
  clientMemoryId: string | null;
  title: string;
  content: string;
  category: string;
  assertion: repo.MemoryRow['assertion'];
  status: repo.MemoryRow['status'];
  contradictedBy: string | null;
  sourceTraceIds: unknown[];
  sourceArbitrationIds: unknown[] | null;
  accessCount: number;
  createdAt: string;
  lastAccessedAt: string;
  updatedAt: string;
}

export function toMemoryDto(row: repo.MemoryRow): MemoryDto {
  return {
    id: row.id,
    clientMemoryId: row.client_memory_id,
    title: row.title,
    content: row.content,
    category: row.category,
    assertion: row.assertion,
    status: row.status,
    contradictedBy: row.contradicted_by,
    sourceTraceIds: Array.isArray(row.source_trace_ids) ? (row.source_trace_ids as unknown[]) : [],
    sourceArbitrationIds: Array.isArray(row.source_arbitration_ids)
      ? (row.source_arbitration_ids as unknown[])
      : null,
    accessCount: row.access_count,
    createdAt: new Date(row.created_at).toISOString(),
    lastAccessedAt: new Date(row.last_accessed_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface MemoryService {
  list(
    userId: string,
    options: repo.ListMemoriesOptions,
  ): Promise<{ items: MemoryDto[]; nextCursor: string | null }>;
  get(userId: string, id: string): Promise<MemoryDto>;
  create(userId: string, input: repo.MemoryInput): Promise<{ memory: MemoryDto; created: boolean }>;
  update(userId: string, id: string, patch: repo.MemoryPatch): Promise<MemoryDto>;
  remove(userId: string, id: string, hard: boolean): Promise<void>;
  bulkUpsert(userId: string, items: repo.MemoryInput[]): Promise<repo.BulkUpsertResult>;
  count(userId: string, status?: repo.MemoryRow['status']): Promise<number>;
  all(userId: string): Promise<MemoryDto[]>;
}

export function createMemoryService(deps: { db: Db; cfg: ServerConfig }): MemoryService {
  const { db, cfg } = deps;

  return {
    async list(userId, options) {
      const result = await repo.listMemories(db, userId, options);
      return { items: result.items.map(toMemoryDto), nextCursor: result.nextCursor };
    },

    async get(userId, id) {
      const row = await repo.getMemory(db, userId, id);
      if (!row) throw notFound('记忆不存在');
      return toMemoryDto(row);
    },

    async create(userId, input) {
      // 有 clientMemoryId 时先探测是否已存在，用于返回 created 标志（幂等 upsert 语义）
      const existing = input.clientMemoryId
        ? await repo.getMemoryByClientId(db, userId, input.clientMemoryId)
        : null;
      const row = await repo.upsertMemory(db, userId, input);
      return { memory: toMemoryDto(row), created: !existing };
    },

    async update(userId, id, patch) {
      const row = await repo.updateMemory(db, userId, id, patch);
      if (!row) throw notFound('记忆不存在');
      return toMemoryDto(row);
    },

    async remove(userId, id, hard) {
      const ok = await repo.deleteMemory(db, userId, id, hard);
      if (!ok) throw notFound('记忆不存在或已删除');
    },

    async bulkUpsert(userId, items) {
      if (items.length > cfg.limits.maxMemoriesPerBulk) {
        throw payloadTooLarge(`单次最多上传 ${cfg.limits.maxMemoriesPerBulk} 条记忆`, {
          max: cfg.limits.maxMemoriesPerBulk,
          submitted: items.length,
        });
      }
      return repo.bulkUpsertMemories(db, userId, items);
    },

    async count(userId, status) {
      return repo.countMemories(db, userId, status);
    },

    async all(userId) {
      return (await repo.listAllMemories(db, userId)).map(toMemoryDto);
    },
  };
}
