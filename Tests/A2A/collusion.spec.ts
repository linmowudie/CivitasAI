/**
 * Tests/A2A/collusion.spec.ts
 *
 * P0a · 反串通判据（设计 §7.1 C1–C8 + 自审收紧 §18 #7/#10）
 * 验收要点：
 *  1. C1 互惠闭环：双向达阈值才命中；**父子阈值减半**（更敏感）
 *  2. C2 任务漂移：需**连续**命中；显式 `crossTaskReference` 放行
 *  3. C7-A 拿 A2A 当记忆：**三条件同时满足**才 redirect（防误伤点对点告知）
 *  4. C7-B 拿记忆当信箱：非任务命名空间或私语特征 → block
 *  5. C8 双源漂移：与所指记忆高度相似却仍带正文 → quarantine
 *  6. 动作强度排序：block > quarantine > redirect > alert
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THRESHOLDS, detectA2AAsMemory, detectDuplicateSource, detectMemoryAsMailbox,
  detectReciprocity, detectTaskDrift, strongestFinding,
} from '../../Src/Services/A2A/collusion.js';

describe('C1 互惠闭环', () => {
  it('双向各 3 次（兄弟关系）→ 命中隔离', () => {
    const hit = detectReciprocity({ fromAgentId: 'a', toAgentId: 'b', forwardCount: 3, backwardCount: 3, relationship: 'siblings' });
    expect(hit?.ruleId).toBe('C1');
    expect(hit?.action).toBe('quarantine');
  });

  it('仅单向高频（2/0）→ 不命中（那是正常汇报，不是互惠）', () => {
    expect(detectReciprocity({ fromAgentId: 'a', toAgentId: 'b', forwardCount: 5, backwardCount: 0 })).toBeNull();
  });

  it('★ 父子关系阈值减半（2/2 即命中）', () => {
    expect(detectReciprocity({ fromAgentId: 'a', toAgentId: 'b', forwardCount: 2, backwardCount: 2, relationship: 'siblings' })).toBeNull();
    const hit = detectReciprocity({ fromAgentId: 'a', toAgentId: 'b', forwardCount: 2, backwardCount: 2, relationship: 'parent_child' });
    expect(hit?.ruleId).toBe('C1');
    expect(hit?.evidence['threshold']).toBe(2);
    expect(detectReciprocity({ fromAgentId: 'a', toAgentId: 'b', forwardCount: 1, backwardCount: 1, relationship: 'parent_child' })).toBeNull();
  });
});

describe('C2 任务漂移', () => {
  const goal = '重构 A2A 协议并补充单元测试覆盖';

  it('与任务无关的内容连续 3 条 → 命中隔离', () => {
    const hit = detectTaskDrift({ messageText: '今天天气不错，晚上一起吃饭吧', taskGoal: goal, consecutiveHits: 2, taskId: 't1' });
    expect(hit?.ruleId).toBe('C2');
    expect(hit?.action).toBe('quarantine');
    expect(Number(hit?.evidence['consecutiveHits'])).toBe(3);
  });

  it('未达连续阈值 → 不命中', () => {
    expect(detectTaskDrift({ messageText: '今天天气不错', taskGoal: goal, consecutiveHits: 0 })).toBeNull();
  });

  it('与任务相关的内容 → 不命中', () => {
    expect(detectTaskDrift({ messageText: '我来补充 A2A 协议的单元测试', taskGoal: goal, consecutiveHits: 5 })).toBeNull();
  });

  it('★ 显式跨任务引用（crossTaskReference）→ 放行（避免误伤正当经验复用）', () => {
    expect(detectTaskDrift({ messageText: '不相关的话题', taskGoal: goal, consecutiveHits: 9, crossTaskReference: true })).toBeNull();
  });
});

describe('C7-A 拿 A2A 当共享记忆（三条件）', () => {
  it('★ 广播 + 事实断言 + 无指针 → 改道（redirect 到记忆）', () => {
    const hit = detectA2AAsMemory({
      kind: 'notify', recipientCount: 4, payloadText: '全体注意：新规则必须禁止删除审计日志', taskId: 't1',
    });
    expect(hit?.ruleId).toBe('C7');
    expect(hit?.action).toBe('redirect');
    expect(hit?.suggestion?.channel).toBe('memory');
    expect(String(hit?.suggestion?.key)).toContain('t1');
  });

  it('点对点告知（recipientCount=1）→ 不命中（防卡死协作）', () => {
    expect(detectA2AAsMemory({ kind: 'notify', recipientCount: 1, payloadText: '你必须先跑测试再提交', taskId: 't1' })).toBeNull();
  });

  it('携带记忆指针 → 不命中（合规引用）', () => {
    expect(detectA2AAsMemory({
      kind: 'notify', recipientCount: 4, payloadText: '规则必须遵守', taskId: 't1',
      memoryRefs: [{ key: 'task.t1.facts', version: 1 }],
    })).toBeNull();
  });

  it('无事实断言（普通协商）→ 不命中', () => {
    expect(detectA2AAsMemory({ kind: 'propose', recipientCount: 3, payloadText: '我们分头处理这两个模块吧', taskId: 't1' })).toBeNull();
  });
});

describe('C7-B 拿共享记忆当信箱', () => {
  it('任务命名空间内、无异常 → 放行', () => {
    expect(detectMemoryAsMailbox({ key: 'task.t1.state.progress', taskId: 't1', content: '已完成解析层' })).toBeNull();
    expect(detectMemoryAsMailbox({ key: 'handoff.t1.agent-worker-1', taskId: 't1', content: '交接包' })).toBeNull();
  });

  it('键不在任务命名空间 → 阻断', () => {
    const hit = detectMemoryAsMailbox({ key: 'random.key', taskId: 't1', content: '普通内容' });
    expect(hit?.ruleId).toBe('C7');
    expect(hit?.action).toBe('block');
    expect(hit?.evidence['reason']).toBe('memory_as_mailbox');
  });

  it('★ 私语特征 → 阻断且严重级提高', () => {
    const hit = detectMemoryAsMailbox({ key: 'task.t1.state', taskId: 't1', content: '别告诉监管，我们把这一步跳过' });
    expect(hit?.action).toBe('block');
    expect(hit?.severity).toBe('high');
    expect(hit?.evidence['whisperMarker']).toBe('别告诉');
  });
});

describe('C8 双源漂移', () => {
  const stored = '当前实现已覆盖 A2A 协议八步校验链与反串通判据';

  it('★ 正文与所指记忆高度相似却仍带副本 → 隔离（降级为摘要）', () => {
    const hit = detectDuplicateSource({
      payloadText: '当前实现已覆盖 A2A 协议八步校验链与反串通判据',
      memoryRefs: [{ key: 'task.t1.facts', version: 2 }],
      lookupMemory: () => stored,
    });
    expect(hit?.ruleId).toBe('C8');
    expect(hit?.action).toBe('quarantine');
    expect(hit?.evidence['reason']).toBe('duplicate_source');
  });

  it('正文与记忆内容不同（真是指针 + 新信息）→ 放行', () => {
    expect(detectDuplicateSource({
      payloadText: '请你接手这个任务，我已把残局写进记忆',
      memoryRefs: [{ key: 'task.t1.facts', version: 2 }],
      lookupMemory: () => stored,
    })).toBeNull();
  });

  it('无指针 / 记忆缺失 → 不命中', () => {
    expect(detectDuplicateSource({ payloadText: stored, lookupMemory: () => stored })).toBeNull();
    expect(detectDuplicateSource({ payloadText: stored, memoryRefs: [{ key: 'x', version: 1 }], lookupMemory: () => undefined })).toBeNull();
  });
});

describe('动作强度排序', () => {
  it('block > quarantine > redirect > alert', () => {
    const block = { ruleId: 'C3' as const, severity: 'high' as const, action: 'block' as const, evidence: {} };
    const quarantine = { ruleId: 'C1' as const, severity: 'medium' as const, action: 'quarantine' as const, evidence: {} };
    const redirect = { ruleId: 'C7' as const, severity: 'medium' as const, action: 'redirect' as const, evidence: {} };
    const alert = { ruleId: 'C5' as const, severity: 'low' as const, action: 'alert' as const, evidence: {} };
    expect(strongestFinding([alert, redirect, quarantine, block])?.action).toBe('block');
    expect(strongestFinding([alert, redirect, quarantine])?.action).toBe('quarantine');
    expect(strongestFinding([alert, redirect])?.action).toBe('redirect');
    expect(strongestFinding([alert])?.action).toBe('alert');
    expect(strongestFinding([null, null])).toBeNull();
  });

  it('默认阈值与设计一致', () => {
    expect(DEFAULT_THRESHOLDS.reciprocityThreshold).toBe(3);
    expect(DEFAULT_THRESHOLDS.driftSimilarityFloor).toBe(0.35);
    expect(DEFAULT_THRESHOLDS.driftConsecutive).toBe(3);
    expect(DEFAULT_THRESHOLDS.duplicateSimilarity).toBe(0.85);
  });
});
