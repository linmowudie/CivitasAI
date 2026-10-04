/**
 * G-13 验收：共享记忆治理（2026-10-04）
 *
 * 依据灵感源《一些思考2.md》：
 *  - §1.3 分层：治理键仅 L0 可写；**隔离层键不得进入共享层**（中间过程物理隔离）；
 *  - §3.3 写入守卫：相似度 ≥ 0.85 且极性相反 → **阻断 + 上报 CONFLICT_DETECTED**。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  classifyKeyTier, similarity, polarityConflicts, detectSemanticConflict,
  requireWritePermission, CONFLICT_SIMILARITY_THRESHOLD, proposition,
} from '../../Src/Services/SharedMemory/memoryGovernance.js';
import { write, read, resetGlobalWorkspace, getEntryCount } from '../../Src/Services/SharedMemory/globalWorkspace.js';
import { subscribeMany } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

describe('G-13 共享记忆治理', () => {
  beforeEach(() => resetGlobalWorkspace());

  describe('§1.3 键分层与写入权限', () => {
    it('键分层判定：治理键 / 隔离键 / 普通共享键', () => {
      expect(classifyKeyTier('regulation.rule.R-001')).toBe('governance');
      expect(classifyKeyTier('verdict.case-1')).toBe('governance');
      expect(classifyKeyTier('internal_scratchpad.agent-1')).toBe('private');
      expect(classifyKeyTier('draft.plan')).toBe('private');
      expect(classifyKeyTier('task_context.session-1')).toBe('shared');
    });

    it('★ 隔离层键不得写入共享记忆（中间过程物理隔离）', () => {
      const p = requireWritePermission({ key: 'internal_scratchpad.agent-1', actorRole: 'worker' });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.error).toContain('隔离层');

      // 即便治理角色也不能把中间推理写进共享层
      const p2 = requireWritePermission({ key: 'reasoning.step-1', actorRole: 'auditor' });
      expect(p2.ok).toBe(false);
    });

    it('★ 治理键仅 L0 / 所有者可写（执行层被拒）', () => {
      for (const role of ['prime_director', 'worker', 'reviewer']) {
        const p = requireWritePermission({ key: 'regulation.rule.R-001', actorRole: role });
        expect(p.ok, `${role} 不应可写治理键`).toBe(false);
      }
      expect(requireWritePermission({ key: 'regulation.rule.R-001', actorRole: 'regulatory_authority' }).ok).toBe(true);
      expect(requireWritePermission({ key: 'governance.notice.1', actorRole: 'user' }).ok).toBe(true);
    });

    it('普通共享键全员可写；agentId 形如 governance:<role> 时按角色解析', () => {
      expect(requireWritePermission({ key: 'task_context.s1', actorRole: 'worker' }).ok).toBe(true);
      expect(requireWritePermission({ key: 'regulation.x', agentId: 'governance:auditor' }).ok).toBe(true);
      expect(requireWritePermission({ key: 'regulation.x', agentId: 'agent-worker-1' }).ok).toBe(false);
    });
  });

  describe('§3.3 语义冲突检测', () => {
    it('相似度高且极性相反 → 判为冲突', () => {
      const a = '允许 shell.exec 执行删除操作';
      const b = '禁止 shell.exec 执行删除操作';
      // 关键：比较的是**剥掉模态词后的命题**相似度（原句因"允许/禁止"仅 0.64，会漏判）
      expect(similarity(proposition(a), proposition(b))).toBeGreaterThanOrEqual(CONFLICT_SIMILARITY_THRESHOLD);
      expect(polarityConflicts(a, b)).toBe(true);
      expect(detectSemanticConflict(b, a)).not.toBeNull();
    });

    it('相似但极性一致 → 不判冲突（避免误伤正常复述）', () => {
      const a = '允许 shell.exec 执行删除操作';
      const b = '允许 shell.exec 执行删除操作（复核通过）';
      expect(detectSemanticConflict(b, a)).toBeNull();
    });

    it('不相似 → 不判冲突', () => {
      expect(detectSemanticConflict('任务目标是重构认证模块', '允许 shell.exec 删除')).toBeNull();
    });
  });

  describe('写入路径集成', () => {
    it('★ 治理键写入必须带 L0 身份，否则被拒', () => {
      const denied = write({
        key: 'regulation.rule.R-9', content: '禁止外部网络访问', contentType: 'decision',
        assertion: 'observed', traceId: 't1', agentId: 'agent-worker-1', actorRole: 'worker',
      });
      expect(denied.ok).toBe(false);

      const allowed = write({
        key: 'regulation.rule.R-9', content: '禁止外部网络访问', contentType: 'decision',
        assertion: 'observed', traceId: 't1', agentId: 'governance:regulatory_authority',
        actorRole: 'regulatory_authority',
      });
      expect(allowed.ok).toBe(true);
      expect(getEntryCount()).toBe(1);
    });

    it('★ 语义相反的同键写入被阻断，并发布 CONFLICT_DETECTED', () => {
      const events: Array<{ type: string; payload: unknown }> = [];
      const sub = subscribeMany([EventType.CONFLICT_DETECTED], (e) => {
        events.push({ type: e.eventType, payload: e.payload });
      });

      const first = write({
        key: 'regulation.rule.R-10', content: '允许 shell.exec 执行删除操作', contentType: 'decision',
        assertion: 'observed', traceId: 't1', agentId: 'governance:auditor', actorRole: 'auditor',
      });
      expect(first.ok).toBe(true);

      const conflicting = write({
        key: 'regulation.rule.R-10', content: '禁止 shell.exec 执行删除操作', contentType: 'decision',
        assertion: 'observed', traceId: 't1', agentId: 'governance:auditor', actorRole: 'auditor',
      });
      expect(conflicting.ok).toBe(false);
      if (!conflicting.ok) expect(conflicting.error).toContain('语义冲突');
      expect(events.length).toBe(1);
      expect(getEntryCount()).toBe(1); // 冲突写入未落库

      sub.unsubscribe?.();
      vi.restoreAllMocks();
    });

    it('隔离层键经写入路径也被拒（防止中间过程污染全局记忆）', () => {
      const r = write({
        key: 'internal_scratchpad.agent-1', content: '我的中间推理', contentType: 'status',
        assertion: 'inferred', traceId: 't1', agentId: 'agent-1',
      });
      expect(r.ok).toBe(false);
      expect(getEntryCount()).toBe(0);
    });
  });
});
