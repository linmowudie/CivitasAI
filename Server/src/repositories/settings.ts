/**
 * @module repositories/settings
 * @description 用户设置读写（服务端为权威源，revision 单调递增做乐观并发）。
 */

import type { Db } from '../db/pool.js';
import { revisionMismatch } from '../http/errors.js';

export interface SettingsRow {
  user_id: string;
  revision: number;
  data: Record<string, unknown>;
  updated_at: Date;
}

const COLUMNS = 'user_id, revision, data, updated_at';

export async function getSettings(db: Db, userId: string): Promise<SettingsRow | null> {
  return db.one<SettingsRow>(`SELECT ${COLUMNS} FROM user_settings WHERE user_id = $1`, [userId]);
}

/**
 * 写入设置（整体替换 data）。
 *
 * @param expectedRevision 传入时做乐观并发校验：与当前 revision 不一致则抛 REVISION_MISMATCH
 *                         （无记录时当前版本视为 0）
 */
export async function putSettings(
  db: Db,
  userId: string,
  data: Record<string, unknown>,
  expectedRevision?: number,
): Promise<SettingsRow> {
  return db.tx(async (tx) => {
    const current = await getSettings(tx, userId);
    const currentRevision = current?.revision ?? 0;

    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw revisionMismatch(currentRevision);
    }

    if (!current) {
      const inserted = await tx.one<SettingsRow>(
        `INSERT INTO user_settings (user_id, revision, data) VALUES ($1, 1, $2) RETURNING ${COLUMNS}`,
        [userId, JSON.stringify(data)],
      );
      if (!inserted) throw new Error('设置写入失败');
      return inserted;
    }

    const updated = await tx.one<SettingsRow>(
      `UPDATE user_settings SET data = $2, revision = revision + 1, updated_at = now()
       WHERE user_id = $1 RETURNING ${COLUMNS}`,
      [userId, JSON.stringify(data)],
    );
    if (!updated) throw new Error('设置更新失败');
    return updated;
  });
}

/**
 * 浅合并（PATCH 语义）：只覆盖传入的顶层键。
 * `null` 值表示删除该键（便于客户端清理设置项）。
 */
export async function patchSettings(
  db: Db,
  userId: string,
  patch: Record<string, unknown>,
  expectedRevision?: number,
): Promise<SettingsRow> {
  const current = await getSettings(db, userId);
  const merged: Record<string, unknown> = { ...(current?.data ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return putSettings(db, userId, merged, expectedRevision);
}

export async function deleteSettings(db: Db, userId: string): Promise<void> {
  await db.execute('DELETE FROM user_settings WHERE user_id = $1', [userId]);
}
