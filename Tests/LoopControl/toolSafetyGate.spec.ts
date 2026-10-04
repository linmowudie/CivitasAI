/**
 * ToolSafetyGate 中间件测试（2026-10-01 阻塞式审批语义）。
 *
 * 语义：
 * - DANGEROUS + IRREVERSIBLE 工具 → **先阻塞**，创建并广播审批请求；
 * - 人工确认通过（满足策略）→ **放开阻塞并执行**工具；
 * - 拒绝 / 超时 → 不执行，返回错误；
 * - 自动审批白名单命中 → 无需用户确认，展示审查动画后自动通过并执行；
 * - SAFE / 未注册工具透传。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createToolSafetyGateMiddleware, buildIrreversibleDeciders } from '../../Src/Services/LoopControl/middleware/toolSafetyGate.js';
import { buildApprovalDeciders } from '../../Src/Services/Governance/governanceGuard.js';
import {
  getPendingApprovals, getApproval, decideApproval, clearApprovalQueue,
} from '../../Src/Services/LoopControl/approvalGate.js';
import { registerTool, clearRegistry } from '../../Src/Tools/Registry/toolRegistry.js';
import { initDatabase, closeDatabase, getMainDb } from '../../Src/Infra/Db/database.js';
import { initMigrations, migrateUp, clearMigrations } from '../../Src/Infra/Db/migrations.js';
import { initEffectJournal } from '../../Src/Infra/DurableExecution/effectJournal.js';
import { subscribeMany } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';
import type { ToolDefinition } from '../../Src/Tools/Traits/toolSpec.js';
import { contentOutputSchema } from '../../Src/Tools/Builtin/_shared.js';
import type { MiddlewareContext, ToolCallInput, ToolCallOutput } from '../../Src/Infra/Contracts/middlewareTypes.js';

const BASE_SPEC = {
  version: '0.1.0',
  description: '测试工具',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  outputSchema: contentOutputSchema('{ ok }'),
  idempotency: 'NO',
  sideEffectScope: 'external',
  requiredRoles: ['prime_director'],
  sandboxMode: 'none',
  timeoutMs: 1000,
} as const;

function makeTool(name: string, dangerLevel: 'SAFE' | 'DANGEROUS', reversibility: 'REVERSIBLE' | 'IRREVERSIBLE'): ToolDefinition {
  return {
    spec: { ...BASE_SPEC, name, dangerLevel, reversibility } as ToolDefinition['spec'],
    async execute() { return { status: 'success', content: 'executed', recoverable: false }; },
  };
}

function makeCtx(): MiddlewareContext {
  return { agentId: 'agent-1', agentRole: 'prime_director', sessionId: 'sess-1', iteration: 1, traceId: 'trace-1', data: {} };
}

/** 满足 CRITICAL unanimous 策略：需要 2 个**不同身份**的审批人（2026-10-04 起为身份级去重） */
function approveFully(approvalId: string) {
  decideApproval({ approvalId, decidedBy: 'user:alice', approve: true });
  // L0 治理角色（auditor）确认 —— 2026-10-04 起审批人不含 L1 的 prime_director（防自审）
  return decideApproval({ approvalId, decidedBy: 'auditor:bob', approve: true });
}

const OK_OUTPUT: ToolCallOutput = { status: 'success', content: 'executed', recoverable: false };

/** 副作用日志（EffectJournal）依赖数据库与 loops 行，测试需按启动期顺序初始化 */
const TEST_DB_DIR = join(resolve(import.meta.dirname, '..', '..'), 'Data', '_test_toolgate');

function initTestDb(): void {
  closeDatabase();
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
  clearMigrations();
  mkdirSync(TEST_DB_DIR, { recursive: true });
  initDatabase({
    mainPath: join(TEST_DB_DIR, 'test_main.db'),
    eventsPath: join(TEST_DB_DIR, 'test_events.db'),
    memoryPath: join(TEST_DB_DIR, 'test_memory.db'),
    walMode: true,
    busyTimeoutMs: 5000,
  });
  initMigrations();
  migrateUp();
  getMainDb().prepare(`
    INSERT INTO loops (loop_id, trace_id, session_key, agent_id, task_id,
      goal_json, state_json, phase, created_at, updated_at)
    VALUES ('loop-1', 'trace-1', 'sess-1', 'agent-1', 'task-1', '{}', '{}', 'acting', ?, ?)
  `).run(Date.now(), Date.now());
  initEffectJournal({ defaultTimeoutMs: 30_000 });
}

