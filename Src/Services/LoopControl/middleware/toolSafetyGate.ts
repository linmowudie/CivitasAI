/**
 * @module LoopControl/middleware/toolSafetyGate
 * @description
 * 工具安全门中间件——审查报告 P0-3。
 *
 * wrapToolCall 钩子，按工具危险分级强制执行：
 * - DANGEROUS + IRREVERSIBLE → ApprovalGate 审批门
 * - CONTROLLED / DANGEROUS+REVERSIBLE → EffectJournal 副作用日志
 * - SAFE → 直接放行
 *
 * 所有非 SAFE 工具执行前检查幂等缓存（IdempotencyStore DUR-005）。
 */

import type { AgentMiddleware, MiddlewareContext, ToolCallInput, ToolCallOutput } from '../../../Core/Middleware/types.js';
import { getTool } from '../../../Tools/Registry/toolRegistry.js';
import { recordIntent, updateEffectStatus, hashPayload } from '../../../Infra/DurableExecution/effectJournal.js';
import { makeIdempotencyKey, lookup as lookupIdempotency, store as storeIdempotency } from '../../../Infra/DurableExecution/idempotencyStore.js';
import { createApproval, registerApproval } from '../approvalGate.js';
import { logger } from '../../../Infra/Logging/logger.js';

/** 工具安全门配置 */
export interface ToolSafetyGateConfig {
  /** 默认审批超时（秒） */
  approvalTimeoutSec: number;
  /** 审批人角色列表 */
  approverRoles: Array<{ role: 'user' | 'prime_director' | 'regulatory_authority' | 'auditor'; weight: number }>;
  /** 是否启用幂等缓存 */
  enableIdempotency: boolean;
}

const DEFAULT_CONFIG: ToolSafetyGateConfig = {
  approvalTimeoutSec: 60,
  approverRoles: [{ role: 'user', weight: 1 }],
  enableIdempotency: true,
};

/**
 * 创建工具安全门中间件
 *
 * 注册为 wrapToolCall 钩子，按工具危险分级执行不同管控策略。
 */
export function createToolSafetyGateMiddleware(
  getLoopId: () => string,
  getIteration: () => number,
  getTraceId: () => string,
  config: Partial<ToolSafetyGateConfig> = {},
): AgentMiddleware {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return {
    name: 'ToolSafetyGate',
    hook: 'wrapToolCall',
    priority: 1,  // 最高优先级，先于其他 wrap 中间件
    canShortCircuit: true,

    execute: async (
      ctx: MiddlewareContext,
      input: ToolCallInput,
      next: (input: ToolCallInput) => Promise<ToolCallOutput>,
    ): Promise<ToolCallOutput> => {
      const toolDef = getTool(input.toolName);

      // 工具未注册 → 直接透传（由 toolRegistry 返回 TOOL_NOT_FOUND）
      if (!toolDef) {
        return next(input);
      }

      const { dangerLevel, reversibility, idempotency } = toolDef.spec;
      const loopId = getLoopId();
      const iteration = getIteration();
      const traceId = getTraceId();

      // ── 幂等缓存检查（DUR-005）──
      if (cfg.enableIdempotency && idempotency !== 'NO') {
        const idemKey = makeIdempotencyKey(input.toolName, input.arguments, loopId);
        const lookup = lookupIdempotency(idemKey);
        if (lookup.ok && lookup.value.hit) {
          logger.info('幂等缓存命中，跳过重复执行', {
            source: 'ToolSafetyGate', tool: input.toolName, idemKey: idemKey.slice(0, 16),
          });
          return {
            status: 'success',
            content: JSON.stringify({ idempotent: true, cachedResult: lookup.value.result }),
            recoverable: false,
          };
        }
      }

      // ── DANGEROUS + IRREVERSIBLE → ApprovalGate ──
      if (dangerLevel === 'DANGEROUS' && reversibility === 'IRREVERSIBLE') {
        const approvalResult = createApproval({
          loopId,
          traceId,
          iteration,
          requestedBy: ctx.agentId,
          kind: 'irreversible_action',
          payload: { toolName: input.toolName, arguments: input.arguments },
          riskLevel: 'CRITICAL',
          timeoutSec: cfg.approvalTimeoutSec,
          defaultOnTimeout: 'reject',
          deciders: cfg.approverRoles,
        });

        if (approvalResult.ok) {
          registerApproval(approvalResult.value);
          logger.warn('危险工具审批请求已创建', {
            source: 'ToolSafetyGate',
            tool: input.toolName,
            approvalId: approvalResult.value.approvalId,
            riskLevel: 'CRITICAL',
          });
          // 当前阶段：审批请求已入队，等待 UI 侧处理
          // 若审批未立即通过，返回拒绝
          if (approvalResult.value.status !== 'APPROVED') {
            return {
              status: 'error',
              content: `工具 ${input.toolName} 需要人工审批（approvalId: ${approvalResult.value.approvalId}），等待审批后重试`,
              recoverable: true,
            };
          }
        } else {
          return {
            status: 'error',
            content: `审批创建失败: ${approvalResult.error}`,
            recoverable: false,
          };
        }
      }

      // ── EffectJournal 副作用日志（CONTROLLED 及以上）──
      if (dangerLevel !== 'SAFE') {
        const effectId = `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
        const idemKey = makeIdempotencyKey(input.toolName, input.arguments, loopId);
        const pHash = hashPayload(input.arguments);

        const intentResult = recordIntent({
          effectId,
          loopId,
          iteration,
          kind: 'tool_execute',
          idempotencyKey: idemKey,
          payloadHash: pHash,
        });

        if (!intentResult.ok) {
          logger.error('EffectJournal INTENT 写入失败', {
            source: 'ToolSafetyGate', tool: input.toolName, error: intentResult.error,
          });
          // 非阻断：记录日志但允许执行（fail-open for journal errors）
        } else {
          // 标记为 EXECUTING
          updateEffectStatus({ effectId, status: 'EXECUTING' });
        }

        // 执行工具
        const output = await next(input);

        // 更新最终状态
        const finalStatus = output.status === 'success' ? 'SUCCEEDED' : 'FAILED';
        updateEffectStatus({
          effectId,
          status: finalStatus as 'SUCCEEDED' | 'FAILED',
          result: output.content,
          errorClass: output.status === 'error'
            ? (output.recoverable ? 'retryable' : 'non_retryable')
            : undefined,
        });

        // 幂等缓存存储（成功时）
        if (output.status === 'success' && cfg.enableIdempotency && idempotency !== 'NO') {
          storeIdempotency(
            idemKey,
            loopId,
            typeof output.content === 'string' ? output.content : JSON.stringify(output.content),
          );
        }

        return output;
      }

      // ── SAFE → 直接放行 ──
      return next(input);
    },
  };
}
