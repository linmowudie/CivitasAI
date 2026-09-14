/**
 * S8 事件总线与共享记忆测试——Gate G8 验证
 *
 * 覆盖：
 * - EventBus（发布/订阅/幂等/waitFor/事件日志）
 * - SharedMemory（GlobalWorkspace 乐观锁/版本冲突/红线/assertion 过滤）
 * - LongTermMemory（observed 可入/inferred 拒绝）
 * - LoopScheduler（去重/熔断）
 * - Gate G8 综合验证
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── EventBus ─────────────────────────────────────────
import {
  initEventBus, publish, subscribe, subscribeMany,
  createEvent, getEventLog, getSubscriberCount, getEventCount,
  resetEventBus,
} from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';
import type { DomainEvent } from '../../Src/Services/EventBus/eventTypes.js';

// ── SharedMemory ─────────────────────────────────────
import {
  write, read, resetGlobalWorkspace, getEntryCount,
} from '../../Src/Services/SharedMemory/globalWorkspace.js';
import {
  isForbiddenKey, isEligibleForLongTerm,
} from '../../Src/Services/SharedMemory/writeGuard.js';

// ── LongTermMemory ───────────────────────────────────
import {
  writeMemory, searchMemory, getMemoryCount, resetLongTermMemory,
} from '../../Src/Services/SharedMemory/longTermMemory.js';

// ── LoopScheduler ────────────────────────────────────
import {
  initDedupStore, checkDedup, resetDedupStore,
} from '../../Src/Services/LoopScheduler/dedupStore.js';
import {
  initCircuitBreaker, checkBreaker, isTripped, resetCircuitBreaker,
} from '../../Src/Services/LoopScheduler/circuitBreaker.js';
import { scheduleLoop } from '../../Src/Services/LoopScheduler/scheduler.js';

// ── CausalTokens ─────────────────────────────────────
import {
  happensBefore, isConcurrent, incrementClock, mergeClocks,
} from '../../Src/Services/SharedMemory/causalTokens.js';

// ═══════════════════════════════════════════════════════
// 1. EventBus
// ═══════════════════════════════════════════════════════

describe('S8 · EventBus', () => {
  beforeEach(() => {
    resetEventBus();
    initEventBus();
  });

  it('发布/订阅：基本分发', async () => {
    const received: DomainEvent[] = [];
    subscribe(EventType.TASK_STARTED, (e) => { received.push(e); });

    const event = createEvent({
      eventType: EventType.TASK_STARTED,
      source: 'test',
      payload: { taskId: 't1' },
    });
    publish(event);

    // 异步分发，等一帧
    await new Promise(r => setTimeout(r, 10));
    expect(received.length).toBe(1);
    expect(received[0].eventType).toBe(EventType.TASK_STARTED);
  });

  it('消费者幂等：同 eventId 重复发布只处理一次', async () => {
    let count = 0;
    subscribe(EventType.TASK_COMPLETED, () => { count++; });

    const event = createEvent({
      eventType: EventType.TASK_COMPLETED,
      source: 'test',
    });
    publish(event);
    publish(event); // 重复
    publish(event); // 再次重复

    await new Promise(r => setTimeout(r, 10));
    expect(count).toBe(1);
  });

  it('subscribeMany：订阅多种事件', async () => {
    let count = 0;
    subscribeMany([EventType.TASK_STARTED, EventType.TASK_COMPLETED], () => { count++; });

    publish(createEvent({ eventType: EventType.TASK_STARTED, source: 'test' }));
    publish(createEvent({ eventType: EventType.TASK_COMPLETED, source: 'test' }));
    publish(createEvent({ eventType: EventType.TASK_FAILED, source: 'test' })); // 不匹配

    await new Promise(r => setTimeout(r, 10));
    expect(count).toBe(2);
  });

  it('事件日志查询', () => {
    publish(createEvent({ eventType: EventType.TASK_STARTED, source: 'test', traceId: 'trace-1' }));
    publish(createEvent({ eventType: EventType.TASK_COMPLETED, source: 'test', traceId: 'trace-1' }));
    publish(createEvent({ eventType: EventType.TASK_FAILED, source: 'test', traceId: 'trace-2' }));

    expect(getEventCount()).toBe(3);
    expect(getEventLog({ traceId: 'trace-1' }).length).toBe(2);
    expect(getEventLog({ eventType: EventType.TASK_FAILED }).length).toBe(1);
  });

  it('unsubscribe 后不再收到事件', async () => {
    let count = 0;
    const sub = subscribe(EventType.AGENT_READY, () => { count++; });

    publish(createEvent({ eventType: EventType.AGENT_READY, source: 'test' }));
    await new Promise(r => setTimeout(r, 10));
    expect(count).toBe(1);

    sub.unsubscribe();
    publish(createEvent({ eventType: EventType.AGENT_READY, source: 'test' }));
    await new Promise(r => setTimeout(r, 10));
    expect(count).toBe(1); // 不再增加
  });
});

// ═══════════════════════════════════════════════════════
// 2. SharedMemory · GlobalWorkspace
// ═══════════════════════════════════════════════════════

describe('S8 · SharedMemory', () => {
  beforeEach(() => {
    resetEventBus();
    initEventBus();
    resetGlobalWorkspace();
  });

  it('写入 + 读取', () => {
    const result = write({
      key: 'task-status', content: 'running', contentType: 'status',
      assertion: 'observed', traceId: 'trace-1', agentId: 'agent-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.success).toBe(true);

    const entries = read({ key: 'task-status' });
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe('running');
    expect(entries[0].version).toBe(1);
  });

  it('G8-1: 两 Agent 并发写同 key → 版本冲突', () => {
    // Agent-1 先写
    const r1 = write({
      key: 'shared-fact', content: 'v1', contentType: 'fact',
      assertion: 'observed', traceId: 'trace-1', agentId: 'agent-1',
    });
    expect(r1.ok).toBe(true);

    // Agent-2 用旧版本号（0）写 → 冲突
    const r2 = write({
      key: 'shared-fact', content: 'v2', contentType: 'fact',
      assertion: 'observed', traceId: 'trace-1', agentId: 'agent-2',
      expectedVersion: 0, // 过期版本
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value.success).toBe(false);
      expect(r2.value.conflict).toBeDefined();
      expect(r2.value.conflict!.expectedVersion).toBe(0);
      expect(r2.value.conflict!.actualVersion).toBe(1);
    }

    // VERSION_CONFLICT 事件应已发布
    const conflictEvents = getEventLog({ eventType: EventType.MEMORY_VERSION_CONFLICT });
    expect(conflictEvents.length).toBe(1);
  });

  it('红线：goal/immutable_constraints 禁止写入', () => {
    const r1 = write({
      key: 'goal', content: 'test goal', contentType: 'fact',
      assertion: 'observed', traceId: 'trace-1', agentId: 'agent-1',
    });
    expect(r1.ok).toBe(false); // err

    const r2 = write({
      key: 'immutable_constraints', content: 'no change', contentType: 'fact',
      assertion: 'observed', traceId: 'trace-1', agentId: 'agent-1',
    });
    expect(r2.ok).toBe(false);

    expect(isForbiddenKey('goal')).toBe(true);
    expect(isForbiddenKey('shared-fact')).toBe(false);
  });

  it('G8-2: assertion=inferred 不进入长期记忆', () => {
    // inferred 写入 GlobalWorkspace 成功但有 warning
    const r = write({
      key: 'inferred-fact', content: '猜测', contentType: 'fact',
      assertion: 'inferred', traceId: 'trace-1', agentId: 'agent-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.warning).toContain('inferred');

    // inferred 不允许进入长期记忆
    expect(isEligibleForLongTerm('inferred')).toBe(false);
    expect(isEligibleForLongTerm('observed')).toBe(true);

    const ltmResult = writeMemory({
      title: 'test', content: '猜测', category: 'fact',
      sourceTraceIds: ['trace-1'], assertion: 'inferred',
    });
    expect(ltmResult.ok).toBe(false); // 拒绝
  });
});

// ═══════════════════════════════════════════════════════
// 3. LongTermMemory
// ═══════════════════════════════════════════════════════

describe('S8 · LongTermMemory', () => {
  beforeEach(() => {
    resetLongTermMemory();
  });

  it('observed 可入长期记忆', () => {
    const result = writeMemory({
      title: '构建规范', content: 'TypeScript strict mode',
      category: 'rule', sourceTraceIds: ['trace-1'],
    });
    expect(result.ok).toBe(true);
    expect(getMemoryCount()).toBe(1);
  });

  it('inferred/assumed 拒绝入长期记忆', () => {
    const r1 = writeMemory({
      title: '推测', content: '可能是', category: 'fact',
      sourceTraceIds: ['trace-1'], assertion: 'inferred',
    });
    expect(r1.ok).toBe(false);

    const r2 = writeMemory({
      title: '假设', content: '假设为真', category: 'fact',
      sourceTraceIds: ['trace-1'], assertion: 'assumed',
    });
    expect(r2.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 4. LoopScheduler
// ═══════════════════════════════════════════════════════

describe('S8 · LoopScheduler', () => {
  beforeEach(() => {
    resetDedupStore();
    resetCircuitBreaker();
    initDedupStore({ windowMs: 60_000 });
    initCircuitBreaker({ threshold: 100, windowMs: 60_000, cooldownMs: 120_000 });
  });

  it('去重：60s 内同 key 仅首次通过', () => {
    const now = Date.now();
    expect(checkDedup('event-A', now)).toBe(true);
    expect(checkDedup('event-A', now + 1000)).toBe(false);
    expect(checkDedup('event-A', now + 30000)).toBe(false);
    // 窗口过期后重新通过
    expect(checkDedup('event-A', now + 61000)).toBe(true);
  });

  it('G8-3: 熔断器——100 次触发后熔断', () => {
    const now = Date.now();
    // 前 99 次通过
    for (let i = 0; i < 99; i++) {
      const r = checkBreaker('storm-key', now + i);
      expect(r.ok).toBe(true);
    }
    // 第 100 次 → 熔断
    const r100 = checkBreaker('storm-key', now + 99);
    expect(r100.ok).toBe(false);
    expect(isTripped('storm-key', now + 99)).toBe(true);
  });

  it('scheduleLoop：去重 + 熔断组合', () => {
    const now = Date.now();
    const r1 = scheduleLoop({ key: 'task-1', loopId: 'loop-1', now });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.action).toBe('start_loop');

    // 同 key 第二次 → 去重拒绝
    const r2 = scheduleLoop({ key: 'task-1', loopId: 'loop-2', now: now + 1000 });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.action).toBe('dedup_rejected');
  });
});

// ═══════════════════════════════════════════════════════
// 5. CausalTokens
// ═══════════════════════════════════════════════════════

describe('S8 · CausalTokens', () => {
  it('happens-before 关系', () => {
    const a = new Map([['agent-1', 1]]);
    const b = new Map([['agent-1', 2]]);
    expect(happensBefore(a, b)).toBe(true);
    expect(happensBefore(b, a)).toBe(false);
  });

  it('并发检测', () => {
    const a = new Map([['agent-1', 2], ['agent-2', 1]]);
    const b = new Map([['agent-1', 1], ['agent-2', 2]]);
    expect(isConcurrent(a, b)).toBe(true);
  });

  it('合并时钟', () => {
    const a = new Map([['agent-1', 3], ['agent-2', 1]]);
    const b = new Map([['agent-1', 1], ['agent-2', 4]]);
    const merged = mergeClocks(a, b);
    expect(merged.get('agent-1')).toBe(3);
    expect(merged.get('agent-2')).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════
// 6. Gate G8 综合验证
// ═══════════════════════════════════════════════════════

describe('S8 · Gate G8 综合验证', () => {
  beforeEach(() => {
    resetEventBus();
    initEventBus();
    resetGlobalWorkspace();
    resetLongTermMemory();
    resetDedupStore();
    resetCircuitBreaker();
    initDedupStore({ windowMs: 60_000 });
    initCircuitBreaker({ threshold: 100, windowMs: 60_000, cooldownMs: 120_000 });
  });

  it('G8-1: 并发写 VERSION_CONFLICT 完整流程', () => {
    // Agent-A 写
    write({
      key: 'config', content: 'v1', contentType: 'decision',
      assertion: 'observed', traceId: 'trace-1', agentId: 'agent-A',
    });

    // Agent-B 用旧版本写 → 冲突
    const r = write({
      key: 'config', content: 'v2', contentType: 'decision',
      assertion: 'observed', traceId: 'trace-1', agentId: 'agent-B',
      expectedVersion: 0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.success).toBe(false);
      expect(r.value.conflict!.agentId).toBe('agent-B');
    }
  });

  it('G8-2: inferred 不入 L 分区与长期记忆', () => {
    const r = writeMemory({
      title: '推测结论', content: '可能是 X',
      category: 'fact', sourceTraceIds: ['trace-1'],
      assertion: 'inferred',
    });
    expect(r.ok).toBe(false);
    expect(getMemoryCount()).toBe(0);
  });

  it('G8-3: 60s 内 100 次触发 → 熔断', () => {
    const now = Date.now();
    let allowedCount = 0;
    for (let i = 0; i < 110; i++) {
      const r = checkBreaker('flood-key', now + i);
      if (r.ok) allowedCount++;
    }
    // 前 100 次中，第 1 次到第 99 次通过，第 100 次熔断
    expect(allowedCount).toBe(99);
    expect(isTripped('flood-key', now + 109)).toBe(true);
  });

  it('G8-4: 事件消费者幂等', async () => {
    let processCount = 0;
    subscribe(EventType.TOKEN_CONSUMED, () => { processCount++; });

    const event = createEvent({
      eventType: EventType.TOKEN_CONSUMED,
      source: 'test',
      traceId: 'trace-1',
    });

    // 发布 5 次同一事件
    for (let i = 0; i < 5; i++) publish(event);

    await new Promise(r => setTimeout(r, 20));
    expect(processCount).toBe(1); // 仅处理一次
  });
});
