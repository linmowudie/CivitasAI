/**
 * @module Arbitration/arbitratorPool
 * @description
 * 仲裁者池——Docs/05 §5.3。
 * 管理核心层（固定 1）+ 辅助层（动态 0~N）仲裁者。
 * Phase 0-2：内存模拟仲裁者；Phase 3 接真实 LLM。
 */

import type { ArbitratorVerdict, VerdictType } from './types.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 仲裁者描述 ──────────────────────────────────────────────────────

export interface Arbitrator {
  arbitratorId: string;
  layer: 'core' | 'auxiliary';
  status: 'idle' | 'busy' | 'offline';
  assignedCaseId: string | null;
  totalVerdicts: number;
  createdAt: number;
}

// ── 内部状态 ────────────────────────────────────────────────────────

const arbitrators: Map<string, Arbitrator> = new Map();
let arbitratorCounter = 0;

// ── 初始化 ──────────────────────────────────────────────────────────

/**
 * 初始化仲裁者池，默认 1 核心 + 2 辅助。
 */
export function initArbitratorPool(config: {
  coreCount?: number;
  auxiliaryCount?: number;
} = {}): void {
  const coreCount = config.coreCount ?? 1;
  const auxCount = config.auxiliaryCount ?? 2;

  // 创建核心层
  for (let i = 0; i < coreCount; i++) {
    addArbitrator('core');
  }
  // 创建辅助层
  for (let i = 0; i < auxCount; i++) {
    addArbitrator('auxiliary');
  }
}

function addArbitrator(layer: 'core' | 'auxiliary'): Arbitrator {
  const id = `arb-${++arbitratorCounter}`;
  const arb: Arbitrator = {
    arbitratorId: id,
    layer,
    status: 'idle',
    assignedCaseId: null,
    totalVerdicts: 0,
    createdAt: Date.now(),
  };
  arbitrators.set(id, arb);
  return arb;
}

// ── 分配仲裁者 ──────────────────────────────────────────────────────

/**
 * 为案件分配 N 个仲裁者（优先核心层，再辅助层）。
 */
export function assignArbitrators(caseId: string, count: number): Result<Arbitrator[]> {
  const idle = [...arbitrators.values()]
    .filter(a => a.status === 'idle')
    .sort((a, b) => {
      // 核心层优先
      if (a.layer !== b.layer) return a.layer === 'core' ? -1 : 1;
      return a.totalVerdicts - b.totalVerdicts; // 负载均衡
    });

  if (idle.length < count) {
    return err(`可用仲裁者不足：需要 ${count}，可用 ${idle.length}`);
  }

  const assigned = idle.slice(0, count);
  for (const arb of assigned) {
    arb.status = 'busy';
    arb.assignedCaseId = caseId;
  }

  return ok(assigned);
}

// ── 释放仲裁者 ──────────────────────────────────────────────────────

export function releaseArbitrators(caseId: string): void {
  for (const arb of arbitrators.values()) {
    if (arb.assignedCaseId === caseId) {
      arb.status = 'idle';
      arb.assignedCaseId = null;
      arb.totalVerdicts++;
    }
  }
}

// ── 模拟裁决（Phase 0-2）───────────────────────────────────────────

/**
 * 使用分配的仲裁者执行模拟裁决。
 * Phase 0-2：规则裁决（LWW 时间戳优先），所有仲裁者结论一致。
 */
export function executeVerdicts(params: {
  caseId: string;
  arbitrators: Arbitrator[];
  plaintiffAgentId: string;
  defendantAgentId: string;
  overrideVerdict?: VerdictType;  // 用于测试不同裁决分布
}): ArbitratorVerdict[] {
  const now = Date.now();
  const verdicts: ArbitratorVerdict[] = [];

  for (const arb of params.arbitrators) {
    const verdict: VerdictType = params.overrideVerdict ?? 'new_wins';

    verdicts.push({
      arbitratorId: arb.arbitratorId,
      verdict,
      winnerId: verdict === 'new_wins' ? params.plaintiffAgentId
        : verdict === 'old_wins' ? params.defendantAgentId
        : null,
      loserId: verdict === 'new_wins' ? params.defendantAgentId
        : verdict === 'old_wins' ? params.plaintiffAgentId
        : null,
      reasoning: `Phase 0-2 规则裁决（${arb.layer}层）`,
      confidence: 0.8,
      deliveredAt: now,
    });
  }

  return verdicts;
}

// ── 扩缩容 ──────────────────────────────────────────────────────────

/**
 * 调整辅助层仲裁者数量。
 */
export function resizeAuxiliaryPool(targetCount: number): Result<{ added: number; removed: number }> {
  const auxList = [...arbitrators.values()].filter(a => a.layer === 'auxiliary');
  const currentCount = auxList.length;
  let added = 0;
  let removed = 0;

  if (targetCount > currentCount) {
    // 扩容
    for (let i = 0; i < targetCount - currentCount; i++) {
      addArbitrator('auxiliary');
      added++;
    }
  } else if (targetCount < currentCount) {
    // 缩容（优先移除空闲的）
    const idleAux = auxList.filter(a => a.status === 'idle');
    const toRemove = idleAux.slice(0, currentCount - targetCount);
    for (const arb of toRemove) {
      arbitrators.delete(arb.arbitratorId);
      removed++;
    }
  }

  return ok({ added, removed });
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getPoolStats(): {
  total: number;
  core: number;
  auxiliary: number;
  idle: number;
  busy: number;
} {
  const all = [...arbitrators.values()];
  return {
    total: all.length,
    core: all.filter(a => a.layer === 'core').length,
    auxiliary: all.filter(a => a.layer === 'auxiliary').length,
    idle: all.filter(a => a.status === 'idle').length,
    busy: all.filter(a => a.status === 'busy').length,
  };
}

export function getAllArbitrators(): Arbitrator[] {
  return [...arbitrators.values()].map(a => ({ ...a }));
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetArbitratorPool(): void {
  arbitrators.clear();
  arbitratorCounter = 0;
}
