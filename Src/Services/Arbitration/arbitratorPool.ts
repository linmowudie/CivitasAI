/**
 * @module Arbitration/arbitratorPool
 * @description
 * 仲裁者池——Docs/Agent/05 §5.3。
 * 管理核心层（固定 1）+ 辅助层（动态 0~N）仲裁者。
 * Phase 0-2：内存模拟仲裁者；Phase 3 接真实 LLM。
 */

import type { Result } from '../../Infra/types.js';
import { logger } from '../../Infra/Logging/logger.js';
import { ensureDistinctAgentsForRole, recycleAgentsForRole } from '../Governance/governanceProvisioning.js';
import { ok, err } from '../../Infra/types.js';

import type { ArbitratorVerdict, VerdictType } from './types.js';

// ── 仲裁者描述 ──────────────────────────────────────────────────────

export interface Arbitrator {
  arbitratorId: string;
  /** 绑定的**真实注册 Agent** ID（2026-10-04：池位不再只是内存模拟） */
  agentId?: string;
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
 *
 * **2026-10-07 行为变更：Agent 改为"按需绑定"**。
 *
 * 此前 `initArbitratorPool` 会为每个池位**立即创建真实注册 Agent**（G-20 的接线），
 * 而 `Src/main.ts` 在每次启动都无条件调用它 —— 实测后果：用户只发了一句"你好"，
 * 右侧 L1 Agent 列表里就凭空多出 3 个 `arbitrator` Agent（且每重启一次再累积一批），
 * 与 `ensureAgentForRole` 文档写的"按需创建 / 按需扩容"语义相矛盾。
 *
 * 现在：初始化只建**池位**（内存槽），真实 Agent 在**首次真正需要仲裁**时绑定
 * （见 `ensurePoolAgents`，由 `assignArbitrators` / `resizeAuxiliaryPool` 触发）。
 * 需要旧行为的调用方可传 `provisionAgents: true`。
 */
export function initArbitratorPool(config: {
  coreCount?: number;
  auxiliaryCount?: number;
  /** 兼容/测试用：立刻为池位绑定真实 Agent（默认 false = 懒绑定） */
  provisionAgents?: boolean;
} = {}): void {
  const coreCount = config.coreCount ?? 1;
  const auxCount = config.auxiliaryCount ?? 2;
  const provisionNow = config.provisionAgents === true;

  // 创建核心层
  for (let i = 0; i < coreCount; i++) {
    addArbitrator('core', { provisionAgent: provisionNow });
  }
  // 创建辅助层
  for (let i = 0; i < auxCount; i++) {
    addArbitrator('auxiliary', { provisionAgent: provisionNow });
  }
}

/**
 * 为尚未绑定 Agent 的池位按需绑定真实注册 Agent（幂等）。
 *
 * 触发点：真正要用仲裁者时（分配案件 / 扩容）。返回本次新绑定的数量。
 */
export function ensurePoolAgents(): number {
  let bound = 0;
  for (const arb of arbitrators.values()) {
    if (arb.agentId) continue;
    const ensured = bindAgentToArbitrator(arb);
    if (ensured) bound++;
  }
  return bound;
}

/** 为单个池位绑定一个**独立**的真实 Agent；失败返回 false（降级为纯内存池位） */
function bindAgentToArbitrator(arb: Arbitrator): boolean {
  try {
    // 池位需要**独立** Agent（各自裁决/负载均衡）→ 用 ensureDistinctAgentsForRole 扩容到当前池规模，
    // 并取"本池位在池中的序号"作为自己的 Agent。
    const index = [...arbitrators.keys()].indexOf(arb.arbitratorId);
    const desired = Math.max(index + 1, countBoundAgents() + 1);
    const ensured = ensureDistinctAgentsForRole('arbitrator', desired, {
      reason: `仲裁者池${arb.layer === 'core' ? '核心' : '辅助'}层按需绑定（池位 ${arb.arbitratorId}）`,
    });
    if (!ensured.ok) return false;
    const agentId = ensured.value[index] ?? ensured.value[ensured.value.length - 1];
    if (!agentId) return false;
    arb.agentId = agentId;
    return true;
  } catch {
    // 提供失败不阻断池位使用（降级为纯内存模拟位）；原因由提供层留痕
    return false;
  }
}

/** 当前已绑定真实 Agent 的池位数 */
function countBoundAgents(): number {
  let n = 0;
  for (const arb of arbitrators.values()) if (arb.agentId) n++;
  return n;
}

function addArbitrator(layer: 'core' | 'auxiliary', options: { provisionAgent: boolean } = { provisionAgent: false }): Arbitrator {
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

  // ★ 池位 → **真实 Agent**（2026-10-04 接 G-19/G-20；2026-10-07 改为按需）
  if (options.provisionAgent) bindAgentToArbitrator(arb);

  return arb;
}

// ── 分配仲裁者 ──────────────────────────────────────────────────────

/**
 * 为案件分配 N 个仲裁者（优先核心层，再辅助层）。
 */
export function assignArbitrators(caseId: string, count: number): Result<Arbitrator[]> {
  // 按需绑定：真正要用仲裁者时才创建真实 Agent（启动不再凭空产出治理 Agent）
  ensurePoolAgents();

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
    // 扩容通常由"仲裁负载升高"触发 → 顺手把新池位绑定到真实 Agent
    // （2026-10-07：池位默认懒绑定，这里显式补上，避免扩了空位却不具备裁决身份）
    ensurePoolAgents();
  } else if (targetCount < currentCount) {
    // 缩容（优先移除空闲的）
    const idleAux = auxList.filter(a => a.status === 'idle');
    const toRemove = idleAux.slice(0, currentCount - targetCount);
    for (const arb of toRemove) {
      arbitrators.delete(arb.arbitratorId);
      removed++;
      // ★ 按需回收（2026-10-04，G-21）：池位缩容时**同步回收其绑定的 Agent**（软销毁），
      //   否则"池扩了又缩"会在注册表里留下永不使用的治理身份。
      if (arb.agentId) {
        try {
          // keepCount = 0：只保留**仍在池中**的（excludeAgentIds），其余全部回收
          recycleAgentsForRole('arbitrator', 0, {
            excludeAgentIds: [...arbitrators.values()]
              .map(a => a.agentId)
              .filter((id): id is string => Boolean(id)),
            reason: `仲裁者池缩容至 ${targetCount}`,
          });
        } catch {
          // 回收失败不阻断缩容（池位已移除；异常由提供层留痕）
        }
      }
    }
  }

