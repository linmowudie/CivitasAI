/**
 * FE-060 / FE-061 / FE-062 回归测试：治理执法域接线
 *
 * 覆盖：
 *  - FE-060 行为法典：初始化可查、tool.forbid 可执行语法经工具安全门真实阻断、
 *    前缀通配、守卫（非治理角色拒立法）、未初始化放行、移除规则恢复；
 *  - FE-061 审计：审计周期（快照刷新 → 巡检报告 → 冻结到期解冻）、
 *    冻结的执行效力（前置监管拒冻结 Agent）；
 *  - FE-062 仲裁：GlobalWorkspace 语义冲突 → CONFLICT_DETECTED → 六步闭环自动仲裁
 *    → 裁决应用（旧条目废弃 + 新内容落定）；接线注销后不再自动仲裁。
 *
 * 说明：行为法典拒绝路径在 DB 操作之前（无需数据库）；仲裁/审计用例不依赖网络。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  initBehaviorCode, resetBehaviorCode, getCurrentCode as getBehaviorCode,
  addRule, removeRule,
} from '../../Src/Services/Regulation/behaviorCode.js';
import { createToolSafetyGateMiddleware } from '../../Src/Services/LoopControl/middleware/toolSafetyGate.js';
import { registerTool, clearRegistry } from '../../Src/Tools/Registry/toolRegistry.js';
import { contentOutputSchema } from '../../Src/Tools/Builtin/_shared.js';
import type { ToolDefinition } from '../../Src/Tools/Traits/toolSpec.js';
import type { MiddlewareContext, ToolCallInput, ToolCallOutput } from '../../Src/Infra/Contracts/middlewareTypes.js';

import {
  initArbitrationWiring, stopArbitrationWiring,
} from '../../Src/Services/Arbitration/arbitrationWiring.js';
import {
  write as writeWorkspace, read as readWorkspace, resetGlobalWorkspace,
} from '../../Src/Services/SharedMemory/globalWorkspace.js';
import { resetTribunal, getAllCases } from '../../Src/Services/Arbitration/tribunal.js';
import { resetLongTermMemory } from '../../Src/Services/SharedMemory/longTermMemory.js';
import { resetEventBus, getEventLog } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

import { runAuditCycle } from '../../Src/Services/Audit/auditScheduler.js';
import { resetFreezeManager, freezeAgent, setAutoUnfreezeSec, isFrozen } from '../../Src/Services/Audit/freezeManager.js';
import { resetPatrolScheduler, getReports } from '../../Src/Services/Audit/patrolScheduler.js';
import { resetAnomalyDetector } from '../../Src/Services/Audit/anomalyDetector.js';
import { resetResourceAuditBureau } from '../../Src/Services/Audit/resourceAuditBureau.js';
import { runPreSupervision } from '../../Src/Services/Supervision/preSupervision.js';

import { createAgent, resetAgentFactory } from '../../Src/Core/AgentRuntime/agentFactory.js';
import { resetAgentRegistry, updateAgent } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import { resetWalletManager, initWalletManager } from '../../Src/Services/TokenEconomy/walletManager.js';
import type { RateLimitConfig } from '../../Src/Infra/Contracts/rateLimitTypes.js';

// ── 脚手架 ──────────────────────────────────────────────────────────

const RATE_CFG: RateLimitConfig = {
  maxRequestsPerMinute: 100, maxTokensPerMinute: 100_000,
  maxToolCallsPerMinute: 100, burstAllowance: 0,
};

const OK_OUTPUT: ToolCallOutput = { status: 'success', content: 'executed', recoverable: false };

function makeTool(name: string): ToolDefinition {
  return {
    spec: {
      name,
      version: '0.1.0',
      description: '测试工具',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      outputSchema: contentOutputSchema('{ ok }'),
      dangerLevel: 'SAFE',
      idempotency: 'NO',
      reversibility: 'REVERSIBLE',
      sideEffectScope: 'none',
      requiredRoles: ['prime_director', 'worker'],
      sandboxMode: 'none',
      timeoutMs: 1000,
    },
    async execute() { return OK_OUTPUT; },
  };
}

function makeCtx(): MiddlewareContext {
  return { agentId: 'agent-gov-1', agentRole: 'worker', sessionId: 'sess-gov-1', iteration: 1, traceId: 'trace-gov-1', data: {} };
}

function makeAgent(): string {
  const agent = createAgent({ role: 'worker', model: 'test-model' }, 'trace-gov-1');
  if (!agent.ok) throw new Error('创建 Agent 失败');
  return agent.value.agentId;
}

const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  resetBehaviorCode();
  clearRegistry();
  resetEventBus();
  resetGlobalWorkspace();
  resetTribunal();
  resetLongTermMemory();
  resetFreezeManager();
  resetPatrolScheduler();
  resetAnomalyDetector();
  resetResourceAuditBureau();
  resetAgentRegistry();
  resetAgentFactory();
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  stopArbitrationWiring();
});

afterEach(() => {
  stopArbitrationWiring();
  clearRegistry();
});

// ═══════════════════════════════════════════════════════════════════
// FE-060 · 行为法典（工具安全门可执行）
// ═══════════════════════════════════════════════════════════════════

describe('FE-060 · 行为法典执行（tool.forbid）', () => {
  it('初始化后规则集可查（默认 5 条）', () => {
    initBehaviorCode();
    const code = getBehaviorCode();
    expect(code).not.toBeNull();
    expect(code!.version).toBe('1.0.0');
    expect(code!.rules.length).toBeGreaterThanOrEqual(5);
  });

  it('tool.forbid(shell.exec) 规则 → 安全门真实阻断（不执行 + 携带规则依据）', async () => {
    initBehaviorCode();
    const added = addRule({
      ruleId: 'gov-forbid-shell',
      category: 'safety',
      description: '禁止执行 shell 命令（演练封禁）',
      condition: 'tool.forbid(shell.exec)',
      action: 'forbid',
      severity: 'critical',
      enforceable: true,
    }, 'arbitrator');
    expect(added.ok).toBe(true);

    registerTool(makeTool('shell.exec'));
    const mw = createToolSafetyGateMiddleware(() => 'loop-gov-1', () => 1, () => 'trace-gov-1');
    const input: ToolCallInput = { toolName: 'shell.exec', arguments: {}, toolCallId: 'tc-forbid' };
    let executed = false;
    const next = async () => { executed = true; return OK_OUTPUT; };

    const out = await (mw.execute as Function)(makeCtx(), input, next) as ToolCallOutput;
    expect(executed).toBe(false);
    expect(out.status).toBe('error');
    expect(out.recoverable).toBe(false);
    expect(String(out.content)).toContain('gov-forbid-shell');
    expect(String(out.content)).toContain('禁止执行 shell 命令');
  });

  it('前缀通配 tool.forbid(shell.*) 同样生效；未命中规则的工具透传', async () => {
    initBehaviorCode();
    addRule({
      ruleId: 'gov-forbid-shell-family',
      category: 'safety',
      description: '封禁 shell 家族',
      condition: 'tool.forbid(shell.*)',
      action: 'forbid',
      severity: 'high',
      enforceable: true,
    }, 'arbitrator');

    registerTool(makeTool('shell.exec'));
    registerTool(makeTool('file.read'));
    const mw = createToolSafetyGateMiddleware(() => 'loop-gov-2', () => 1, () => 'trace-gov-2');

    let blockedExecuted = false;
    const blocked = await (mw.execute as Function)(
      makeCtx(),
      { toolName: 'shell.exec', arguments: {}, toolCallId: 'tc-1' } as ToolCallInput,
      async () => { blockedExecuted = true; return OK_OUTPUT; },
    ) as ToolCallOutput;
    expect(blockedExecuted).toBe(false);
    expect(blocked.status).toBe('error');

    let passedExecuted = false;
    const passed = await (mw.execute as Function)(
      makeCtx(),
      { toolName: 'file.read', arguments: {}, toolCallId: 'tc-2' } as ToolCallInput,
      async () => { passedExecuted = true; return OK_OUTPUT; },
    ) as ToolCallOutput;
    expect(passedExecuted).toBe(true);
    expect(passed.status).toBe('success');
  });

  it('移除规则后执行恢复；未初始化行为准则时放行（规则驱动语义）', async () => {
    initBehaviorCode();
    addRule({
      ruleId: 'gov-temp', category: 'safety', description: '临时封禁',
      condition: 'tool.forbid(dir.list)', action: 'forbid', severity: 'medium', enforceable: true,
    }, 'arbitrator');
    registerTool(makeTool('dir.list'));
    const mw = createToolSafetyGateMiddleware(() => 'loop-gov-3', () => 1, () => 'trace-gov-3');
    const input: ToolCallInput = { toolName: 'dir.list', arguments: {}, toolCallId: 'tc-3' };

    const first = await (mw.execute as Function)(makeCtx(), input, async () => OK_OUTPUT) as ToolCallOutput;
    expect(first.status).toBe('error');

    const removed = removeRule('gov-temp', 'arbitrator');
    expect(removed.ok).toBe(true);
    const second = await (mw.execute as Function)(makeCtx(), input, async () => OK_OUTPUT) as ToolCallOutput;
    expect(second.status).toBe('success');

    resetBehaviorCode(); // 未初始化
    const third = await (mw.execute as Function)(makeCtx(), input, async () => OK_OUTPUT) as ToolCallOutput;
    expect(third.status).toBe('success');
  });

  it('非治理角色立法被拒（fail-closed 守卫）', () => {
    initBehaviorCode();
    const denied = addRule({
      ruleId: 'gov-worker-rule', category: 'safety', description: 'worker 不该能加',
      condition: 'tool.forbid(file.write)', action: 'forbid', severity: 'low', enforceable: true,
    }, 'worker');
    expect(denied.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// FE-061 · 审计周期与冻结效力
// ═══════════════════════════════════════════════════════════════════

describe('FE-061 · 审计周期', () => {
  it('runAuditCycle：出快照 + 巡检报告（PATROL_REPORT 事件）', () => {
    const agentId = makeAgent();
    // 注入失败标记 → 巡检应标记（failureRate = 1/1 > 0.3）
    updateAgent(agentId, { consecutiveFailures: 1 });

    const cycle = runAuditCycle();
    expect(cycle.snapshots).toBeGreaterThanOrEqual(1);
    expect(cycle.patrol).toBeDefined();
    expect(cycle.patrol!.totalAgents).toBeGreaterThanOrEqual(1);
    expect(cycle.patrol!.flaggedAgents.some(f => f.agentId === agentId)).toBe(true);

    const events = getEventLog({ eventType: EventType.PATROL_REPORT });
    expect(events).toHaveLength(1);
    const reports = getReports();
    expect(reports.length).toBeGreaterThanOrEqual(1);
  });

  it('冻结到期 → 审计周期自动解冻', () => {
    const agentId = makeAgent();
    setAutoUnfreezeSec(0); // 立即到期
    const frozen = freezeAgent(agentId, '测试冻结', 'auditor');
    expect(frozen.ok).toBe(true);
    expect(isFrozen(agentId)).toBe(true);

    const cycle = runAuditCycle();
    expect(cycle.expiredFreezes).toContain(agentId);
    expect(isFrozen(agentId)).toBe(false);
  });

  it('冻结的执行效力：前置监管拒绝冻结 Agent（AGENT_FROZEN）', () => {
    const agentId = makeAgent();
    setAutoUnfreezeSec(3600);
    freezeAgent(agentId, '审计调查', 'auditor');

    const result = runPreSupervision(
      { userInput: '继续任务', agentId, sessionId: 's', recentCallTimestamps: [] },
      RATE_CFG,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.passed).toBe(false);
    expect(result.value.permissionOk).toBe(false);
    expect(result.value.rejectReason).toContain('AGENT_FROZEN');
  });

  it('非治理角色冻结被拒（守卫）', () => {
    const agentId = makeAgent();
    const denied = freezeAgent(agentId, '越权冻结', 'worker');
    expect(denied.ok).toBe(false);
    expect(isFrozen(agentId)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// FE-062 · 语义冲突自动仲裁闭环
// ═══════════════════════════════════════════════════════════════════

describe('FE-062 · CONFLICT_DETECTED → 六步闭环', () => {
  it('GW 语义冲突 → 自动仲裁 → 裁决应用（旧条目废弃 + 新内容落定）', async () => {
    initArbitrationWiring();

    // ① 先落定旧内容（active 基线）
    const first = writeWorkspace({
      key: 'arb.verify.key',
      content: '允许访问生产数据库',
      contentType: 'fact',
      assertion: 'observed',
      traceId: 'trace-arb-1',
      agentId: 'agent-old',
    });
    expect(first.ok).toBe(true);

    // ② 反向极性同命题写入 → 语义冲突被阻止 + CONFLICT_DETECTED
    const second = writeWorkspace({
      key: 'arb.verify.key',
      content: '禁止访问生产数据库',
      contentType: 'fact',
      assertion: 'observed',
      traceId: 'trace-arb-2',
      agentId: 'agent-new',
    });
    expect(second.ok).toBe(false);
    expect(String(second.error)).toContain('语义冲突');

    // ③ 事件异步分发 → 等待自动仲裁完成
    await flushAsync();
    await flushAsync();

    const cases = getAllCases();
    expect(cases.length).toBeGreaterThanOrEqual(1);
    const c = cases[0]!;
    console.log(`[FE-062] case=${c.caseId} status=${c.status} verdict=${c.finalVerdict?.verdict}`);

    expect(c.status).toBe('completed');
    expect(c.finalVerdict).toBeDefined();

    // ④ 裁决应用：new_wins → 旧条目废弃 + 新内容以仲裁者身份落定
    if (c.finalVerdict!.verdict === 'new_wins') {
      const active = readWorkspace({ key: 'arb.verify.key', status: 'active' });
      expect(active.length).toBe(1);
      expect(active[0]!.content).toBe('禁止访问生产数据库');
      expect(active[0]!.agentId).toBe('arbitrator:tribunal');
    } else {
      // 其他裁决（规则引擎边界）：旧内容保持（不应用）
      const active = readWorkspace({ key: 'arb.verify.key', status: 'active' });
      expect(active.length).toBe(1);
      expect(active[0]!.content).toBe('允许访问生产数据库');
    }
  });

  it('接线注销后冲突不再自动仲裁（stopArbitrationWiring）', async () => {
    initArbitrationWiring();
    stopArbitrationWiring();

    writeWorkspace({
      key: 'arb.verify.key2', content: '允许访问生产数据库', contentType: 'fact',
      assertion: 'observed', traceId: 't1', agentId: 'agent-old',
    });
    const second = writeWorkspace({
      key: 'arb.verify.key2', content: '禁止访问生产数据库', contentType: 'fact',
      assertion: 'observed', traceId: 't2', agentId: 'agent-new',
    });
    expect(second.ok).toBe(false); // 冲突仍被阻止（写入守卫）

    await flushAsync();
    await flushAsync();
    expect(getAllCases()).toHaveLength(0); // 无自动立案
  });

  it('文件冲突来源（无记忆原文）不触发自动仲裁', async () => {
    initArbitrationWiring();
    const { publish, createEvent } = await import('../../Src/Services/EventBus/eventBus.js');
    publish(createEvent({
      eventType: EventType.CONFLICT_DETECTED,
      source: 'Decision/Orchestrator/conflictPrecheck',
      payload: { taskId: 't-1', conflictCount: 1, conflicts: [{ file: 'src/a.ts', agents: ['a', 'b'] }] },
    }));

    await flushAsync();
    await flushAsync();
    expect(getAllCases()).toHaveLength(0);
  });
});
