/**
 * @module Decision/RouteDecision/routeDecision
 * @description
 * 路由决策器——Docs/03 §3.3。
 * 按优先级顺序匹配路由规则，首个命中即返回。
 *
 * 决策优先级（Docs/03 §3.3 表格）：
 * 1. Token 超多 或 域多 → CONSORTIUM
 * 2. 匹配 SOP → ASSEMBLY_LINE
 * 3. 耦合度低 + 子任务够多 → DELEGATION
 * 4. Token 少 → DIRECT
 * 5. 兜底 → DELEGATION
 */

import type { ComplexityReport, RouteDecisionResult, RoutingMode } from '../types.js';
import { getRoutingRules } from './routingRules.js';
import type { Result } from '../../../Infra/types.js';
import { ok, err } from '../../../Infra/types.js';

// ── 决策入口 ────────────────────────────────────────────────────────

/**
 * 根据复杂度报告决定路由模式。
 * 严格按 Docs/03 §3.3 优先级顺序判定。
 */
export function decideRoute(report: ComplexityReport): Result<RouteDecisionResult> {
  const rules = getRoutingRules();
  const decidedAt = Date.now();

  // 优先级 1: CONSORTIUM（高难攻坚）
  if (
    report.estimatedTokens > rules.consortiumTokenThreshold ||
    report.requiredDomains.length >= rules.consortiumDomainThreshold
  ) {
    return ok({
      mode: 'CONSORTIUM',
      params: {
        reason: report.estimatedTokens > rules.consortiumTokenThreshold
          ? `estimatedTokens(${report.estimatedTokens}) > threshold(${rules.consortiumTokenThreshold})`
          : `domains(${report.requiredDomains.length}) >= threshold(${rules.consortiumDomainThreshold})`,
        domains: report.requiredDomains,
      },
      decidedAt,
      reason: '高 Token 消耗或多专业域，需要 Consortium 模式攻坚',
    });
  }

  // 优先级 2: ASSEMBLY_LINE（流水线，需匹配 SOP）
  if (report.hasSopMatch && rules.assemblyLineSopRequired) {
    return ok({
      mode: 'ASSEMBLY_LINE',
      params: { sopId: report.matchedSopId },
      decidedAt,
      reason: `匹配 SOP 模板 ${report.matchedSopId}，使用流水线模式`,
    });
  }

  // 优先级 3: DELEGATION（并行委派）
  if (
    report.couplingScore < rules.delegationMaxCouplingScore &&
    report.subtaskCount >= rules.delegationMinSubtaskCount
  ) {
    return ok({
      mode: 'DELEGATION',
      params: {
        couplingScore: report.couplingScore,
        subtaskCount: report.subtaskCount,
      },
      decidedAt,
      reason: `低耦合(${report.couplingScore.toFixed(2)}) + 多子任务(${report.subtaskCount})，适合并行委派`,
    });
  }

  // 优先级 4: DIRECT（直接执行）
  if (report.estimatedTokens <= rules.directExecMaxTokens) {
    return ok({
      mode: 'DIRECT',
      params: { estimatedTokens: report.estimatedTokens },
      decidedAt,
      reason: `简单任务(${report.estimatedTokens} tokens)，Director 直接执行`,
    });
  }

  // 优先级 5: 兜底 → DELEGATION
  return ok({
    mode: 'DELEGATION',
    params: { fallback: true },
    decidedAt,
    reason: '无规则明确命中，降级为 Delegation 模式',
  });
}

// ── 辅助：强制指定路由（测试/调试用）────────────────────────────────

export function forceRoute(mode: RoutingMode): RouteDecisionResult {
  return {
    mode,
    params: { forced: true },
    decidedAt: Date.now(),
    reason: `强制路由: ${mode}`,
  };
}