  return ok({ added, removed });
}

// ── 空闲回收（2026-10-04，G-21）──────────────────────────────────────

/**
 * 回收**长期空闲**的辅助层仲裁者（按需回收的池位维度）。
 *
 * 语义：辅助层中 `status === 'idle'` 且**从未裁决过**（`totalVerdicts === 0`）
 * 且存在时长超过 `staleMs`（默认 10 分钟）的池位 → 移除，并**同步回收其 Agent**。
 * 核心层永不回收（固定 1）；有案件在身的池位不回收。
 *
 * 与 `resizeAuxiliaryPool` 的区别：后者按**目标数量**缩容，本函数按**空闲时长**回收
 * ——用于"需求回落后自动瘦身"，避免长期挂着用不上的治理身份。
 *
 * @returns 被回收的池位 ID 列表
 */
export function recycleIdleArbitrators(options: { staleMs?: number; now?: number } = {}): string[] {
  const staleMs = options.staleMs ?? 10 * 60 * 1000;
  const now = options.now ?? Date.now();
  const recycled: string[] = [];

  for (const arb of [...arbitrators.values()]) {
    if (arb.layer !== 'auxiliary') continue;          // 核心层保底
    if (arb.status !== 'idle') continue;              // 有案件在身不回收
    if (arb.totalVerdicts > 0) continue;              // 用过的不回收（保留热度）
    if (now - arb.createdAt < staleMs) continue;      // 未达空闲阈值

    arbitrators.delete(arb.arbitratorId);
    recycled.push(arb.arbitratorId);

    // 同步回收其绑定 Agent（软销毁，保留审计痕迹）
    if (arb.agentId) {
      try {
        // keepCount = 0：只保留仍在池中的（excludeAgentIds）
        recycleAgentsForRole('arbitrator', 0, {
          excludeAgentIds: [...arbitrators.values()]
            .map(a => a.agentId)
            .filter((id): id is string => Boolean(id)),
          reason: `仲裁者池空闲回收（池位 ${arb.arbitratorId} 超过 ${Math.round(staleMs / 60000)} 分钟未使用）`,
        });
      } catch {
        // 回收失败不阻断池位移除
      }
    }
  }

  if (recycled.length > 0) {
    logger.info('仲裁者池已空闲回收', { source: 'arbitratorPool/recycleIdleArbitrators', count: recycled.length });
  }
  return recycled;
}

// ── 空闲回收定时器（FE-049，2026-10-04）────────────────────────────
// 此前 `recycleIdleArbitrators` 无生产调用者（仅定义与测试）→ 运行期池位只增不减。
// 现在模块自持定时器（与 `dynamicScaling.startAutoScaling` 模式对称），由 `main.ts` 启动期接线。

let idleRecycleTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动周期性空闲回收。
 *
 * @param intervalMs 检查间隔（默认 60s，与监测间隔同节奏）
 * @param staleMs 池位空闲时长阈值（默认 10 分钟，透传 `recycleIdleArbitrators`）
 */
export function startIdleRecycling(intervalMs: number = 60_000, staleMs: number = 10 * 60 * 1000): void {
  stopIdleRecycling();
  idleRecycleTimer = setInterval(() => {
    recycleIdleArbitrators({ staleMs });
  }, intervalMs);
}

export function stopIdleRecycling(): void {
  if (idleRecycleTimer) {
    clearInterval(idleRecycleTimer);
    idleRecycleTimer = null;
  }
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
  stopIdleRecycling();
  arbitrators.clear();
  arbitratorCounter = 0;
}
