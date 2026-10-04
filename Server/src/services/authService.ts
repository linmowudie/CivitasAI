/**
 * @module services/authService
 * @description 账户体系：注册 / 登录 / 刷新（轮换 + 重用检测）/ 登出 / 改密 / 资料 / 设备会话。
 *
 * 安全要点：
 *  - 登录失败一律返回同一错误（不区分"邮箱不存在"与"密码错误"），并对不存在的用户做等价耗时校验
 *  - 刷新令牌轮换：每次刷新签发新令牌并吊销旧的；旧令牌被再次使用 → 判定盗用 → 吊销整族
 *  - 改密后吊销该用户全部会话，并为当前设备换发新令牌
 */

import type { ServerConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { AppError, conflict, forbidden, invalidCredentials, notFound, rateLimited, unauthenticated } from '../http/errors.js';
import { fakeVerify, hashPassword, verifyPassword } from '../security/password.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  newFamilyId,
  signAccessToken,
} from '../security/tokens.js';
import * as users from '../repositories/users.js';
import * as tokens from '../repositories/refreshTokens.js';
import * as verificationCodes from '../repositories/verificationCodes.js';
import { recordAudit } from '../repositories/audit.js';
import { createMailTransport, isMailConfigured, type MailTransport } from './mailTransport.js';
import { logger } from '../logger.js';

export interface DeviceInfo {
  label?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  /** 安装 ID（客户端安装期生成并持久化；仅用于展示与审计） */
  deviceId?: string | null;
  /** 设备凭据（安装期随机串；服务端只存 sha256，作为设备身份依据） */
  deviceCredential?: string | null;
}

export interface TokenBundle {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  /** 访问令牌有效期（秒） */
  expiresIn: number;
  /** 访问令牌到期时间（epoch ms） */
  accessExpiresAt: number;
  /** 刷新令牌到期时间（ISO） */
  refreshExpiresAt: string;
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string | null;
  status: 'active' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
  /** 绑定的设备 ID（null 表示未绑定） */
  boundDeviceId: string | null;
}

export interface SessionDto {
  sessionId: string;
  deviceLabel: string | null;
  userAgent: string | null;
  ip: string | null;
  issuedAt: string;
  expiresAt: string;
}

export function toUserDto(row: users.UserRow): UserDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    boundDeviceId: row.bound_device_id ?? null,
  };
}

