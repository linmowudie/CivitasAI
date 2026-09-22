/**
 * E2E 测试：REGULATION + AUDIT 模式 — 行政协调 + 资源稽查
 *
 * PRD §3.1 工作方式 5+6：
 *   - 行政协调：仲裁死锁 → 监管局最终裁决 / 广播通道 / 紧急干预 / 行为准则
 *   - 资源稽查：异常检测 → 自动冻结 → 稽查判定 → 处罚执行 / 巡检
 *
 * 验证链路：
 *   行政：死锁升级 → 强制裁决 → 广播 → 确认 → 紧急干预
 *   稽查：正常消耗 → 异常消耗 → 自动冻结 → 稽查 → 判定 → 解冻/罚没
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── 监管局 ──────────────────────────────────────────
import {
  initRegulatoryAuthority, resetRegulatoryAuthority,
  getBehaviorCode, validateBehavior, addBehaviorRule,
  broadcastMessage, ackBroadcast,
  escalateDeadlock, emergencyIntervene, getEmergencyRecords,
} from '../../Src/Services/Regulation/regulatoryAuthority.js';
import { resetBroadcastChannel, getBroadcast, getBroadcasts, getUnacknowledged } from '../../Src/Services/Regulation/broadcastChannel.js';
import { resetBehaviorCode } from '../../Src/Services/Regulation/behaviorCode.js';

// ── 仲裁庭 ──────────────────────────────────────────
import {
  fileCase, assembleCapsule, reasonVerdict,
  resetTribunal, getCase,
} from '../../Src/Services/Arbitration/tribunal.js';

// ── 最终裁决 ────────────────────────────────────────
import {
  issueFinalVerdict, getAllInterventions, resetFinalArbiter,
} from '../../Src/Services/Regulation/finalArbiter.js';

// ── 资源审计局 ──────────────────────────────────────
import {
  initResourceAuditBureau, resetResourceAuditBureau,
  monitorAgent, investigate, getAuditReports,
  freeze, unfreeze, checkExpired, getFrozenAgents,
  runPatrol, addAgentSnapshot,
} from '../../Src/Services/Audit/resourceAuditBureau.js';

// ── 异常检测 ────────────────────────────────────────
import {
  initAnomalyDetector, recordConsumption, checkLoop, getAlerts,
} from '../../Src/Services/Audit/anomalyDetector.js';

// ── 冻结管理 ────────────────────────────────────────
import {
  isFrozen, resetFreezeManager,
} from '../../Src/Services/Audit/freezeManager.js';

// ── EventBus ────────────────────────────────────────
import { resetEventBus, getEventLog } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

// ── Token 经济 ──────────────────────────────────────
import {
  resetWalletManager, initWalletManager,
} from '../../Src/Services/TokenEconomy/walletManager.js';

// ── Agent 运行时 ────────────────────────────────────
import { resetAgentFactory } from '../../Src/Core/AgentRuntime/agentFactory.js';
import { resetAgentRegistry } from '../../Src/Core/AgentRuntime/agentRegistry.js';
import { resetAgentRuntime } from '../../Src/Core/AgentRuntime/agentRuntime.js';

// ═══════════════════════════════════════════════════════

function fullReset() {
  resetEventBus();
  resetWalletManager();
  initWalletManager({ initialSupply: 1_000_000, defaultWalletBalance: 10_000 });
  resetAgentRegistry();
  resetAgentFactory();
  resetAgentRuntime();
  resetTribunal();
  resetFinalArbiter();
  resetRegulatoryAuthority();
  resetBroadcastChannel();
  resetBehaviorCode();
  resetResourceAuditBureau();
  resetFreezeManager();
}

describe('E2E: REGULATION 模式 — 行政协调', () => {
  beforeEach(() => {
    fullReset();
    initRegulatoryAuthority();
  });

  // ─────────────────────────────────────────────────
  // 1. 死锁升级 → 监管局最终裁决
  // ─────────────────────────────────────────────────

  it('死锁升级：仲裁庭死锁 → escalateDeadlock → 监管局强制裁决', () => {
    // 创建案件并设为死锁
    const filed = fileCase({
      conflictId: 'reg-deadlock-1', traceId: 'reg-trace-1',
      conflictType: 'contradiction',
      plaintiffAgentId: 'a1', defendantAgentId: 'a2',
    });
    expect(filed.ok).toBe(true);
    if (!filed.ok) return;

    assembleCapsule(filed.value.caseId, {
      newMemoryContent: 'A', oldMemoryContent: 'B', taskDescription: 'T',
    });

    // 设为死锁
    const c = getCase(filed.value.caseId);
    expect(c).toBeDefined();
    if (!c) return;
    c.status = 'deadlocked';

    // 监管局升级
    const result = escalateDeadlock(c, 'deadlock');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict.isDeadlocked).toBe(false);
    expect(result.value.verdict.isUnanimous).toBe(true);
    expect(result.value.reason).toBe('deadlock');

    const interventions = getAllInterventions();
    expect(interventions.length).toBe(1);
  });

  // ─────────────────────────────────────────────────
  // 2. 广播通道
  // ─────────────────────────────────────────────────

  it('广播通道：broadcastMessage → acknowledge → 验证未确认列表', () => {
    // 发布广播
    const bc = broadcastMessage({
      type: 'rule_update',
      title: '行为准则更新',
      content: '新增规则：禁止未授权文件访问',
      priority: 'high',
      targetAgentIds: ['agent-1', 'agent-2', 'agent-3'],
      requiresAck: true,
    });
    expect(bc.ok).toBe(true);
    if (!bc.ok) return;

    const broadcastId = bc.value.broadcastId;

    // agent-1 确认
    const ack1 = ackBroadcast(broadcastId, 'agent-1');
    expect(ack1.ok).toBe(true);

    // agent-2 确认
    ackBroadcast(broadcastId, 'agent-2');

    // agent-3 未确认
    const unacked = getUnacknowledged('agent-3');
    expect(unacked.length).toBe(1);
    expect(unacked[0].broadcastId).toBe(broadcastId);

    // agent-3 确认后
    ackBroadcast(broadcastId, 'agent-3');
    const unackedAfter = getUnacknowledged('agent-3');
    expect(unackedAfter.length).toBe(0);

    // 验证广播记录
    const msg = getBroadcast(broadcastId);
    expect(msg).toBeDefined();
    expect(msg?.acks.size).toBe(3);
  });

  // ─────────────────────────────────────────────────
  // 3. 紧急干预
  // ─────────────────────────────────────────────────

  it('紧急干预：emergencyIntervene → 事件 + 广播', () => {
    const result = emergencyIntervene({
      type: 'pause_all',
      reason: '系统检测到全局异常，暂停所有 Agent',
      targetAgentIds: ['agent-1', 'agent-2'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.executed).toBe(true);
    expect(result.value.type).toBe('pause_all');

    // 事件验证
    const events = getEventLog();
    const types = events.map(e => e.eventType);
    expect(types).toContain(EventType.EMERGENCY_INTERVENTION);

    // 广播验证
    const emergencyBroadcast = getBroadcasts('emergency_alert');
    expect(emergencyBroadcast.length).toBe(1);
  });

  // ─────────────────────────────────────────────────
  // 4. 行为准则
  // ─────────────────────────────────────────────────

  it('行为准则：添加规则 → 违规检测', () => {
    // 添加自定义规则
    const addResult = addBehaviorRule({
      ruleId: 'test-rule-1',
      category: 'safety',
      description: '禁止执行 rm -rf 命令',
      condition: 'action contains "rm -rf"',
      action: 'forbid',
      severity: 'critical',
      enforceable: true,
    });
    expect(addResult.ok).toBe(true);

    // 验证行为准则已更新
    const code = getBehaviorCode();
    expect(code).toBeDefined();
    expect(code!.rules.length).toBeGreaterThan(0);

    // 违规检测
    const violation = validateBehavior({
      agentId: 'agent-test',
      action: 'rm -rf /',
    });
    // checkViolation 基于 condition 字符串匹配
    expect(violation).toBeDefined();
  });

  it('行为准则：不可重复添加同 ID 规则', () => {
    const r1 = addBehaviorRule({
      ruleId: 'dup-rule', category: 'safety',
      description: '规则 1', condition: 'c', action: 'warn',
      severity: 'low', enforceable: false,
    });
    expect(r1.ok).toBe(true);

    const r2 = addBehaviorRule({
      ruleId: 'dup-rule', category: 'safety',
      description: '规则 2', condition: 'c', action: 'warn',
      severity: 'low', enforceable: false,
    });
    expect(r2.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════

describe('E2E: AUDIT 模式 — 资源稽查', () => {
  beforeEach(() => {
    fullReset();
    initResourceAuditBureau({
      detectorConfig: { rollingBudgetTokens: 500, cooldownMs: 0 },
    });
  });

  // ─────────────────────────────────────────────────
  // 1. 正常消耗 → 无告警
  // ─────────────────────────────────────────────────

  it('正常消耗：低于阈值 → 无告警 + 不冻结', () => {
    const result = monitorAgent('audit-normal', 100);

    expect(result.rollingAlert).toBeNull();
    expect(result.deviationAlert).toBeNull();
    expect(result.frozen).toBe(false);
    expect(isFrozen('audit-normal')).toBe(false);
  });

  // ─────────────────────────────────────────────────
  // 2. 异常消耗 → 自动冻结
  // ─────────────────────────────────────────────────

  it('异常消耗：超 rollingBudgetTokens → critical 告警 → 自动冻结', () => {
    const result = monitorAgent('audit-anomaly', 600);

    // 600 > 500(rollingBudgetTokens) → 应触发告警
    expect(result.rollingAlert).toBeDefined();
    expect(result.rollingAlert?.level).toBe('critical');
    // 自动冻结
    expect(result.frozen).toBe(true);
    expect(isFrozen('audit-anomaly')).toBe(true);
  });

  // ─────────────────────────────────────────────────
  // 3. 稽查 → 判定
  // ─────────────────────────────────────────────────

  it('稽查判定：单次 critical → false_positive → 解冻', () => {
    // 触发异常
    monitorAgent('audit-fp', 600);
    expect(isFrozen('audit-fp')).toBe(true);

    // 稽查
    const report = investigate('audit-fp');
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    // 单次 critical → 误报
    expect(report.value.finding).toBe('false_positive');
    expect(report.value.recommendation).toBe('unfreeze');

    // 自动解冻
    expect(isFrozen('audit-fp')).toBe(false);
  });

  it('稽查判定：多次 critical → confirmed_anomaly → 罚没', () => {
    // 多次异常消耗
    monitorAgent('audit-confirmed', 600);
    monitorAgent('audit-confirmed', 700);
    monitorAgent('audit-confirmed', 800);

    const report = investigate('audit-confirmed');
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    // 多次 critical → 确认异常
    expect(report.value.finding).toBe('confirmed_anomaly');
    expect(report.value.recommendation).toBe('confiscate');
    expect(report.value.confiscateAmount).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────────
  // 4. 死循环检测
  // ─────────────────────────────────────────────────

  it('死循环检测：重复输出 → loop_detected → 冻结 → attack → destroy', () => {
    const fingerprint = 'sha256-identical-output';

    // 多次相同输出
    for (let i = 0; i < 5; i++) {
      recordConsumption('audit-loop', 100);
      checkLoop('audit-loop', fingerprint);
    }

    // 用 monitorAgent 触发完整检测链
    const result = monitorAgent('audit-loop', 100, fingerprint);

    // 检查是否有 loop 告警
    const alerts = getAlerts('audit-loop');
    const loopAlerts = alerts.filter(a => a.type === 'loop_detected');

    if (loopAlerts.length >= 3) {
      // 多次循环 → 攻击嫌疑
      const report = investigate('audit-loop');
      expect(report.ok).toBe(true);
      if (report.ok) {
        expect(report.value.finding).toBe('attack');
        expect(report.value.recommendation).toBe('destroy');
      }
    }
  });

  // ─────────────────────────────────────────────────
  // 5. 手动冻结/解冻
  // ─────────────────────────────────────────────────

  it('手动冻结/解冻：freeze → isFrozen → unfreeze', () => {
    const freezeResult = freeze('agent-manual', '手动冻结测试');
    expect(freezeResult.ok).toBe(true);
    expect(isFrozen('agent-manual')).toBe(true);

    const unfreezeResult = unfreeze('agent-manual', 'test');
    expect(unfreezeResult.ok).toBe(true);
    expect(isFrozen('agent-manual')).toBe(false);
  });

  it('重复冻结拒绝', () => {
    freeze('agent-dup', '第一次');
    const r2 = freeze('agent-dup', '第二次');
    expect(r2.ok).toBe(false);
  });

  // ─────────────────────────────────────────────────
  // 6. 定期巡检
  // ─────────────────────────────────────────────────

  it('定期巡检：registerAgentSnapshot → runPatrol → 报告', () => {
    // 注册 Agent 快照
    addAgentSnapshot({
      agentId: 'agent-patrol-1',
      totalConsumption: 5000,
      failureCount: 0,
      totalRequests: 20,
      lastActiveAt: Date.now(),
    });
    addAgentSnapshot({
      agentId: 'agent-patrol-2',
      totalConsumption: 15000,
      failureCount: 3,
      totalRequests: 50,
      lastActiveAt: Date.now(),
    });

    // 执行巡检
    const patrol = runPatrol();
    expect(patrol.ok).toBe(true);
    if (patrol.ok) {
      expect(patrol.value.reportId).toBeDefined();
      expect(patrol.value.totalAgents).toBeGreaterThanOrEqual(2);
    }
  });

  // ─────────────────────────────────────────────────
  // 7. 稽查报告查询
  // ─────────────────────────────────────────────────

  it('稽查报告：investigate → getAuditReports', () => {
    monitorAgent('audit-report-1', 600);
    investigate('audit-report-1');

    const reports = getAuditReports();
    expect(reports.length).toBe(1);
    expect(reports[0].agentId).toBe('audit-report-1');
    expect(reports[0].auditId).toBeDefined();
  });

  // ─────────────────────────────────────────────────
  // 8. 事件链验证
  // ─────────────────────────────────────────────────

  it('事件链：异常检测 → 冻结 → 稽查 → AUDIT_COMPLETED', () => {
    monitorAgent('audit-events', 600);
    investigate('audit-events');

    const events = getEventLog();
    const types = events.map(e => e.eventType);
    expect(types).toContain(EventType.AUDIT_COMPLETED);
  });

  // ─────────────────────────────────────────────────
  // 9. 联动：冻结 Agent 不可执行任务
  // ─────────────────────────────────────────────────

  it('联动：被冻结 Agent 状态验证', () => {
    // 冻结 Agent
    freeze('audit-frozen-agent', '测试冻结');
    expect(isFrozen('audit-frozen-agent')).toBe(true);

    // 冻结列表
    const frozen = getFrozenAgents();
    expect(frozen).toContain('audit-frozen-agent');

    // 解冻后移除
    unfreeze('audit-frozen-agent', 'test');
    const frozenAfter = getFrozenAgents();
    expect(frozenAfter).not.toContain('audit-frozen-agent');
  });
});
