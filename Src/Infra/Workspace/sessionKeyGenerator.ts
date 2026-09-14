/**
 * 会话密钥生成器（Docs/01 §5.2 / Docs/15 §6）
 *
 * 职责：
 * - 生成 session_key = SHA-256 前 16 位十六进制
 * - 碰撞时自动加后缀再试（Gate G1 要求）
 */

import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { Time } from '../Time/timeService.js';
import type { Result } from '../types.js';
import { ok, err } from '../types.js';

// ===== 类型定义 =====

/** 生成选项 */
export interface SessionKeyOptions {
  /** 十六进制长度，默认 16 */
  hexLength?: number;
  /** 碰撞检测回调：返回 true 表示已存在 */
  existsFn?: (key: string) => boolean;
  /** 最大重试次数，默认 10 */
  maxRetries?: number;
}

// ===== 内部函数 =====

/**
 * 计算 SHA-256 哈希的前 N 位十六进制
 */
function sha256Hex(input: string, length: number): string {
  const hash = createHash('sha256').update(input).digest('hex');
  return hash.slice(0, length);
}

// ===== 公开 API =====

/**
 * 生成新的 session_key
 *
 * 算法：SHA-256(timestamp + random_bytes) 前 hexLength 位
 * 碰撞时追加随机后缀再试
 */
export function generateSessionKey(options: SessionKeyOptions = {}): Result<string> {
  const hexLength = options.hexLength ?? 16;
  const maxRetries = options.maxRetries ?? 10;
  const existsFn = options.existsFn;

  if (hexLength < 8 || hexLength > 64) {
    return err(`hexLength 必须在 8-64 之间，收到: ${hexLength}`, 'ERROR');
  }

  // 无碰撞检测，直接生成
  if (!existsFn) {
    const input = `${Time.now()}:${randomBytes(16).toString('hex')}`;
    return ok(sha256Hex(input, hexLength));
  }

  // 有碰撞检测，重试直到成功或达到上限
  let attempt = 0;
  let suffix = '';

  while (attempt <= maxRetries) {
    const input = `${Time.now()}:${randomBytes(16).toString('hex')}${suffix}`;
    const key = sha256Hex(input, hexLength);

    if (!existsFn(key)) {
      return ok(key);
    }

    attempt++;
    suffix = `:retry:${attempt}:${randomBytes(8).toString('hex')}`;
  }

  return err(`生成 session_key 失败：${maxRetries} 次碰撞`, 'ERROR');
}

/**
 * 验证 session_key 格式是否合法
 */
export function isValidSessionKey(key: string, hexLength: number = 16): boolean {
  if (key.length !== hexLength) return false;
  return /^[0-9a-f]+$/i.test(key);
}
