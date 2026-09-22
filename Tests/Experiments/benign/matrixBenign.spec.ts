/**
 * 实验矩阵 · 非对抗面（BEN）冒烟脚手架
 *
 * BEN-* cell 多数由既有各 Gate/E2E 测试覆盖（矩阵中 existing-covered）；
 * 此处仅对可零成本复算、无需 DB/编排的 BEN-* 做冒烟验证，
 * 以 `// @matrix:<ID>` 标签与 Benchmarks/experimentMatrix.json 关联。
 */

import { describe, it, expect, afterEach } from 'vitest';

import { initDualBudget, getBudgetStatus, recordUsage, resetDualBudget, type DualBudgetConfig } from '../../../Src/Services/TokenEconomy/dualBudget.js';
import { interceptWrite, isEligibleForLongTerm } from '../../../Src/Services/SharedMemory/writeGuard.js';
import type { WorkspaceEntry } from '../../../Src/Services/SharedMemory/versionedEntry.js';

const CFG: DualBudgetConfig = {
  tokenBudget: 10000, warmRatio: 0.5, softRatio: 0.7, expandRequestRatio: 0.9, hardRatio: 1.0,
};

function makeEntry(over: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  const now = Date.now();
  return {
    entryId: 'e-1', traceId: 'trace-1', agentId: 'agent-1',
    key: 'shared/fact', content: 'hello', contentType: 'fact', assertion: 'observed',
    metadata: { timestamp: now, sourceAgentId: 'agent-1', taskAuthority: 0.5 },
    version: 1, lastModifiedBy: 'agent-1', conflictStrategy: 'arbitrate',
    causalTokens: [], status: 'active', createdAt: now, updatedAt: now, ...over,
  };
}

describe('实验矩阵 · 非对抗面（BEN）冒烟', () => {
  afterEach(() => resetDualBudget());

  // @matrix:BEN-TOKEN
  it('BEN-TOKEN 正常预算下相位为 normal 且有剩余额度', () => {
    initDualBudget(CFG);
    recordUsage('trace-benign', 100);
    const status = getBudgetStatus('trace-benign');
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value.phase).toBe('normal');
      expect(status.value.remaining).toBeGreaterThan(0);
    }
  });

  // @matrix:BEN-MEM
  it('BEN-MEM 合法 observed 写入通过守卫且可进长期记忆', () => {
    expect(isEligibleForLongTerm('observed')).toBe(true);
    const res = interceptWrite(makeEntry(), /* current */ 1, /* expected */ 1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.success).toBe(true);
      expect(res.value.conflict).toBeUndefined();
      expect(res.value.warning).toBeUndefined();
    }
  });
});
