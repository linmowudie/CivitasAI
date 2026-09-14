/**
 * S14 E2E 测试：冲突仲裁端到端
 *
 * 验证冲突检测 → 仲裁 → 裁决 → 恢复 → 知识沉淀完整链路。
 * 跨模块集成：WriteGuard → Tribunal → FinalArbiter → AuditBureau。
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── Tribunal ────────────────────────────────────────
import {
  fileCase, assembleCapsule, reasonVerdict, issueSuspension,
  createRestorationPlan, completeRestoration, consolidateKnowledge,
  executeFullArbitration, getCase, getCaseByConflictId,
  resetTribunal,
} from '../../Src/Services/Arbitration/tribunal.js';

// ── FinalArbiter ────────────────────────────────────
import {
  issueFinalVerdict, getAllInterventions, resetFinalArbiter,
} from '../../Src/Services/Regulation/finalArbiter.js';

// ── AuditBureau ─────────────────────────────────────
import {
  initResourceAuditBureau, monitorAgent, investigate,
  resetResourceAuditBureau,
} from '../../Src/Services/Audit/resourceAuditBureau.js';

// ── FreezeManager ───────────────────────────────────
import {
  isFrozen, resetFreezeManager,
} from '../../Src/Services/Audit/freezeManager.js';

// ── EventBus ────────────────────────────────────────
import { resetEventBus, getEventLog } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

describe('E2E: 冲突仲裁端到端', () => {
  beforeEach(() => {
    resetTribunal();
    resetFinalArbiter();
    resetResourceAuditBureau();
    resetFreezeManager();
    resetEventBus();
  });

  it('完整冲突链路：检测 → 立案 → 裁决 → 挂起 → 恢复 → 沉淀', () => {
    const result = executeFullArbitration({
      conflictId: 'e2e-conflict-1',
      traceId: 'e2e-trace-1',
      conflictType: 'semantic_opposition',
      plaintiffAgentId: 'agent-new',
      defendantAgentId: 'agent-old',
      newMemoryContent: 'API 端口 3000',
      oldMemoryContent: 'API 端口 8080',
      taskDescription: '配置 Web 服务器',
      restorerAgentId: 'agent-restorer',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const c = result.value;
      expect(c.status).toBe('completed');
      expect(c.finalVerdict).toBeDefined();
      expect(c.finalVerdict!.verdict).toBe('new_wins');
      expect(c.suspendIssued).toBe(true);
      expect(c.restoredAt).toBeDefined();
    }

    // 验证事件链
    const events = getEventLog();
    const types = events.map(e => e.eventType);
    expect(types).toContain(EventType.ARBITRATION_FILED);
    expect(types).toContain(EventType.ARBITRATION_VERDICT);
    expect(types).toContain(EventType.SUSPEND_AND_NOTIFY);
    expect(types).toContain(EventType.RESTORATION_ACK);
    expect(types).toContain(EventType.KNOWLEDGE_CONSOLIDATION);
  });

  it('死锁升级：3 种不同裁决 → 监管局强制裁决', () => {
    // 立案 + 胶囊
    const filed = fileCase({
      conflictId: 'deadlock-e2e',
      traceId: 'dl-trace-1',
      conflictType: 'contradiction',
      plaintiffAgentId: 'a1',
      defendantAgentId: 'a2',
    });
    expect(filed.ok).toBe(true);
    if (!filed.ok) return;

    assembleCapsule(filed.value.caseId, {
      newMemoryContent: 'A', oldMemoryContent: 'B', taskDescription: 'T',
    });

    // 手动设为死锁
    const c = getCase(filed.value.caseId);
    if (!c) return;
    c.status = 'deadlocked';

    // 监管局介入
    const intervention = issueFinalVerdict({
      case_: c,
      reason: 'deadlock',
    });
    expect(intervention.ok).toBe(true);
    if (intervention.ok) {
      expect(intervention.value.verdict.isDeadlocked).toBe(false);
    }

    // 验证干预记录
    const interventions = getAllInterventions();
    expect(interventions.length).toBe(1);
  });

  it('审计联动：异常 Agent 被冻结 → 稽查 → 解冻', () => {
    initResourceAuditBureau({
      detectorConfig: { rollingBudgetTokens: 500, cooldownMs: 0 },
    });

    // Agent 消耗超预算 → 自动冻结
    const monitor = monitorAgent('audit-e2e-agent', 600);
    expect(monitor.frozen).toBe(true);
    expect(isFrozen('audit-e2e-agent')).toBe(true);

    // 稽查 → 误报 → 解冻
    const audit = investigate('audit-e2e-agent');
    expect(audit.ok).toBe(true);
    expect(isFrozen('audit-e2e-agent')).toBe(false);
  });

  it('多案件并行：同时处理多个冲突', () => {
    const r1 = executeFullArbitration({
      conflictId: 'multi-1', traceId: 't-m1',
      conflictType: 'semantic_opposition',
      plaintiffAgentId: 'a1', defendantAgentId: 'a2',
      newMemoryContent: 'X', oldMemoryContent: 'Y',
      taskDescription: 'T1', restorerAgentId: 'a-r',
    });
    expect(r1.ok).toBe(true);

    const r2 = executeFullArbitration({
      conflictId: 'multi-2', traceId: 't-m2',
      conflictType: 'contradiction',
      plaintiffAgentId: 'a3', defendantAgentId: 'a4',
      newMemoryContent: 'P', oldMemoryContent: 'Q',
      taskDescription: 'T2', restorerAgentId: 'a-r',
    });
    expect(r2.ok).toBe(true);

    // 两个案件都完成
    const c1 = getCaseByConflictId('multi-1');
    const c2 = getCaseByConflictId('multi-2');
    expect(c1?.status).toBe('completed');
    expect(c2?.status).toBe('completed');
  });
});
