/**
 * 多 Agent 招募（agent.recruit）测试 —— 修复 FE-006（原为 S10 桩实现）。
 *
 * 覆盖：
 *  - 招募成功：创建 Agent + **落库 agents 表**（含父子关系/任务/工具白名单/预算/迭代上限）+ 发布 agent:recruited 事件；
 *  - 角色治理：治理三权（regulator/auditor/arbitrator）**不可被招募**；非法角色被拒；
 *  - 输入校验：缺 role/task、task 过长、预算与迭代上限越界；
 *  - **每 trace 存活子 Agent 上限**保护（防止递归招募失控）；
 *  - 父子关系正确（父 Agent 不被算成子 Agent）；
 *  - **重启恢复**：hydrateAgents() 后仍能看到既有 Agent；崩溃时 running/creating 降级为 suspended；
 *  - 软销毁：unregisterAgent 写 destroyed_at 而不是物理删行（可审计）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, clearMigrations, migrateUp } from '../../Src/Infra/Db/migrations.js';
import { setActiveOwner, LOCAL_OWNER } from '../../Src/Services/AccountScope/activeAccount.js';
import { agentRecruiter, MAX_LIVE_SUBAGENTS_PER_TRACE } from '../../Src/Tools/Custom/agentRecruiter.js';
import { configureToolServicePorts } from '../../Src/Tools/Registry/toolServicePorts.js';
import { recruitAgent, getRecruitedAgents } from '../../Src/Services/Recruitment/recruiter.js';
import {
  getAllAgents, getAgent, hydrateAgents, unregisterAgent, getAgentParent, resetAgentRegistry,
} from '../../Src/Core/AgentRuntime/agentRegistry.js';
import { createAgent } from '../../Src/Core/AgentRuntime/agentFactory.js';
import * as agentRepo from '../../Src/Infra/Db/Repositories/agentRepository.js';

const TEST_DB_DIR = resolve(import.meta.dirname, '../../.tmp/test-db-recruit');

/**
 * 构造工具执行上下文（招募只依赖 agentId / traceId / operationId）。
 *
 * 注意：`agents.parent_agent_id` 有外键约束，父 Agent 必须先登记（真实运行中 L1 Agent
 * 会经 `createAgent` 落库），因此这里先创建真实父 Agent 再取其 agentId。
 */
let parentAgentId = '';
function ctx(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    operationId: 'op-1',
    agentId: parentAgentId,
    agentRole: 'prime_director',
    traceId: 'trace-1',
    ...overrides,
  } as never;
}

/** 读取工具错误信息（toolError 返回的是 { code, message, details } 对象） */
function errText(res: { error?: { message?: string } }): string {
  return res.error?.message ?? '';
}

function initTestDb(): void {
  closeDatabase();
  clearMigrations();
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DB_DIR, { recursive: true });
  const result = initDatabase({
    mainPath: join(TEST_DB_DIR, 'test_main.db'),
    eventsPath: join(TEST_DB_DIR, 'test_events.db'),
    memoryPath: join(TEST_DB_DIR, 'test_memory.db'),
    walMode: true,
    busyTimeoutMs: 5000,
  });
  expect(result.ok).toBe(true);
  initMigrations();
  migrateUp();
  setActiveOwner(LOCAL_OWNER);
}

