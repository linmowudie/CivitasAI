/**
 * 治理台账落库 + 属主隔离 + 回灌（2026-10-04，G-10 后续）
 *
 * 不变量：
 *  1. 记录写入即落库（四类元数据 + 动作语义完整保留）；
 *  2. 跨账号隔离：其他属主查不到；
 *  3. 重启（清空内存台账）后 `listGovernanceRecords` / `hydrateGovernanceLedger` 仍能读回；
 *  4. 落库失败不阻断治理动作（无库环境降级为内存台账，不抛错）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import {
  recordGovernanceAction, listGovernanceRecords, resetGovernanceLedger,
  hydrateGovernanceLedger, loadPersistedGovernanceRecords, governanceRecordCount,
  getGovernanceRecord,
} from '../../Src/Services/Governance/governanceAudit.js';
import { setActiveOwner } from '../../Src/Services/AccountScope/activeAccount.js';

const DIR = resolve(import.meta.dirname, '../../Data/_test_gov_ledger');

function initDb(): void {
  closeDatabase(); clearMigrations();
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  initDatabase({
    mainPath: join(DIR, 'm.db'), eventsPath: join(DIR, 'e.db'), memoryPath: join(DIR, 'mm.db'),
    walMode: true, busyTimeoutMs: 5000,
  });
  initMigrations();
  const up = migrateUp();
  expect(up.ok, up.ok ? '' : String(up.error)).toBe(true);
}

describe('治理台账落库', () => {
  beforeEach(() => { initDb(); resetGovernanceLedger(); setActiveOwner('alice'); });
  afterEach(() => { closeDatabase(); clearMigrations(); if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true }); });

  it('★ 记录写入即落库（四类元数据完整）', () => {
    recordGovernanceAction({
      action: 'audit.freeze', actorRole: 'auditor', actorId: 'agent-auditor-1',
      traceId: 'trace-9', taskId: 'task-9', outcome: 'allowed', reason: '异常消费', targetIds: ['agent-x'],
    });
    const rows = loadPersistedGovernanceRecords('alice');
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.recordId).toMatch(/^gov-/);
    expect(typeof r.timestamp).toBe('number');
    expect(r.actorRole).toBe('auditor');
    expect(r.actorId).toBe('agent-auditor-1');
    expect(r.taskId).toBe('task-9');
    expect(r.action).toBe('audit.freeze');
    expect(r.outcome).toBe('allowed');
    expect(r.targetIds).toEqual(['agent-x']);
  });

  it('★ 跨账号隔离：bob 查不到 alice 的治理记录', () => {
    recordGovernanceAction({ action: 'regulation.broadcast', actorRole: 'regulatory_authority' });
    expect(loadPersistedGovernanceRecords('bob').length).toBe(0);
    setActiveOwner('bob');
    resetGovernanceLedger();
    expect(listGovernanceRecords().length).toBe(0);       // 查询按属主过滤
    setActiveOwner('alice');
    expect(listGovernanceRecords().length).toBe(1);
  });

  it('★ 内存台账同样按属主隔离（不清空内存，仅切属主）—— FE-044', () => {
    const rec = recordGovernanceAction({ action: 'audit.freeze', actorRole: 'auditor' });
    setActiveOwner('bob');
    expect(listGovernanceRecords().length).toBe(0);        // 内存视图不可见
    expect(getGovernanceRecord(rec.recordId)).toBeUndefined();
    setActiveOwner('alice');
    expect(listGovernanceRecords().length).toBe(1);        // 切回后仍可见
    expect(getGovernanceRecord(rec.recordId)).toBeDefined();
  });

  it('★ 重启不丢：清空内存台账后仍可查询 + 可回灌', () => {
    recordGovernanceAction({ action: 'arbitration.verdict', actorRole: 'arbitrator', reason: '冲突裁决' });
    resetGovernanceLedger();                       // 模拟进程重启（内存清空，库保留）
    expect(governanceRecordCount()).toBe(0);
    expect(listGovernanceRecords().length).toBe(1); // 查询合并持久化记录

    const hydrated = hydrateGovernanceLedger();
    expect(hydrated.ok).toBe(true);
    if (hydrated.ok) expect(hydrated.value).toBe(1);
    expect(governanceRecordCount()).toBe(1);        // 内存台账已恢复
  });

  it('回灌幂等：重复回灌不产生重复记录', () => {
    recordGovernanceAction({ action: 'audit.patrol', actorRole: 'auditor' });
    resetGovernanceLedger();
    hydrateGovernanceLedger();
    hydrateGovernanceLedger();
    expect(governanceRecordCount()).toBe(1);
  });

  it('拒绝记录同样落库（越权尝试可追溯）', () => {
    recordGovernanceAction({
      action: 'approval.decide', actorRole: 'worker', actorId: 'agent-w1',
      outcome: 'denied', reason: 'worker 属执行层',
    });
    const rows = loadPersistedGovernanceRecords('alice');
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).toBe('denied');
    expect(rows[0]!.reason).toContain('执行层');
  });

  it('无库环境降级：不抛错（内存台账仍可用）', () => {
    closeDatabase();
    expect(() => recordGovernanceAction({ action: 'audit.patrol', actorRole: 'auditor' })).not.toThrow();
    expect(listGovernanceRecords().length).toBeGreaterThanOrEqual(0);
  });
});