function cleanupDb(): void {
  closeDatabase();
  clearMigrations();
  if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

describe('ToolSafetyGate（阻塞式审批）', () => {
  let unsub: (() => void) | undefined;
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  beforeEach(() => {
    clearRegistry();
    clearApprovalQueue();
    events.length = 0;
    initTestDb();
    registerTool(makeTool('test.safe', 'SAFE', 'REVERSIBLE'));
    registerTool(makeTool('test.dangerous', 'DANGEROUS', 'IRREVERSIBLE'));
    const sub = subscribeMany(
      [EventType.APPROVAL_REQUESTED, EventType.APPROVAL_DECIDED],
      (event) => { events.push({ type: event.eventType, payload: event.payload as Record<string, unknown> }); },
    );
    unsub = () => sub.unsubscribe();
  });

  afterEach(() => {
    unsub?.();
    clearRegistry();
    clearApprovalQueue();
    cleanupDb();
  });

  it('危险工具先阻塞并广播审批请求，人工确认后才执行', async () => {
    const mw = createToolSafetyGateMiddleware(() => 'loop-1', () => 1, () => 'trace-1');
    const input: ToolCallInput = { toolName: 'test.dangerous', arguments: { a: 1 }, toolCallId: 'tc-1' };
    let executed = false;
    const next = async () => { executed = true; return OK_OUTPUT; };

    const pendingCall = (mw.execute as Function)(makeCtx(), input, next) as Promise<ToolCallOutput>;

    // ① 已广播审批请求，且此时工具**尚未执行**（阻塞中）
    await new Promise(r => setTimeout(r, 20));
    expect(executed).toBe(false);
    const requested = events.find(e => e.type === 'loop:approval_requested');
    expect(requested).toBeDefined();
    expect(requested!.payload['toolCallId']).toBe('tc-1');
    expect(requested!.payload['sessionId']).toBe('sess-1');

    const approvalId = requested!.payload['approvalId'] as string;
    expect(getPendingApprovals()).toHaveLength(1);

    // ② 放行前仍不执行
    decideApproval({ approvalId, decidedBy: 'user:tester', approve: true });
    await new Promise(r => setTimeout(r, 20));
    expect(executed).toBe(false); // unanimous 需 2 个角色

    // ③ 满足策略 → 唤醒 → 执行
    approveFully(approvalId);
    const out = await pendingCall;
    expect(executed).toBe(true);
    expect(out.status).toBe('success');
    expect(getApproval(approvalId)?.status).toBe('APPROVED');
  });

  it('人工拒绝 → 不执行工具，返回不可重试错误', async () => {
    const mw = createToolSafetyGateMiddleware(() => 'loop-1', () => 1, () => 'trace-1');
    const input: ToolCallInput = { toolName: 'test.dangerous', arguments: {}, toolCallId: 'tc-2' };
    let executed = false;
    const next = async () => { executed = true; return OK_OUTPUT; };

    const pendingCall = (mw.execute as Function)(makeCtx(), input, next) as Promise<ToolCallOutput>;
    await new Promise(r => setTimeout(r, 20));

    const approvalId = getPendingApprovals()[0]!.approvalId;
    decideApproval({ approvalId, decidedBy: 'user:tester', approve: false });

    const out = await pendingCall;
    expect(executed).toBe(false);
    expect(out.status).toBe('error');
    expect(out.content).toContain('人工审批未通过');
    expect(out.recoverable).toBe(false);
  });

  it('超时默认拒绝 → 不执行工具', async () => {
    // 0.15s 超时
    const mw = createToolSafetyGateMiddleware(() => 'loop-1', () => 1, () => 'trace-1', {
      approvalTimeoutSec: 0.15,
    });
    const input: ToolCallInput = { toolName: 'test.dangerous', arguments: {}, toolCallId: 'tc-3' };
    let executed = false;
    const next = async () => { executed = true; return OK_OUTPUT; };

    const out = await ((mw.execute as Function)(makeCtx(), input, next) as Promise<ToolCallOutput>);

    expect(executed).toBe(false);
    expect(out.status).toBe('error');
    expect(out.content).toContain('TIMEOUT');
    const approval = getApproval(getPendingApprovals()[0]?.approvalId ?? '') ?? undefined;
    // 已决审批不在待审批列表中
    expect(getPendingApprovals()).toHaveLength(0);
    expect(approval).toBeUndefined();
  });

  it('自动审批白名单：无需人工确认，审查动画后自动通过并执行', async () => {
    const mw = createToolSafetyGateMiddleware(() => 'loop-1', () => 1, () => 'trace-1', {
      autoApproveTools: ['test.dangerous'],
      autoApproveDelayMs: 30,
    });
    const input: ToolCallInput = { toolName: 'test.dangerous', arguments: {}, toolCallId: 'tc-4' };
    let executed = false;
    const next = async () => { executed = true; return OK_OUTPUT; };

    const t0 = Date.now();
    const out = await ((mw.execute as Function)(makeCtx(), input, next) as Promise<ToolCallOutput>);
    const elapsed = Date.now() - t0;

    expect(out.status).toBe('success');
    expect(executed).toBe(true);
    // 保留可感知的审查动画时长
    expect(elapsed).toBeGreaterThanOrEqual(25);
    const decided = events.find(e => e.type === 'loop:approval_decided');
    expect(decided).toBeDefined();
    expect(decided!.payload['auto']).toBe(true);
    expect(decided!.payload['status']).toBe('APPROVED');
  });

  it('SAFE 工具直接放行，不产生审批也不广播', async () => {
    const mw = createToolSafetyGateMiddleware(() => 'loop-1', () => 1, () => 'trace-1');
    const input: ToolCallInput = { toolName: 'test.safe', arguments: {}, toolCallId: 'tc-5' };
    let executed = false;
    const next = async () => { executed = true; return OK_OUTPUT; };

    const out = await ((mw.execute as Function)(makeCtx(), input, next) as Promise<ToolCallOutput>);

    expect(executed).toBe(true);
    expect(out.status).toBe('success');
    expect(getPendingApprovals()).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('未注册工具透传给后续链路', async () => {
    const mw = createToolSafetyGateMiddleware(() => 'loop-1', () => 1, () => 'trace-1');
    const input: ToolCallInput = { toolName: 'test.unknown', arguments: {}, toolCallId: 'tc-6' };
    const next = async () => ({ status: 'error' as const, content: 'TOOL_NOT_FOUND', recoverable: false });

    const out = await ((mw.execute as Function)(makeCtx(), input, next) as Promise<ToolCallOutput>);

    expect(out.content).toBe('TOOL_NOT_FOUND');
    expect(events).toHaveLength(0);
  });

  it('★ 审批池按请求方层级构造：L2 任两方、L1 只许用户+L0（2026-10-04 修复）', () => {
    // 场景 1：L2（worker）请求 → L2 属 L1 自治域 → 用户 / L1 / L0 均可入池，任意"两方"即可决
    const poolL2 = buildApprovalDeciders('worker');
    const rolesL2 = poolL2.deciders.map(d => d.role);
    expect(rolesL2).toContain('user');
    expect(rolesL2).toContain('prime_director');       // L1 可参与（自治域）
    expect(rolesL2.some(r => r === 'auditor' || r === 'regulatory_authority')).toBe(true); // L0 可参与
    expect(rolesL2).not.toContain('worker');           // 请求方自身不入池
    expect(poolL2.requiredApprovals).toBe(2);          // 任意两方

    // 场景 2：L1（prime_director）自身请求 → 不得自审 → 只许 用户 + L0
    const poolL1 = buildApprovalDeciders('prime_director');
    const rolesL1 = poolL1.deciders.map(d => d.role);
    expect(rolesL1).toContain('user');
    expect(rolesL1.some(r => r === 'auditor' || r === 'regulatory_authority')).toBe(true);
    expect(rolesL1).not.toContain('prime_director');   // ★ 防层级自审
    expect(poolL1.requiredApprovals).toBe(2);

    // 场景 3：治理角色自身请求 → 剔除自身后仍有 用户 + 另一 L0
    const poolL0 = buildApprovalDeciders('auditor');
    const rolesL0 = poolL0.deciders.map(d => d.role);
    expect(rolesL0).not.toContain('auditor');
    expect(rolesL0).toContain('user');
    expect(rolesL0).toContain('regulatory_authority');

    // 场景 4：安全门兜底函数不会把请求方角色放进池（即使配置里写了）
    const patched = buildIrreversibleDeciders('prime_director', [{ role: 'prime_director', weight: 1 }]);
    const rolesPatched = patched.map(d => d.role);
    expect(rolesPatched).toContain('user');
    expect(rolesPatched.some(r => r === 'auditor' || r === 'regulatory_authority')).toBe(true);
    expect(rolesPatched).not.toContain('prime_director');
  });
});
