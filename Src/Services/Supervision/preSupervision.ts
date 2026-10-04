/**
 * @module Supervision/preSupervision
 * @description
 * 前置监管——Docs/Agent/02 §3 步骤②。
 * 安全注入检测、权限验证、频率限制。
 *
 * 频率限制参数读取 `Configs/supervision.json → supervision.rateLimit`（FE-040：与 HTTP API
 * 限流的 supervision.apiRateLimit 解耦），启动时经 `initPreSupervisionRateLimit()` 注入。
 */

import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';
import type { RateLimitConfig } from '../../Infra/Contracts/rateLimitTypes.js';
import { DEFAULT_RATE_LIMIT_CONFIG } from '../../Infra/Contracts/rateLimitTypes.js';
import { getAgent } from '../../Core/AgentRuntime/agentRegistry.js';
import { isFrozen } from '../Audit/freezeManager.js';

// ── 限流配置注入（FE-040：与 HTTP API 限流解耦，由 main 启动时注入）────

let currentRateLimitConfig: RateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG };

/** 初始化/更新监管限流配置（supervision.rateLimit 段） */
export function initPreSupervisionRateLimit(config: Partial<RateLimitConfig> = {}): void {
  currentRateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
}

/** 前置监管输入 */
export interface PreSupervisionInput {
  userInput: string;
  agentId: string;
  sessionId: string;
  /** 最近 N 次调用的时间戳（用于频率限制） */
  recentCallTimestamps: number[];
}

/** 前置监管结果 */
export interface PreSupervisionResult {
  passed: boolean;
  /** 注入检测命中 */
  injectionDetected: boolean;
  /** 权限是否通过 */
  permissionOk: boolean;
  /** 频率是否被限制 */
  rateLimited: boolean;
  /** 拒绝原因 */
  rejectReason?: string;
}

/** 将统一限流配置转换为前置监管所需的窗口参数 */
function toWindowParams(config: RateLimitConfig): { maxCallsPerWindow: number; windowMs: number } {
  return {
    maxCallsPerWindow: config.maxRequestsPerMinute,
    windowMs: 60_000,
  };
}

/** 注入检测模式（简化版本） */
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
  rateLimitConfig: RateLimitConfig = currentRateLimitConfig,
): Result<PreSupervisionResult> {
  // 安全注入检测
  const injectionDetected = INJECTION_PATTERNS.some(p => p.test(input.userInput));
  if (injectionDetected) {
    return ok({
      passed: false, injectionDetected: true, permissionOk: true, rateLimited: false,
      rejectReason: 'PROMPT_INJECTION_DETECTED',
    });
  }

  // 频率限制——使用统一配置转换窗口参数
  const windowParams = toWindowParams(rateLimitConfig);
  const now = Date.now();
  const windowStart = now - windowParams.windowMs;
  const recentCalls = input.recentCallTimestamps.filter(t => t >= windowStart);
  const rateLimited = recentCalls.length >= windowParams.maxCallsPerWindow;
  if (rateLimited) {
    return ok({
      passed: false, injectionDetected: false, permissionOk: true, rateLimited: true,
      rejectReason: 'RATE_LIMIT_EXCEEDED',
    });
  }

  // 权限验证（FE-068 实装：Agent 身份有效性——已驱逐/销毁/挂起一律拒绝；
  //   未注册的调用方（轻量/无注册表场景）保持放行，不引入额外门槛）
  const agent = getAgent(input.agentId);
  if (agent && (agent.status === 'expelled' || agent.status === 'destroyed' || agent.status === 'suspended')) {
    return ok({
      passed: false, injectionDetected: false, permissionOk: false, rateLimited: false,
      rejectReason: `AGENT_NOT_PERMITTED: ${input.agentId} 当前状态 ${agent.status}（不可继续执行）`,
    });
  }

  // 审计冻结检查（FE-061 联动：冻结 = 审计执法限制——冻结期 Agent 不可继续执行；
  //   到期自动解冻或经治理端点解冻后恢复）
  if (isFrozen(input.agentId)) {
    return ok({
      passed: false, injectionDetected: false, permissionOk: false, rateLimited: false,
      rejectReason: `AGENT_FROZEN: ${input.agentId} 处于审计冻结期（到期自动解冻或经治理解冻）`,
    });
  }

  return ok({
    passed: true, injectionDetected: false, permissionOk: true, rateLimited: false,
  });
}
