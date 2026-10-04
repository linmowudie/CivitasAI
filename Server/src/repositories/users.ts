/**
 * @module repositories/users
 * @description 用户表读写。
 */

import type { Db } from '../db/pool.js';
import { conflict } from '../http/errors.js';
import { createHash } from 'node:crypto';

export interface UserRow {
  id: string;
  email: string;
  email_lower: string;
  password_hash: string;
  display_name: string | null;
  status: 'active' | 'disabled';
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
  password_changed_at: Date;
  /** 绑定的设备 ID（null 表示未绑定） */
  bound_device_id: string | null;
  /** 设备绑定时间 */
  device_bound_at: Date | null;
}

const COLUMNS = `id, email, email_lower, password_hash, display_name, status,
                 created_at, updated_at, last_login_at, password_changed_at,
                 bound_device_id, device_bound_at`;

export interface CreateUserInput {
  email: string;
  emailLower: string;
  passwordHash: string;
  displayName?: string | null;
}

/** 创建用户；邮箱冲突抛 CONFLICT */
export async function createUser(db: Db, input: CreateUserInput): Promise<UserRow> {
  try {
    const row = await db.one<UserRow>(
      `INSERT INTO users (email, email_lower, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [input.email, input.emailLower, input.passwordHash, input.displayName ?? null],
    );
    if (!row) throw conflict('用户创建失败');
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('该邮箱已被注册');
    }
    throw err;
  }
}

export async function findUserByEmail(db: Db, emailLower: string): Promise<UserRow | null> {
  return db.one<UserRow>(`SELECT ${COLUMNS} FROM users WHERE email_lower = $1`, [emailLower]);
}

export async function findUserById(db: Db, id: string): Promise<UserRow | null> {
  return db.one<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
}

export async function updateDisplayName(db: Db, id: string, displayName: string | null): Promise<UserRow | null> {
  return db.one<UserRow>(
    `UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, displayName],
  );
}

export async function updatePasswordHash(db: Db, id: string, passwordHash: string): Promise<void> {
  await db.execute(
    `UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1`,
    [id, passwordHash],
  );
}

export async function touchLastLogin(db: Db, id: string): Promise<void> {
  await db.execute(`UPDATE users SET last_login_at = now() WHERE id = $1`, [id]);
}

