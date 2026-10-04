/**
 * @module services/taskService
 * @description 任务（会话）**元数据**服务：标题 + 归档状态。
 *
 * 语义（与产品决策一致）：
 *  - 服务端权威：以最后一次上行的时间戳为准（客户端上行 archivedAt 决定归档与否）；
 *  - 幂等：以 `clientSessionId` 为键 upsert，重复上行不会产生重复项；
 *  - 正文永不上行：消息与工具轨迹只存本机。
 */

import type { Db } from '../db/pool.js';
import * as tasks from '../repositories/tasks.js';

export interface TaskDto {
  clientSessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** null = 未归档 */
  archivedAt: number | null;
}

export interface TaskInputDto {
  clientSessionId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
}

export interface TaskService {
  list(userId: string, options?: { archived?: boolean; limit?: number }): Promise<{ items: TaskDto[]; total: number }>;
  /** 批量 upsert（幂等）；返回新增/更新计数 */
  upsertMany(userId: string, items: TaskInputDto[]): Promise<{ created: number; updated: number; total: number }>;
  /** 概览：任务总数与已归档数 */
  counts(userId: string): Promise<{ total: number; archived: number }>;
  /** 导出用全量（键集分页，不静默截断） */
  listAll(userId: string): Promise<TaskDto[]>;
}

function toDto(row: tasks.UserTaskRow): TaskDto {
  return {
    clientSessionId: row.client_session_id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : Number(row.archived_at),
  };
}

export function createTaskService(deps: { db: Db }): TaskService {
  const { db } = deps;

  return {
    async list(userId, options = {}) {
      const rows = await tasks.listTasks(db, userId, options);
      return { items: rows.map(toDto), total: rows.length };
    },

    async upsertMany(userId, items) {
      const result = await tasks.bulkUpsertTasks(
        db,
        userId,
        items.map((i) => ({
          clientSessionId: i.clientSessionId,
          title: i.title ?? '',
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
          archivedAt: i.archivedAt ?? null,
        })),
      );
      return { ...result, total: items.length };
    },

    async counts(userId) {
      return tasks.countTasks(db, userId);
    },

    async listAll(userId) {
      const rows = await tasks.listAllTasks(db, userId);
      return rows.map(toDto);
    },
  };
}