export function toSessionDto(row: tokens.RefreshTokenRow): SessionDto {
  return {
    sessionId: row.id,
    deviceLabel: row.device_label,
    userAgent: row.user_agent,
    ip: row.ip,
    issuedAt: new Date(row.issued_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export interface AuthService {
  register(input: { email: string; password: string; displayName?: string | null } & DeviceInfo): Promise<{
    user: UserDto;
    tokens: TokenBundle;
  }>;
  login(input: { email: string; password: string } & DeviceInfo): Promise<{ user: UserDto; tokens: TokenBundle }>;
  refresh(input: { refreshToken: string } & DeviceInfo): Promise<{ user: UserDto; tokens: TokenBundle }>;
  logout(input: { userId: string; refreshToken?: string | undefined; allDevices?: boolean } & DeviceInfo): Promise<{ revoked: number }>;
  changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
  } & DeviceInfo): Promise<{ tokens: TokenBundle }>;
  getProfile(userId: string): Promise<UserDto>;
  updateProfile(userId: string, input: { displayName: string | null }): Promise<UserDto>;
  listSessions(userId: string): Promise<SessionDto[]>;
  revokeSession(userId: string, sessionId: string): Promise<void>;
  /** 登录设备列表（自助设备管理，配合严格设备模式使用） */
  listDevices(userId: string): Promise<DeviceDto[]>;
  /** 移除设备（解绑）：换机/重装的官方恢复路径 */
  revokeDevice(userId: string, deviceId: string): Promise<{ revoked: boolean }>;

  // ── 验证码认证 ──────────────────────────────────────────────────────────

  /** 发送验证码到邮箱（未配置邮件通道时降级为控制台，仅开发） */
  sendVerificationCode(input: { email: string; purpose: 'register' | 'login' | 'reset_password' }): Promise<{
    success: boolean;
    /** 仅在显式开启 ALLOW_DEV_CODE 且非生产环境时返回 */
    devCode?: string;
    expiresIn: number;
    /** 投递通道：webhook | console */
    channel: string;
  }>;
  /** 使用验证码登录（自动注册新用户） */
  loginWithCode(input: { email: string; code: string; displayName?: string | null } & DeviceInfo): Promise<{
    user: UserDto;
    tokens: TokenBundle;
    /** 是否新注册用户 */
    isNewUser: boolean;
  }>;
}

/** 设备 DTO（自助设备管理用；不含凭据哈希） */
export interface DeviceDto {
  deviceId: string;
  label: string | null;
  kind: string;
  ip: string | null;
  userAgent: string | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  isPrimary: boolean;
}

export function createAuthService(deps: { db: Db; cfg: ServerConfig }): AuthService {
  const { db, cfg } = deps;
  const mail: MailTransport = createMailTransport(cfg.mail);

  /** 签发"访问 + 刷新"令牌对；familyId 传入时表示轮换同一会话家族 */
  async function issueTokens(
    userId: string,
    device: DeviceInfo,
    familyId: string = newFamilyId(),
  ): Promise<{ bundle: TokenBundle; sessionId: string; familyId: string }> {
    const generated = generateRefreshToken();
    const expiresAt = new Date(Date.now() + cfg.auth.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
    const session = await tokens.insertRefreshToken(db, {
      userId,
      tokenHash: generated.hash,
      familyId,
      expiresAt,
      deviceLabel: device.label ?? null,
      userAgent: device.userAgent ?? null,
      ip: device.ip ?? null,
    });
    const access = await signAccessToken(cfg.auth, { sub: userId, sid: session.id });
    return {
      sessionId: session.id,
      familyId,
      bundle: {
        tokenType: 'Bearer',
        accessToken: access.token,
        refreshToken: generated.raw,
        expiresIn: access.expiresIn,
        accessExpiresAt: access.expiresAt,
        refreshExpiresAt: expiresAt.toISOString(),
      },
    };
  }

  return {
    async register(input) {
      const passwordHash = await hashPassword(input.password);
      const created = await users.createUser(db, {
        email: input.email,
        emailLower: input.email.toLowerCase(),
        passwordHash,
        displayName: input.displayName ?? null,
      });
      await recordAudit(db, {
        userId: created.id,
        action: 'auth.register',
        outcome: 'success',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
      const { bundle } = await issueTokens(created.id, input);
      return { user: toUserDto(created), tokens: bundle };
    },

    async login(input) {
      const row = await users.findUserByEmail(db, input.email.toLowerCase());
      if (!row) {
        // 等价耗时：避免通过响应时间枚举已注册邮箱
        await fakeVerify();
        await recordAudit(db, {
          action: 'auth.login',
          outcome: 'failure',
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          detail: { reason: 'user_not_found' },
        });
        throw invalidCredentials();
      }
      const okPassword = await verifyPassword(row.password_hash, input.password);
      if (!okPassword) {
        await recordAudit(db, {
          userId: row.id,
          action: 'auth.login',
          outcome: 'failure',
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          detail: { reason: 'bad_password' },
        });
        throw invalidCredentials();
      }
      if (row.status !== 'active') {
        await recordAudit(db, {
          userId: row.id,
          action: 'auth.login',
          outcome: 'failure',
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          detail: { reason: 'disabled' },
        });
        throw forbidden('账号已停用，请联系管理员');
      }

      await users.touchLastLogin(db, row.id);
      await recordAudit(db, {
        userId: row.id,
        action: 'auth.login',
        outcome: 'success',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
      const { bundle } = await issueTokens(row.id, input);
      const fresh = (await users.findUserById(db, row.id)) ?? row;
      return { user: toUserDto(fresh), tokens: bundle };
    },

    async refresh(input) {
      const hash = hashRefreshToken(input.refreshToken);
      const session = await tokens.findByHash(db, hash);
      if (!session) {
        await recordAudit(db, {
          action: 'auth.refresh',
          outcome: 'failure',
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          detail: { reason: 'unknown_token' },
        });
        throw unauthenticated('刷新令牌无效');
      }

      // 已吊销的令牌被再次使用 → 视为泄漏：吊销整族
      if (session.revoked_at) {
        const revoked = await tokens.revokeFamily(db, session.family_id, 'token_reuse_detected');
        await recordAudit(db, {
          userId: session.user_id,
          action: 'auth.refresh',
          outcome: 'failure',
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          detail: { reason: 'token_reuse', familyId: session.family_id, revokedSessions: revoked },
        });
        throw new AppError('TOKEN_REUSED', '检测到刷新令牌被重复使用，该会话已全部失效，请重新登录');
      }

      if (new Date(session.expires_at).getTime() <= Date.now()) {
        await tokens.revokeById(db, session.id, 'expired');
        throw new AppError('TOKEN_EXPIRED', '登录已过期，请重新登录');
      }

      const user = await users.findUserById(db, session.user_id);
      if (!user || user.status !== 'active') {
        await tokens.revokeAllForUser(db, session.user_id, 'user_inactive');
        throw unauthenticated('账号不可用，请重新登录');
      }

      // 轮换：同族签发新令牌，旧令牌立即失效（除非显式允许重用）
      const { bundle, sessionId } = await issueTokens(user.id, input, session.family_id);
      if (!cfg.auth.allowRefreshReuse) {
        await tokens.revokeById(db, session.id, 'rotated');
        await tokens.markRotated(db, session.id, sessionId);
      }
      return { user: toUserDto(user), tokens: bundle };
    },

    async logout(input) {
      let revoked = 0;
      if (input.allDevices) {
        revoked = await tokens.revokeAllForUser(db, input.userId, 'logout_all');
      } else if (input.refreshToken) {
        const session = await tokens.findByHash(db, hashRefreshToken(input.refreshToken));
        if (session && session.user_id === input.userId) {
          await tokens.revokeById(db, session.id, 'logout');
          revoked = 1;
        }
      } else {
        throw unauthenticated('缺少 refreshToken（或使用 allDevices=true 登出全部设备）');
      }
      await recordAudit(db, {
        userId: input.userId,
        action: input.allDevices ? 'auth.logout_all' : 'auth.logout',
        outcome: 'success',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        detail: { revoked },
      });
      return { revoked };
    },

    async changePassword(input) {
      const user = await users.findUserById(db, input.userId);
      if (!user) throw notFound('用户不存在');

      const ok = await verifyPassword(user.password_hash, input.currentPassword);
      if (!ok) {
        await recordAudit(db, {
          userId: user.id,
          action: 'auth.change_password',
          outcome: 'failure',
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          detail: { reason: 'bad_current_password' },
        });
        throw invalidCredentials();
      }
      if (input.currentPassword === input.newPassword) {
        throw conflict('新密码不能与当前密码相同');
      }

      const passwordHash = await hashPassword(input.newPassword);
      await db.tx(async (tx) => {
        await users.updatePasswordHash(tx, user.id, passwordHash);
        await tokens.revokeAllForUser(tx, user.id, 'password_changed');
      });
      await recordAudit(db, {
        userId: user.id,
        action: 'auth.change_password',
        outcome: 'success',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
      // 当前设备换发新令牌，其他设备需重新登录
      const { bundle } = await issueTokens(user.id, input);
      return { tokens: bundle };
    },

    async getProfile(userId) {
      const user = await users.findUserById(db, userId);
      if (!user) throw notFound('用户不存在');
      return toUserDto(user);
    },

    async updateProfile(userId, input) {
      const updated = await users.updateDisplayName(db, userId, input.displayName);
      if (!updated) throw notFound('用户不存在');
      return toUserDto(updated);
    },

    async listSessions(userId) {
      return (await tokens.listActiveSessions(db, userId)).map(toSessionDto);
    },

    async revokeSession(userId, sessionId) {
      const session = await tokens.findById(db, sessionId);
      if (!session) throw notFound('会话不存在');
      if (session.user_id !== userId) throw forbidden('无权操作该会话');
      await tokens.revokeById(db, sessionId, 'revoked_by_user');
      await recordAudit(db, {
        userId,
        action: 'auth.revoke_session',
        outcome: 'success',
        detail: { sessionId },
      });
    },

    async listDevices(userId) {
      const rows = await users.listUserDevices(db, userId);
      return rows.map((row) => ({
        deviceId: row.device_id,
        label: row.device_label,
        kind: row.device_kind,
        ip: row.ip,
        userAgent: row.user_agent,
        firstSeenAt: new Date(row.bound_at).toISOString(),
        lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
        isPrimary: row.is_primary,
      }));
    },

    /**
     * 移除设备（解绑）。
     *
     * 这是"换机/重装后被设备策略挡住"的**官方恢复路径**：
     * 用户在任一已登录设备上移除旧设备，即可在新设备上完成登录（严格模式）。
     */
    async revokeDevice(userId, deviceId) {
      const revoked = await users.revokeDevice(db, userId, deviceId);
      await recordAudit(db, {
        userId,
        action: 'auth.revoke_device',
        outcome: revoked ? 'success' : 'failure',
        detail: { deviceId, revoked },
      });
      if (!revoked) throw notFound('设备不存在或已移除');
      return { revoked: true };
    },

    // ── 验证码认证 ──────────────────────────────────────────────────────────

    async sendVerificationCode(input) {
      const { email, purpose } = input;
      const emailLower = email.toLowerCase();

      // ① 发送配额（按邮箱，防刷码/信箱轰炸）
      const recent = await verificationCodes.countRecentCodes(db, emailLower, purpose, cfg.auth.codeWindowSec);
      if (recent >= cfg.auth.codeMaxPerWindow) {
        await recordAudit(db, {
          action: 'auth.send_code',
          outcome: 'failure',
          detail: { reason: 'quota_exceeded', email: emailLower, purpose },
        });
        throw rateLimited(cfg.auth.codeWindowSec);
      }

      // ② 冷却（两次发送最小间隔）
      const last = await verificationCodes.lastIssuedAt(db, emailLower, purpose);
      if (last) {
        const elapsedSec = (Date.now() - last.getTime()) / 1000;
        if (elapsedSec < cfg.auth.codeResendCooldownSec) {
          throw rateLimited(Math.ceil(cfg.auth.codeResendCooldownSec - elapsedSec));
        }
      }

      // ③ 生成（CSPRNG）并**只存哈希**；签发新码会作废该邮箱同用途的旧码
      const code = verificationCodes.generateCode();
      const ttlMs = cfg.auth.codeTtlSec * 1000;
      await verificationCodes.createVerificationCode(db, { email: emailLower, code, purpose, ttlMs });

      // ④ 投递：webhook（生产）或控制台（开发）
      const minutes = Math.round(cfg.auth.codeTtlSec / 60);
      await mail.send({
        to: email,
        subject: 'Civitas-AI 登录验证码',
        text: `你的登录验证码是 ${code}，${minutes} 分钟内有效。若非本人操作请忽略本邮件。`,
      });
      if (mail.name === 'console') {
        logger.warn('验证码未通过邮件送达（控制台通道，仅开发）', {
          source: 'authService', email: emailLower, purpose, code, mailConfigured: isMailConfigured(cfg.mail),
        });
      }

      await recordAudit(db, {
        action: 'auth.send_code',
        outcome: 'success',
        detail: { email: emailLower, purpose, channel: mail.name },
      });

      return {
        success: true,
        // 仅当显式开启且非生产环境才回传（生产由 config 拒绝启动）
        devCode: cfg.auth.allowDevCode ? code : undefined,
        expiresIn: cfg.auth.codeTtlSec,
        channel: mail.name,
      };
    },

    async loginWithCode(input) {
      const { email, code, displayName } = input;
      const emailLower = email.toLowerCase();

      // ① 查找有效验证码（未过期 + 未使用 + 未超失败次数）
      const validCode = await verificationCodes.findValidCode(db, emailLower, 'login', cfg.auth.codeMaxAttempts);
      if (!validCode) {
        await fakeVerify(); // 等价耗时，避免通过响应时间判断"是否存在待用验证码"
        await recordAudit(db, {
          action: 'auth.login_with_code',
          outcome: 'failure',
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          detail: { reason: 'code_not_found_or_locked', email: emailLower },
        });
        throw invalidCredentials('验证码无效或已过期，请重新获取');
      }

      // ② 哈希 + 常量时间比较（明文不落库，SV-012）
      if (!verificationCodes.verifyCodeHash(validCode.code_hash, code)) {
        const { attempts, invalidated } = await verificationCodes.registerFailedAttempt(
          db, validCode.id, cfg.auth.codeMaxAttempts,
        );
        await recordAudit(db, {
          action: 'auth.login_with_code',
          outcome: 'failure',
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          detail: { reason: 'code_mismatch', email: emailLower, attempts, invalidated },
        });
        throw invalidCredentials(
          invalidated
            ? `验证码错误次数过多（${attempts} 次），该验证码已作废，请重新获取`
            : '验证码错误',
        );
      }

      // ③ 标记验证码已使用（一次性）
      await verificationCodes.markCodeUsed(db, validCode.id);

      // ④ 查找或创建用户
      let user = await users.findUserByEmail(db, emailLower);
      let isNewUser = false;

      if (!user) {
        // 自动注册（随机密码哈希：该账号仅走验证码登录；后续可通过改密设置密码）
        const randomPasswordHash = await hashPassword(generateRefreshToken().raw);
        user = await users.createUser(db, {
          email: email,
          emailLower,
          passwordHash: randomPasswordHash,
          displayName: displayName ?? null,
        });
        isNewUser = true;

        await recordAudit(db, {
          userId: user.id,
          action: 'auth.register_with_code',
          outcome: 'success',
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        });
      }

      // ⑤ 设备处理（安全审计修复：默认不再硬拒绝新设备）
      let deviceRecorded = false;
      let isNewDevice = false;
      const mode = cfg.auth.deviceBindingMode;
      if (mode !== 'off' && input.deviceId) {
        const trusted = await users.isDeviceTrusted(db, user.id, input.deviceId);
        // 严格模式：拒绝**未登记**设备；但首个设备必须放行——
        // 验证码已证明邮箱控制权，否则新账号在严格模式下永远无法完成首次登录。
        const registered = mode === 'strict' && !trusted
          ? await users.listUserDevices(db, user.id)
          : [];
        if (mode === 'strict' && !trusted && registered.length > 0) {
          await recordAudit(db, {
            userId: user.id,
            action: 'auth.login_with_code',
            outcome: 'failure',
            ip: input.ip ?? null,
            userAgent: input.userAgent ?? null,
            detail: { reason: 'device_not_registered', requestedDevice: input.deviceId, mode },
          });
          throw forbidden('该账号处于严格设备模式：请先在已登录设备的「账号 → 登录设备」中移除旧设备，再于本机重试');
        }
        const result = await users.upsertDevice(db, user.id, input.deviceId, {
          label: input.label ?? undefined,
          userAgent: input.userAgent ?? undefined,
          ip: input.ip ?? undefined,
          credential: input.deviceCredential ?? undefined,
          kind: input.deviceCredential ? 'install' : 'legacy',
        });
        deviceRecorded = true;
        isNewDevice = result.isNew;
        if (isNewDevice) {
          await recordAudit(db, {
            userId: user.id,
            action: 'auth.new_device',
            outcome: 'success',
            ip: input.ip ?? null,
            userAgent: input.userAgent ?? null,
            detail: { deviceId: input.deviceId, mode },
          });
        } else {
          await users.touchDevice(db, user.id, input.deviceId, input.ip ?? null);
        }
      }

      // ⑥ 账号状态
      if (user.status !== 'active') {
        throw forbidden('账号已停用，请联系管理员');
      }

      // ⑦ 更新最后登录时间
      await users.touchLastLogin(db, user.id);

      await recordAudit(db, {
        userId: user.id,
        action: 'auth.login_with_code',
        outcome: 'success',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        detail: { isNewUser, deviceRecorded, isNewDevice, deviceMode: mode },
      });
      
      // 签发令牌
      const { bundle } = await issueTokens(user.id, input);
      const fresh = (await users.findUserById(db, user.id)) ?? user;
      
      return {
        user: toUserDto(fresh),
        tokens: bundle,
        isNewUser,
      };
    },
  };
}
