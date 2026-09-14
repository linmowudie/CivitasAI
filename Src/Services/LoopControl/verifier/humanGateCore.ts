/**
 * @module LoopControl/verifier/humanGateCore
 * @description
 * L4 人类审批门——Docs/12 §3.1 / §6。
 * 不可逆 / 高风险 / 大额操作必须经过人类审批。
 * 本阶段仅落 DB 队列，S12 才接 UI。
 */

import type { VerifierSpec, VerifierResult } from '../loopState.js';
import type { Result } from '../../../Infra/types.js';
import { ok } from '../../../Infra/types.js';

export interface HumanGateContext {
  /** 当前 Loop ID */
  loopId: string;
  /** 当前迭代 */
  iteration: number;
  /** 审批请求创建时间 */
  requestedAt: number;
}

/**
 * L4 人类审批门——创建审批请求（不阻塞，返回 pending 状态）
 *
 * Phase 0：仅创建审批记录到 DB 队列，不实际等待人类响应。
 * S12 阶段将接入 UI 实现真正的等待-审批流程。
 */
export async function runHumanGate(
  specs: VerifierSpec[],
  ctx: HumanGateContext,
): Promise<Result<VerifierResult[]>> {
  const results: VerifierResult[] = [];
  const l4Specs = specs.filter(s => s.level === 'L4');

  for (const spec of l4Specs) {
    const start = Date.now();
    // Phase 0: L4 始终返回 pending（不自动通过）
    results.push({
      pass: false,
      level: 'L4',
      kind: 'human_gate',
      evidence: [{
        kind: 'rule_violation',
        data: {
          reason: spec.payload.reason,
          reviewerRoles: spec.payload.reviewerRoles,
          timeoutSec: spec.payload.timeoutSec,
          status: 'PENDING_APPROVAL',
          loopId: ctx.loopId,
          iteration: ctx.iteration,
        },
      }],
      defectCategory: undefined,
      costTokens: 0,
      durationMs: Date.now() - start,
    });
  }

  return ok(results);
}
