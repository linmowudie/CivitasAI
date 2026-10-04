/**
 * @module routes/auth
 * @description 账户路由：注册 / 登录 / 刷新 / 登出 / 改密。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loginSchema, logoutSchema, refreshSchema, registerSchema, changePasswordSchema, sendCodeSchema, loginWithCodeSchema } from '../http/schemas.js';
import { parseOrThrow } from '../http/validate.js';
import { ok, fail } from '../http/respond.js';
import { AppError } from '../http/errors.js';
import { createAuthGuard, requireAuth } from '../http/authGuard.js';
import type { AppContext } from '../app.js';

/** 采集设备信息（用于"登录设备"列表与审计） */
function deviceOf(
  request: FastifyRequest,
  label?: string | null,
  deviceId?: string | null,
  deviceCredential?: string | null,
) {
  return {
    label: label ?? null,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
    ip: request.ip,
    deviceId: deviceId ?? null,
    deviceCredential: deviceCredential ?? null,
  };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { auth } = ctx.services;

  app.post('/v1/auth/register', async (request, reply) => {
    const body = parseOrThrow(registerSchema, request.body, { scope: 'body' });
    const result = await auth.register({
      email: body.email,
      password: body.password,
      displayName: body.displayName ?? null,
      ...deviceOf(request, body.deviceLabel),
    });
    return ok(reply, result, 201);
  });

  app.post('/v1/auth/login', async (request, reply) => {
    const body = parseOrThrow(loginSchema, request.body, { scope: 'body' });
    const result = await auth.login({
      email: body.email,
      password: body.password,
      ...deviceOf(request, body.deviceLabel),
    });
    return ok(reply, result);
  });

  app.post('/v1/auth/refresh', async (request, reply) => {
    const body = parseOrThrow(refreshSchema, request.body, { scope: 'body' });
    const result = await auth.refresh({
      refreshToken: body.refreshToken,
      ...deviceOf(request, body.deviceLabel),
    });
    return ok(reply, result);
  });

  // 登出需要有效访问令牌（避免用他人令牌登出），但也允许仅凭 refreshToken 的客户端
  const guard = createAuthGuard(ctx.cfg, ctx.db);
  app.post('/v1/auth/logout', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(logoutSchema, request.body ?? {}, { scope: 'body' });
    const result = await auth.logout({
      userId,
      refreshToken: body.refreshToken,
      allDevices: body.allDevices,
      ...deviceOf(request),
    });
    return ok(reply, result);
  });

  app.post('/v1/auth/change-password', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parseOrThrow(changePasswordSchema, request.body, { scope: 'body' });
    const result = await auth.changePassword({
      userId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      ...deviceOf(request, body.deviceLabel),
    });
    return ok(reply, result);
  });

  // ── 验证码认证 ────────────────────────────────────────────────────────

  /** 发送验证码（开发环境打印到控制台，不真实发送邮件） */
  app.post('/v1/auth/send-code', async (request, reply) => {
    const body = parseOrThrow(sendCodeSchema, request.body, { scope: 'body' });
    const result = await auth.sendVerificationCode({
      email: body.email,
      purpose: body.purpose,
    });
    return ok(reply, result);
  });

  /** 使用验证码登录（自动注册新用户） */
  app.post('/v1/auth/login-with-code', async (request, reply) => {
    const body = parseOrThrow(loginWithCodeSchema, request.body, { scope: 'body' });
    const result = await auth.loginWithCode({
      email: body.email,
      code: body.code,
      displayName: body.displayName ?? null,
      ...deviceOf(request, body.deviceLabel, body.deviceId, body.deviceCredential ?? null),
    });
    return ok(reply, result);
  });

  // ── 设备管理（自助）────────────────────────────────────────────────────
  // 严格设备模式下的官方恢复路径：在任一已登录设备上移除旧设备

  /** 当前账号的登录设备列表 */
  app.get('/v1/me/devices', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    return ok(reply, { devices: await auth.listDevices(userId) });
  });

  /** 移除设备（解绑） */
  app.delete('/v1/me/devices/:deviceId', { preHandler: guard }, async (request, reply) => {
    const { userId } = requireAuth(request);
    const deviceId = (request.params as { deviceId?: string }).deviceId ?? '';
    if (!deviceId) return fail(reply, new AppError('VALIDATION_ERROR', 'deviceId is required'));
    return ok(reply, await auth.revokeDevice(userId, deviceId));
  });
}
