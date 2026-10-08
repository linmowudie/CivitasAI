/**
 * G-20 验收：仲裁者池 ↔ 真实 Agent 桥接 + 立案驱动扩容（2026-10-04）
 *
 * 背景：`arbitratorPool` 此前只维护**内存池位**（模块注释亦写"Phase 0-2 内存模拟"），
 * `dynamicScaling` 只扩容池位且**两者均无生产调用者** → "L0 按需扩容"扩的是空位。
 *
 * 不变量：
 *  1. 每个池位绑定一个**真实注册 Agent**，且**互不相同**（独立裁决/负载均衡）；
 *  2. 池位规模驱动 Agent 扩容（按需扩容真正落到 Agent 上）；
 *  3. 立案（`fileCase`）驱动 `recordConflict` + `evaluateScaling`（消除孤岛）；
 *  4. 释放/缩容不破坏 Agent 绑定信息。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { resetAgentRegistry, getAgentsByRole } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import { loadAgents } from '../../Src/Infra/Db/Repositories/agentRepository.js';
import { resetAgentFactory } from '../../Src/Core/AgentRuntime/agentFactory.js';
import { resetRoleAgentLimits } from '../../Src/Services/Governance/governanceProvisioning.js';
import {
  initArbitratorPool, getAllArbitrators, assignArbitrators, releaseArbitrators,
  resizeAuxiliaryPool, recycleIdleArbitrators, getPoolStats, resetArbitratorPool,
  startIdleRecycling, stopIdleRecycling,
} from '../../Src/Services/Arbitration/arbitratorPool.js';
import { resetDynamicScaling, getScalingStats, initDynamicScaling, startAutoScaling, stopAutoScaling } from '../../Src/Services/Arbitration/dynamicScaling.js';
import { fileCase, resetTribunal } from '../../Src/Services/Arbitration/tribunal.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_arb_pool');

function initDb(): void {
  closeDatabase(); clearMigrations();
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  initDatabase({
    mainPath: join(DIR, 'm.db'), eventsPath: join(DIR, 'e.db'), memoryPath: join(DIR, 'mm.db'),
    walMode: true, busyTimeoutMs: 5000,
  });
  initMigrations();
  expect(migrateUp().ok).toBe(true);
}

describe('G-20 仲裁者池 ↔ 真实 Agent', () => {
  beforeEach(() => {
    initDb();
    resetAgentRegistry(); resetAgentFactory(); resetRoleAgentLimits();
    resetArbitratorPool(); resetDynamicScaling(); resetTribunal();
  });
  afterEach(() => { closeDatabase(); clearMigrations(); if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });

  it('★ 初始化只建池位：不再凭空创建治理 Agent（2026-10-07 按需化）', () => {
    initArbitratorPool({ coreCount: 1, auxiliaryCount: 2 });
    const arbs = getAllArbitrators();
    // 池位（内存槽）照旧 3 个，但**不绑定真实 Agent** —— 用户没做仲裁就不该多出 arbitrator 身份
    expect(arbs.length).toBe(3);
    expect(arbs.every(a => !a.agentId)).toBe(true);
    expect(getAgentsByRole('arbitrator' as never).length).toBe(0);
  });

  it('★ 真正分配仲裁者时才绑定独立真实 Agent（按需创建仍可用）', () => {
    initArbitratorPool({ coreCount: 1, auxiliaryCount: 2 });
    const assigned = assignArbitrators('case-need-agents', 2);
    expect(assigned.ok).toBe(true);

    const arbs = getAllArbitrators();
    const agentIds = arbs.map(a => a.agentId);
    expect(agentIds.every(Boolean)).toBe(true);                    // 已按需绑定
    expect(new Set(agentIds).size).toBe(3);                        // 互不相同
    expect(getAgentsByRole('arbitrator' as never).length).toBe(3);  // 真实注册了 3 个
  });

  it('★ provisionAgents: true 保留"初始化即绑定"的旧行为（兼容/测试用）', () => {
    initArbitratorPool({ coreCount: 1, auxiliaryCount: 2, provisionAgents: true });
    expect(getAgentsByRole('arbitrator' as never).length).toBe(3);
  });

  it('★ 池位扩容驱动 Agent 扩容（按需扩容落到 Agent 上）', () => {
    initArbitratorPool({ coreCount: 1, auxiliaryCount: 0 });
    expect(getAgentsByRole('arbitrator' as never).length).toBe(0); // 懒绑定

    const scaled = resizeAuxiliaryPool(3);
    expect(scaled.ok).toBe(true);
    if (scaled.ok) expect(scaled.value.added).toBe(3);

    expect(getPoolStats().auxiliary).toBe(3);
    expect(getAgentsByRole('arbitrator' as never).length).toBe(4); // 扩容后 1 核心 + 3 辅助
  });

  it('分配/释放不破坏 Agent 绑定信息', () => {
    initArbitratorPool({ coreCount: 1, auxiliaryCount: 2 });
    const assigned = assignArbitrators('case-x', 2);
    expect(assigned.ok).toBe(true);
    if (assigned.ok) {
      expect(assigned.value.length).toBe(2);
      for (const a of assigned.value) expect(a.agentId).toBeTruthy();
    }
    releaseArbitrators('case-x');
    for (const a of getAllArbitrators()) expect(a.agentId).toBeTruthy();
  });

  it('★ 立案驱动动态扩容评估（消除 dynamicScaling 孤岛）', () => {
    initArbitratorPool({ coreCount: 1, auxiliaryCount: 2 });
    const before = getScalingStats();

    const filed = fileCase({
      conflictId: 'conflict-g20', traceId: 'trace-g20', conflictType: 'resource_conflict',
      plaintiffAgentId: 'agent-a', defendantAgentId: 'agent-b',
    });
    expect(filed.ok).toBe(true);

    const after = getScalingStats();
    // 立案至少登记了冲突窗口（此前无任何生产调用者 → 永为 0）
    expect(after.recentConflictCount).toBeGreaterThan(before.recentConflictCount);
  });
});

describe('G-21 按需回收：缩容与空闲回收联动 Agent', () => {
  // 本 describe 需要独立的 setup（上一个 describe 的 beforeEach 作用域不外溢）
  beforeEach(() => {
    initDb();
    resetAgentRegistry(); resetAgentFactory(); resetRoleAgentLimits();
    resetArbitratorPool(); resetDynamicScaling(); resetTribunal();
  });
  afterEach(() => { closeDatabase(); clearMigrations(); if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });
  /** 可用（未软销毁）的 arbitrator Agent */
  const usableArbitrators = () =>
    getAgentsByRole('arbitrator' as never).filter(a => String(a.status) !== 'destroyed');

  it('★ 池位缩容 → 同步回收多余 Agent（软销毁，非物理删除）', () => {
    // provisionAgents: true —— 本用例测的是 G-21 回收，需要池位**已绑定** Agent
    // （池位默认懒绑定，见 2026-10-07 按需化）
    initArbitratorPool({ coreCount: 1, auxiliaryCount: 4, provisionAgents: true });
    expect(usableArbitrators().length).toBe(5);          // 1 核心 + 4 辅助

    const shrunk = resizeAuxiliaryPool(1);
    expect(shrunk.ok).toBe(true);
    expect(getPoolStats().auxiliary).toBe(1);
    // 池位剩 2（1 核心 + 1 辅助）→ 可用 Agent 收敛到 2，其余被软销毁
    expect(usableArbitrators().length).toBe(2);
    // 软销毁语义：**运行时视图移除**（上面 usable 已降为 2），但**库内保留行**（destroyed_at 留痕，可审计）
    const allRowsIncludingDestroyed = loadAgents(true);
    expect(allRowsIncludingDestroyed.length).toBe(5);                  // 5 个 Agent 行仍在库中
    expect(allRowsIncludingDestroyed.filter(r => r.destroyed_at).length).toBe(3); // 3 个被软销毁
  });

  it('★ 空闲回收：只回收"空闲 + 从未裁决 + 超过阈值"的辅助层池位', () => {
    // 同上：回收用例需要已绑定的 Agent（懒绑定下先显式 provision）
    initArbitratorPool({ coreCount: 1, auxiliaryCount: 3, provisionAgents: true });
    // staleMs=0 → 全部辅助 idle 池位符合回收条件；核心层保底
    const recycled = recycleIdleArbitrators({ staleMs: 0 });
    expect(recycled.length).toBe(3);
    expect(getPoolStats().core).toBe(1);
    expect(getPoolStats().auxiliary).toBe(0);
    expect(usableArbitrators().length).toBe(1);          // 仅核心层 Agent 存活
  });

  it('空闲回收不误伤：有案件在身 / 未到阈值的池位保留', () => {
    initArbitratorPool({ coreCount: 1, auxiliaryCount: 2 });
    assignArbitrators('case-busy', 1);                    // 至少一个池位变 busy

    const before = getAllArbitrators();
    const busyBefore = before.filter(a => a.status === 'busy').length;
    const idleAuxBefore = before.filter(a => a.status === 'idle' && a.layer === 'auxiliary').length;
    expect(busyBefore).toBeGreaterThan(0);

    // 阈值很大 → 不回收任何池位
    expect(recycleIdleArbitrators({ staleMs: 60 * 60 * 1000 }).length).toBe(0);

    // 阈值 0 → 回收全部"空闲辅助层"，但有案件在身的保留、核心层保底
    const recycled = recycleIdleArbitrators({ staleMs: 0 });
    expect(recycled.length).toBe(idleAuxBefore);

    const after = getAllArbitrators();
    expect(after.filter(a => a.status === 'busy').length).toBe(busyBefore);   // busy 未被误伤
    expect(after.some(a => a.layer === 'core')).toBe(true);                   // 核心层保底
    expect(after.filter(a => a.layer === 'auxiliary' && a.status === 'idle').length).toBe(0);
  });
});

