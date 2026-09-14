/**
 * @module Supervision/preSupervision
 * @description
 * 前置监管——Docs/02 §3 步骤②�?
 * 安全注入检测、权限验证、频率限制�?
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

/** 前置监管输入 */
export interface PreSupervisionInput {
  userInput: string;
  agentId: string;
  sessionId: string;
  /** 最�?N 次调用的时间戳（用于频率限制�?*/
  recentCallTimestamps: number[];
}

/** 前置监管结果 */
export interface PreSupervisionResult {
  passed: boolean;
  /** 注入检测命�?*/
  injectionDetected: boolean;
  /** 权限是否通过 */
  permissionOk: boolean;
  /** 频率是否被限�?*/
  rateLimited: boolean;
  /** 拒绝原因 */
  rejectReason?: string;
}

/** 频率限制配置 */
export interface RateLimitConfig {
  /** 窗口内最大调用数，默�?30 */
  maxCallsPerWindow: number;
  /** 窗口大小（ms），默认 60s */
  windowMs: number;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = { maxCallsPerWindow: 30, windowMs: 60_000 };

/** 注入检测模式（简化版�?*/
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+a/i,
  /system\s*:\s*you\s+are/i,
  /<\|im_start\|>system/i,
  /override\s+safety/i,
];

/** 执行前置监管 */
export function runPreSupervision(
  input: PreSupervisionInput,
  rateLimitConfig: RateLimitConfig = DEFAULT_RATE_LIMIT,
): Result<PreSupervisionResult> {
  // �?安全注入检�?
  const injectionDetected = INJECTION_PATTERNS.some(p => p.test(input.userInput));
  if (injectionDetected) {
    return ok({
      passed: false, injectionDetected: true, permissionOk: true, rateLimited: false,
      rejectReason: 'PROMPT_INJECTION_DETECTED',
    });
  }

  // �?频率限制
  const now = Date.now();
  const windowStart = now - rateLimitConfig.windowMs;
  const recentCalls = input.recentCallTimestamps.filter(t => t >= windowStart);
  const rateLimited = recentCalls.length >= rateLimitConfig.maxCallsPerWindow;
  if (rateLimited) {
    return ok({
      passed: false, injectionDetected: false, permissionOk: true, rateLimited: true,
      rejectReason: 'RATE_LIMIT_EXCEEDED',
    });
  }

  // �?权限验证（桩：后续接�?RBAC�?
  return ok({
    passed: true, injectionDetected: false, permissionOk: true, rateLimited: false,
  });
}
