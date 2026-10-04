/**
 * @module security/password
 * @description 密码哈希：Argon2id（OWASP 推荐参数：19 MiB / t=2 / p=1）。
 *
 * 使用 @node-rs/argon2 预编译二进制，无需 node-gyp（规避 Electron/better-sqlite3 那类编译坑）。
 */

import { hash, verify, Algorithm } from '@node-rs/argon2';

/** OWASP 2024 推荐的最小 Argon2id 配置 */
export const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/** 密码最小长度（与 http/validate 的 passwordSchema 保持一致） */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * 校验密码。
 *
 * - 哈希串损坏/算法不支持时返回 false（不抛错，避免把内部细节带出去）
 */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  if (!storedHash || !plain) return false;
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

/**
 * 恒定开销的假校验：用户不存在时也执行一次哈希运算，
 * 避免通过响应时间差枚举已注册邮箱。
 */
export async function fakeVerify(): Promise<void> {
  try {
    await verify(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000',
      'dummy-password',
    );
  } catch {
    // 结果无关紧要，只为消耗相近的时间
  }
}