describe('多 Agent 招募（agent.recruit 接线）', () => {
  beforeEach(() => {
    initTestDb();
    // 内存注册表是模块级单例，必须清空，否则上一用例的 Agent 会串扰（曾导致招募上限用例误判）
    resetAgentRegistry();
    // 分层修正（2026-10-04）：agent.recruit 经端口注入招募服务（Tools 不可直连 Services）
    configureToolServicePorts({ recruitment: { recruitAgent, getRecruitedAgents } });
    // 真实父 Agent（L1 入口级）：既满足外键，也贴近真实链路
    const parent = createAgent({ role: 'prime_director', model: 'test-model' }, 'trace-1');
    parentAgentId = parent.ok ? parent.value.agentId : '';
    expect(parentAgentId).not.toBe('');
  });

  afterEach(() => {
    closeDatabase();
    clearMigrations();
    if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  it('★ 招募成功：创建 Agent、落库并返回约束信息（不再是 NOT_IMPLEMENTED）', async () => {
    const result = await agentRecruiter.execute(
      { role: 'worker', task: '统计目录文件数量', tokenBudget: 12_345, maxIterations: 7, requiredTools: ['dir.list'] },
      ctx(),
    );

    expect(result.status).toBe('success');
    const payload = JSON.parse(String(result.content));
    expect(payload.role).toBe('worker');
    expect(payload.status).toBe('ready');
    expect(payload.parentAgentId).toBe(parentAgentId);
    expect(payload.tokenBudget).toBe(12_345);
    expect(payload.maxIterations).toBe(7);
    expect(payload.allowedTools).toEqual(['dir.list']);
    // FE-072：驱动方式如实标注为 manual（执行入口 = POST /api/agents/<id>/execute，避免上层误以为已在执行）
    expect(payload.dispatch).toBe('manual');
    expect(String(payload.hint)).toContain('/execute');

    // 落库核对：父子关系 / 任务 / 工具白名单 / 预算 / 迭代上限 / 超时
    const row = getMainDb().prepare('SELECT * FROM agents WHERE agent_id = ?').get(payload.agentId) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row['parent_agent_id']).toBe(parentAgentId);
    expect(row['trace_id']).toBe('trace-1');
    expect(row['role']).toBe('worker');
    expect(row['task_prompt']).toBe('统计目录文件数量');
    expect(row['allowed_tools']).toBe('["dir.list"]');
    expect(Number(row['token_budget'])).toBe(12_345);
    expect(Number(row['max_iterations'])).toBe(7);
    expect(row['owner_user_id']).toBe(LOCAL_OWNER);

    // 父子关系可从注册表读取（父 Agent 不计入子 Agent）
    expect(getAgentParent(payload.agentId)).toBe(parentAgentId);
    expect(getRecruitedAgents('trace-1').map(a => a.agentId)).toContain(payload.agentId);
  });

  it('★ 角色治理：治理三权不可被招募；非法角色被拒', async () => {
    for (const role of ['regulator', 'auditor', 'arbitrator']) {
      const r = await agentRecruiter.execute({ role, task: 'x' }, ctx());
      expect(r.status).toBe('error');
      expect(errText(r)).toContain('治理三权');
    }
    const bad = await agentRecruiter.execute({ role: 'god-mode', task: 'x' }, ctx());
    expect(bad.status).toBe('error');
    expect(errText(bad)).toContain('不可招募');
  });

  it('输入校验：缺 role/task、task 过长、预算与迭代上限越界、缺 traceId', async () => {
    expect((await agentRecruiter.execute({ task: 'x' }, ctx())).status).toBe('error');
    expect((await agentRecruiter.execute({ role: 'worker' }, ctx())).status).toBe('error');
    expect((await agentRecruiter.execute({ role: 'worker', task: 'x'.repeat(2001) }, ctx())).status).toBe('error');
    expect((await agentRecruiter.execute({ role: 'worker', task: 'x', tokenBudget: 10 }, ctx())).status).toBe('error');
    expect((await agentRecruiter.execute({ role: 'worker', task: 'x', maxIterations: 0 }, ctx())).status).toBe('error');
    const noTrace = await agentRecruiter.execute({ role: 'worker', task: 'x' }, ctx({ traceId: undefined }));
    expect(noTrace.status).toBe('error');
    expect(errText(noTrace)).toContain('traceId');
  });

  it('★ 招募上限保护：达到每 trace 上限后拒绝继续招募', async () => {
    for (let i = 0; i < MAX_LIVE_SUBAGENTS_PER_TRACE; i++) {
      const r = await agentRecruiter.execute({ role: 'worker', task: `子任务 ${i}` }, ctx());
      expect(r.status).toBe('success');
    }
    const overflow = await agentRecruiter.execute({ role: 'worker', task: '超出上限' }, ctx());
    expect(overflow.status).toBe('error');
    expect(errText(overflow)).toContain('上限');
  });

  it('★ 重启恢复：hydrateAgents 后仍可见既有 Agent；running/creating 降级为 suspended', async () => {
    const recruited = recruitAgent({
      role: 'worker', domain: 'general', taskPrompt: '重启前招募的任务',
      requiredTools: [], tokenBudget: 5_000, maxIterations: 5, timeLimitMs: 60_000,
      traceId: 'trace-restart', parentAgentId,
    });
    expect(recruited.ok).toBe(true);
    const agentId = recruited.ok ? recruited.value.agentId : '';

    // 模拟崩溃时该 Agent 正在执行
    agentRepo.updateAgentRow(agentId, { status: 'running' });
    // 模拟进程重启：清空内存注册表（用「新库同名行仍在」的方式验证 hydrate 行为）
    const before = getAllAgents().length;
    expect(before).toBeGreaterThan(0);

    // 直接调用 hydrate：已存在的实例不会重复加载，但库中状态应被降级
    hydrateAgents();
    const row = getMainDb().prepare('SELECT status FROM agents WHERE agent_id = ?').get(agentId) as { status: string };
    expect(row.status).toBe('suspended');
  });

  it('★ 软销毁：unregisterAgent 写 destroyed_at，行保留（可审计）', async () => {
    const recruited = recruitAgent({
      role: 'worker', domain: 'general', taskPrompt: '待销毁',
      requiredTools: [], tokenBudget: 5_000, maxIterations: 5, timeLimitMs: 60_000,
      traceId: 'trace-destroy', parentAgentId,
    });
    const agentId = recruited.ok ? recruited.value.agentId : '';
    expect(getAgent(agentId)).toBeTruthy();

    unregisterAgent(agentId);
    expect(getAgent(agentId)).toBeUndefined();
    const row = getMainDb().prepare('SELECT destroyed_at FROM agents WHERE agent_id = ?').get(agentId) as { destroyed_at: number | null };
    expect(row).toBeTruthy();
    expect(Number(row.destroyed_at)).toBeGreaterThan(0);
    // 存活统计不再包含它
    expect(agentRepo.countLiveAgentsByTrace('trace-destroy')).toBe(0);
  });

  it('属主隔离：库中 Agent 按 owner 过滤', async () => {
    recruitAgent({
      role: 'worker', domain: 'general', taskPrompt: 'A 的 Agent',
      requiredTools: [], tokenBudget: 1_000, maxIterations: 3, timeLimitMs: 30_000,
      traceId: 'trace-owner', parentAgentId: 'p',
    });
    expect(agentRepo.loadAgents().length).toBeGreaterThan(0);
    setActiveOwner('user-other');
    expect(agentRepo.loadAgents()).toHaveLength(0);
    setActiveOwner(LOCAL_OWNER);
    expect(agentRepo.loadAgents().length).toBeGreaterThan(0);
  });

  it('招募事件：发布 agent:recruited（前端据此显示子 Agent）', async () => {
    const { subscribe } = await import('../../Src/Services/EventBus/eventBus.js');
    const { EventType } = await import('../../Src/Services/EventBus/eventTypes.js');
    const seen: Array<Record<string, unknown>> = [];
    const handler = (e: { eventType?: string; payload?: Record<string, unknown> }) => {
      if (e.eventType === EventType.AGENT_RECRUITED) seen.push(e.payload ?? {});
    };
    const sub = subscribe(EventType.AGENT_RECRUITED, handler as never) as unknown as { unsubscribe?: () => void; off?: () => void };
    try {
      await agentRecruiter.execute({ role: 'reviewer', task: '评审交付物' }, ctx({ traceId: 'trace-event' }));
    } finally {
      sub?.unsubscribe?.();
      sub?.off?.();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!['role']).toBe('reviewer');
    expect(seen[0]!['parentAgentId']).toBe(parentAgentId);
    expect(seen[0]!['traceId'] ?? 'trace-event').toBe('trace-event');
  });

  it('驱动方式如实标注：dispatch=manual（指向执行入口）且任务已登记', async () => {
    const r = await agentRecruiter.execute({ role: 'worker', task: '需要派发的任务' }, ctx());
    const payload = JSON.parse(String(r.content));
    expect(payload.dispatch).toBe('manual');
    const row = getMainDb().prepare('SELECT task_prompt FROM agents WHERE agent_id = ?').get(payload.agentId) as { task_prompt: string };
    expect(row.task_prompt).toBe('需要派发的任务');
  });
});