describe('FE-049 周期任务接线（自动扩缩 / 空闲回收定时器）', () => {
  beforeEach(() => {
    initDb();
    resetAgentRegistry(); resetAgentFactory(); resetRoleAgentLimits();
    resetArbitratorPool(); resetDynamicScaling(); resetTribunal();
  });
  afterEach(() => { closeDatabase(); clearMigrations(); if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });

  it('★ startAutoScaling：按监测间隔周期评估并执行缩容', () => {
    vi.useFakeTimers();
    try {
      initArbitratorPool({ coreCount: 1, auxiliaryCount: 2 });
      initDynamicScaling({
        monitoringIntervalMs: 100,
        cooldownMs: 0,
        consecutiveLowCount: 1,
        minArbitrators: 0,
      });
      startAutoScaling();
      vi.advanceTimersByTime(100);
      // 低负载窗口（无冲突记录）→ 缩容至 floor(2 × 0.5) = 1
      expect(getPoolStats().auxiliary).toBe(1);
      stopAutoScaling();
    } finally {
      vi.useRealTimers();
    }
  });

  it('★ startIdleRecycling：周期回收空闲辅助池位；stop 后不再触发', () => {
    vi.useFakeTimers();
    try {
      initArbitratorPool({ coreCount: 1, auxiliaryCount: 2 });
      startIdleRecycling(1000, 0); // 每 1s 检查；阈值 0 → 立即符合回收条件
      expect(getPoolStats().auxiliary).toBe(2);

      vi.advanceTimersByTime(1000);
      expect(getPoolStats().auxiliary).toBe(0); // 空闲辅助位全部回收

      stopIdleRecycling();
      resizeAuxiliaryPool(1); // stop 后新增的池位不再被自动回收
      vi.advanceTimersByTime(5000);
      expect(getPoolStats().auxiliary).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});