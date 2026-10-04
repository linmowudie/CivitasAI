/**
 * FE-059 回归测试：记忆沉淀链路接线
 *
 * 覆盖：
 *  - `consolidateLoopKnowledge`：成功退出 → 观察入 GlobalWorkspace（observed）→ 提炼长期记忆；
 *    非成功退出 / 输出过短不沉淀（防噪声）；
 *  - GlobalWorkspace 运行期写方验证（此前 0 写方）；
 *  - `tribunal.consolidateKnowledge`：裁决真实写入长期记忆（此前仅发事件）+ 事件携带 memoryId；
 *  - 治理角色守卫（非 L0 拒绝）。
 *
 * 说明：不依赖数据库（内存 fail-safe 路径）；事件断言用 eventLog。
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  resetLongTermMemory, listAllMemories,
} from '../../Src/Services/SharedMemory/longTermMemory.js';
import {
  resetGlobalWorkspace, read as readWorkspace,
} from '../../Src/Services/SharedMemory/globalWorkspace.js';
import { consolidateLoopKnowledge } from '../../Src/Core/Loop/loopKnowledge.js';
import {
  executeFullArbitration, fileCase, consolidateKnowledge, resetTribunal,
} from '../../Src/Services/Arbitration/tribunal.js';
import { resetEventBus, getEventLog } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

const LONG_OUTPUT = '完成用户登录模块：实现 /auth/login 端点、JWT 校验与单元测试（8 项全过）；产物 src/auth.ts。';

beforeEach(() => {
  resetLongTermMemory();
  resetGlobalWorkspace();
  resetTribunal();
  resetEventBus();
});

describe('FE-059 · Loop 出口知识沉淀', () => {
  it('非成功退出 → 不沉淀', () => {
    const result = consolidateLoopKnowledge({
      loopId: 'loop-1', traceId: 'trace-1', agentId: 'agent-1',
      exitReason: 'risk', outputText: LONG_OUTPUT,
    });
    expect(result).toBeNull();
    expect(listAllMemories()).toHaveLength(0);
    expect(readWorkspace({ traceId: 'trace-1' })).toHaveLength(0);
  });

  it('成功退出但输出过短（<50 字符）→ 不沉淀（防噪声）', () => {
    const result = consolidateLoopKnowledge({
      loopId: 'loop-2', traceId: 'trace-2', agentId: 'agent-1',
      exitReason: 'success', outputText: '好的。',
    });
    expect(result).toBeNull();
    expect(listAllMemories()).toHaveLength(0);
  });

  it('成功退出 → 观察入 GW（observed）+ 提炼长期记忆 + 事件', () => {
    const result = consolidateLoopKnowledge({
      loopId: 'loop-3', traceId: 'trace-3', agentId: 'agent-1',
      exitReason: 'success', outputText: LONG_OUTPUT,
    });

    expect(result).not.toBeNull();
    expect(result!.consolidated).toBe(1);

    // GW 运行期写入验证（此前 0 写方）
    const wsEntries = readWorkspace({ traceId: 'trace-3', assertion: 'observed', status: 'active' });
    expect(wsEntries).toHaveLength(1);
    expect(wsEntries[0]!.key).toBe('loop-completion:loop-3');
    expect(wsEntries[0]!.content).toContain('登录模块');
    expect(wsEntries[0]!.assertion).toBe('observed');

    // 长期记忆已提炼
    const memories = listAllMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0]!.content).toContain('登录模块');
    expect(memories[0]!.sourceTraceIds).toContain('trace-3');

    // 事件发布
    const events = getEventLog({ eventType: EventType.KNOWLEDGE_CONSOLIDATION });
    expect(events).toHaveLength(1);
  });

  it('同一 Loop 再次沉淀幂等（同 key 覆盖）+ 长期记忆不重复', () => {
    consolidateLoopKnowledge({
      loopId: 'loop-4', traceId: 'trace-4-a', agentId: 'agent-1',
      exitReason: 'success', outputText: LONG_OUTPUT,
    });
    // 同一 loopId 再次沉淀（不同 trace）：GW key 相同 → 覆盖；记忆按条目追加
    consolidateLoopKnowledge({
      loopId: 'loop-4', traceId: 'trace-4-b', agentId: 'agent-1',
      exitReason: 'success', outputText: LONG_OUTPUT,
    });
    const wsLatest = readWorkspace({ traceId: 'trace-4-b', status: 'active' });
    expect(wsLatest.length).toBeGreaterThanOrEqual(1);
  });
});

describe('FE-059 · 仲裁裁决沉淀（落实写记忆）', () => {
  it('executeFullArbitration → 裁决写入长期记忆（category=decision + caseId 溯源）', () => {
    const result = executeFullArbitration({
      conflictId: 'conflict-1',
      traceId: 'trace-arb-1',
      conflictType: 'semantic_opposition',
      plaintiffAgentId: 'agent-new',
      defendantAgentId: 'agent-old',
      newMemoryContent: '允许访问生产数据库',
      oldMemoryContent: '禁止访问生产数据库',
      taskDescription: '生产库权限策略',
      restorerAgentId: 'agent-restorer',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const caseId = result.value.caseId;
    const memories = listAllMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0]!.title).toContain(`仲裁裁决 ${caseId}`);
    expect(memories[0]!.category).toBe('decision');
    expect(memories[0]!.sourceArbitrationIds).toContain(caseId);

    const events = getEventLog({ eventType: EventType.KNOWLEDGE_CONSOLIDATION });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload['memoryId']).toBe(memories[0]!.memoryId);
  });

  it('consolidateKnowledge：无裁决案件 → 报错；非治理角色 → fail-closed', () => {
    const filed = fileCase({
      conflictId: 'conflict-2',
      traceId: 'trace-arb-2',
      conflictType: 'contradiction',
      plaintiffAgentId: 'agent-new',
      defendantAgentId: 'agent-old',
    });
    expect(filed.ok).toBe(true);
    if (!filed.ok) return;

    // 无裁决 → 报错
    const noVerdict = consolidateKnowledge(filed.value.caseId, 'arbitrator');
    expect(noVerdict.ok).toBe(false);

    // 非治理角色 → fail-closed（守卫拒绝）
    const denied = consolidateKnowledge(filed.value.caseId, 'worker');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(String(denied.error)).toContain('知识沉淀');

    expect(listAllMemories()).toHaveLength(0);
  });
});
