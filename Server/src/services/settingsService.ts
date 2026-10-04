/**
 * @module services/settingsService
 * @description 设置管理：读取 / 整体写入 / 浅合并 / 概览。
 * 服务端为权威源，返回 revision 供客户端做乐观并发。
 */

import type { ServerConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { payloadTooLarge } from '../http/errors.js';
import * as repo from '../repositories/settings.js';

export interface SettingsDto {
  revision: number;
  data: Record<string, unknown>;
  updatedAt: string;
}

export function toSettingsDto(row: repo.SettingsRow): SettingsDto {
  return {
    revision: row.revision,
    data: row.data ?? {},
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface SettingsService {
  get(userId: string): Promise<SettingsDto>;
  put(userId: string, data: Record<string, unknown>, expectedRevision?: number): Promise<SettingsDto>;
  patch(userId: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<SettingsDto>;
  /** 是否已存在设置（备份导出用） */
  peek(userId: string): Promise<SettingsDto | null>;
  reset(userId: string): Promise<void>;
}

export function createSettingsService(deps: { db: Db; cfg: ServerConfig }): SettingsService {
  const { db, cfg } = deps;

  /** 体积上限：设置是自由 JSON，但要防止超大对象拖垮库与内存 */
  function assertSize(data: Record<string, unknown>): void {
    const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
    if (bytes > cfg.limits.maxSettingsBytes) {
      throw payloadTooLarge(
        `设置体积超限（${bytes} > ${cfg.limits.maxSettingsBytes} 字节）`,
        { maxBytes: cfg.limits.maxSettingsBytes },
      );
    }
  }

  return {
    async get(userId) {
      const row = await repo.getSettings(db, userId);
      return row ? toSettingsDto(row) : { revision: 0, data: {}, updatedAt: new Date(0).toISOString() };
    },
    async peek(userId) {
      const row = await repo.getSettings(db, userId);
      return row ? toSettingsDto(row) : null;
    },
    async put(userId, data, expectedRevision) {
      assertSize(data);
      return toSettingsDto(await repo.putSettings(db, userId, data, expectedRevision));
    },
    async patch(userId, patch, expectedRevision) {
      // 与现有数据合并后再校验体积，避免"分多次 patch 绕过上限"
      const current = await repo.getSettings(db, userId);
      const merged: Record<string, unknown> = { ...(current?.data ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      assertSize(merged);
      return toSettingsDto(await repo.patchSettings(db, userId, patch, expectedRevision));
    },
    async reset(userId) {
      await repo.deleteSettings(db, userId);
    },
  };
}