export async function setUserStatus(db: Db, id: string, status: 'active' | 'disabled'): Promise<void> {
  await db.execute(`UPDATE users SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
}

/** 注销账号：级联删除该用户全部数据（设置/记忆/统计/令牌/审计保留匿名记录） */
export async function deleteUser(db: Db, id: string): Promise<boolean> {
  const affected = await db.execute('DELETE FROM users WHERE id = $1', [id]);
  return affected > 0;
}

/** PG 唯一约束冲突（23505） */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// ── 设备绑定 ──────────────────────────────────────────────────────────────

export interface UserDeviceRow {
  id: string;
  user_id: string;
  device_id: string;
  device_label: string | null;
  user_agent: string | null;
  ip: string | null;
  is_primary: boolean;
  bound_at: Date;
  revoked_at: Date | null;
  /** 设备凭据哈希（安装期生成的随机凭据；不再依赖易变硬件指纹） */
  credential_hash: string | null;
  /** install（安装期凭据）/ legacy（旧硬件指纹）/ manual */
  device_kind: string;
  last_seen_at: Date | null;
}

export interface DeviceUpsertOptions {
  label?: string | undefined;
  userAgent?: string | undefined;
  ip?: string | undefined;
  /** 设备凭据原始串（内部哈希后存储；不落明文） */
  credential?: string | undefined;
  kind?: string | undefined;
}

/**
 * 登记/更新设备（登录时调用）。
 *
 * 安全审计修复（SV-014 / FE-033）：
 *  - 不再以"易变硬件指纹"作为身份依据：设备由**客户端安装期生成的稳定凭据**标识，
 *    服务端只存 `sha256(credential)`；
 *  - `deviceId`（安装 ID）仍记录用于展示与审计，但**是否拒绝新设备由配置模式决定**
 *    （`off`/`warn`/`strict`），默认 `warn`：记录 + 审计，不阻断登录。
 */
export async function upsertDevice(
  db: Db,
  userId: string,
  deviceId: string,
  options: DeviceUpsertOptions = {},
): Promise<{ device: UserDeviceRow; isNew: boolean }> {
  return db.tx(async (tx) => {
    const existing = await tx.one<UserDeviceRow>(
      `SELECT * FROM user_devices WHERE user_id = $1 AND device_id = $2`,
      [userId, deviceId],
    );
    const credentialHash = options.credential ? createHash('sha256').update(options.credential).digest('hex') : null;
    const row = await tx.one<UserDeviceRow>(
      `INSERT INTO user_devices (user_id, device_id, device_label, user_agent, ip, credential_hash, device_kind, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (user_id, device_id)
       DO UPDATE SET device_label = COALESCE(EXCLUDED.device_label, user_devices.device_label),
                     user_agent = EXCLUDED.user_agent,
                     ip = EXCLUDED.ip,
                     credential_hash = COALESCE(EXCLUDED.credential_hash, user_devices.credential_hash),
                     device_kind = EXCLUDED.device_kind,
                     last_seen_at = now(),
                     revoked_at = NULL
       RETURNING *`,
      [
        userId,
        deviceId,
        options.label ?? null,
        options.userAgent ?? null,
        options.ip ?? null,
        credentialHash,
        options.kind ?? 'install',
      ],
    );
    if (!row) throw new Error(`设备登记失败：user_devices 未返回记录（user=${userId} device=${deviceId}）`);

    // 兼容字段：首次登记的设备写入 users.bound_device_id（仅展示用，不再作为硬门禁）
    if (!existing) {
      await tx.execute(
        `UPDATE users SET bound_device_id = COALESCE(bound_device_id, $2), device_bound_at = COALESCE(device_bound_at, now()), updated_at = now()
         WHERE id = $1`,
        [userId, deviceId],
      );
    }
    return { device: row, isNew: !existing };
  });
}

/** 兼容旧调用：登记并返回设备行 */
export async function bindDevice(
  db: Db,
  userId: string,
  deviceId: string,
  options: DeviceUpsertOptions = {},
): Promise<UserDeviceRow> {
  const { device } = await upsertDevice(db, userId, deviceId, options);
  return device;
}

/** 更新设备最近活跃（登录成功后调用，失败静默） */
export async function touchDevice(db: Db, userId: string, deviceId: string, ip?: string | null): Promise<void> {
  try {
    await db.execute(
      `UPDATE user_devices SET last_seen_at = now(), ip = COALESCE($3, ip)
       WHERE user_id = $1 AND device_id = $2`,
      [userId, deviceId, ip ?? null],
    );
  } catch {
    /* 非关键路径 */
  }
}

/** 该设备是否处于"已登记且未吊销"状态 */
export async function isDeviceTrusted(db: Db, userId: string, deviceId: string): Promise<boolean> {
  const row = await db.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM user_devices
     WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
    [userId, deviceId],
  );
  return (row?.n ?? 0) > 0;
}

/** 检查设备绑定（兼容旧接口：基于 users.bound_device_id） */
export async function checkDeviceBinding(db: Db, userId: string, deviceId: string): Promise<{ bound: boolean; isBoundDevice: boolean }> {
  const user = await db.one<UserRow>(`SELECT bound_device_id FROM users WHERE id = $1`, [userId]);
  if (!user) return { bound: false, isBoundDevice: false };
  if (!user.bound_device_id) return { bound: false, isBoundDevice: false };
  return { bound: true, isBoundDevice: user.bound_device_id === deviceId };
}

/** 获取用户绑定的设备 ID */
export async function getBoundDeviceId(db: Db, userId: string): Promise<string | null> {
  const user = await db.one<UserRow>(`SELECT bound_device_id FROM users WHERE id = $1`, [userId]);
  return user?.bound_device_id ?? null;
}

/** 列出用户的有效设备（按最近活跃排序） */
export async function listUserDevices(db: Db, userId: string): Promise<UserDeviceRow[]> {
  return db.query<UserDeviceRow>(
    `SELECT * FROM user_devices WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY COALESCE(last_seen_at, bound_at) DESC`,
    [userId],
  );
}

/** 列出全部设备（含已吊销，用于审计视图） */
export async function listAllUserDevices(db: Db, userId: string): Promise<UserDeviceRow[]> {
  return db.query<UserDeviceRow>(
    `SELECT * FROM user_devices WHERE user_id = $1 ORDER BY bound_at DESC`,
    [userId],
  );
}

/** 解绑/吊销设备（自助入口：DELETE /v1/me/devices/:deviceId）。返回是否命中 */
export async function revokeDevice(db: Db, userId: string, deviceId: string): Promise<boolean> {
  const affected = await db.execute(
    `UPDATE user_devices SET revoked_at = now(), is_primary = false
     WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
    [userId, deviceId],
  );
  // 若吊销的是兼容字段里的绑定设备，清空该字段（避免展示与状态不一致）
  await db.execute(
    `UPDATE users SET bound_device_id = NULL, device_bound_at = NULL WHERE id = $1 AND bound_device_id = $2`,
    [userId, deviceId],
  );
  return affected > 0;
}
