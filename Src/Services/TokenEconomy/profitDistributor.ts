/**
 * @module TokenEconomy/profitDistributor
 * @description
 * 收益分配器——Docs/04 §3.3。
 * Consortium 模式下按三维贡献度自动分润：
 * 质量分(0.5) + 数量分(0.3) + 效率分(0.2)。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import type { ProfitSharingConfig } from './types.js';
import { credit } from './walletManager.js';

// ── 贡献度输入 ──────────────────────────────────────────────────────

export interface PartnerContribution {
  agentId: string;
  qualityScore: number;     // 0.0–1.0 采纳率
  outputTokens: number;     // 有效输出 Token 数
  elapsedMs: number;        // 实际耗时
}

export interface DistributionResult {
  agentId: string;
  compositeScore: number;
  share: number;
}

// ── 默认配置 ────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS: ProfitSharingConfig = {
  qualityWeight: 0.5,
  quantityWeight: 0.3,
  efficiencyWeight: 0.2,
};

// ── 分润计算 ────────────────────────────────────────────────────────

/**
 * 计算各 Partner 的分润份额
 *
 * 三维贡献分：
 * - 质量分 = qualityScore（直接取值）
 * - 数量分 = outputTokens / totalOutputTokens
 * - 效率分 = (1/elapsedMs) / Σ(1/各PartnerElapsedMs)
 *
 * 综合分 = Wq×质量分 + Wn×数量分 + We×效率分
 * 分润 = tokenPool × (综合分 / Σ所有综合分)
 */
export function calculateDistribution(
  contributions: PartnerContribution[],
  tokenPool: number,
  weights: ProfitSharingConfig = DEFAULT_WEIGHTS,
): Result<DistributionResult[]> {
  if (contributions.length === 0) return err('贡献列表不能为空');
  if (tokenPool <= 0) return err(`分润池必须为正数 (${tokenPool})`);

  // 验证权重和 = 1
  const weightSum = weights.qualityWeight + weights.quantityWeight + weights.efficiencyWeight;
  if (Math.abs(weightSum - 1.0) > 0.01) {
    return err(`分润权重之和必须为 1 (实际 ${weightSum})`);
  }

  // 计算总量
  const totalOutputTokens = contributions.reduce((sum, c) => sum + c.outputTokens, 0);
  const totalInverseTime = contributions.reduce((sum, c) => sum + (c.elapsedMs > 0 ? 1 / c.elapsedMs : 0), 0);

  if (totalOutputTokens === 0) return err('总输出 Token 为 0，无法分润');
  if (totalInverseTime === 0) return err('所有 Partner 耗时为 0，无法计算效率分');

  // 计算各 Partner 的综合分
  const scores: Array<{ agentId: string; compositeScore: number }> = [];

  for (const c of contributions) {
    const qualityPart = c.qualityScore;
    const quantityPart = totalOutputTokens > 0 ? c.outputTokens / totalOutputTokens : 0;
    const efficiencyPart = totalInverseTime > 0 && c.elapsedMs > 0
      ? (1 / c.elapsedMs) / totalInverseTime
      : 0;

    const composite = weights.qualityWeight * qualityPart
      + weights.quantityWeight * quantityPart
      + weights.efficiencyWeight * efficiencyPart;

    scores.push({ agentId: c.agentId, compositeScore: composite });
  }

  // 计算分润
  const totalComposite = scores.reduce((sum, s) => sum + s.compositeScore, 0);
  if (totalComposite === 0) return err('综合分总和为 0');

  const results: DistributionResult[] = scores.map(s => ({
    agentId: s.agentId,
    compositeScore: s.compositeScore,
    share: Math.floor(tokenPool * (s.compositeScore / totalComposite)),
  }));

  // 处理舍入误差：将余数分配给综合分最高的
  const distributed = results.reduce((sum, r) => sum + r.share, 0);
  const remainder = tokenPool - distributed;
  if (remainder > 0 && results.length > 0) {
    const best = results.reduce((a, b) => a.compositeScore >= b.compositeScore ? a : b);
    best.share += remainder;
  }

  return ok(results);
}

/**
 * 执行分润——对每个 Partner 入账
 */
export function executeDistribution(
  results: DistributionResult[],
  traceId: string,
  contractId: string,
): Result<void> {
  for (const r of results) {
    if (r.share <= 0) continue;
    const creditResult = credit(r.agentId, r.share, traceId, 'PROFIT_SHARING', {
      contractId,
      compositeScore: r.compositeScore,
    });
    if (!creditResult.ok) return err(`Partner ${r.agentId} 入账失败: ${creditResult.error}`);
  }
  return ok(undefined);
}
