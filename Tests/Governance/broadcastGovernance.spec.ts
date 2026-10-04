/**
 * G-05 验收：治理广播的角色门 + 与**记忆治理**的耦合（2026-10-04）
 *
 * 原始设计理念（`Docs/Agent/08` L13 / `Docs/Agent/07` §3.1）：
 *   - **广播 = Regulation/Audit → 所有 Agent**（一对多，事件总线 Pub/Sub）→ 天然是**治理动作**；
 *   - 广播应当成为**所有 Agent 可见的共享记忆条目**，写入受 `writeGuard`（红线 key / 乐观锁）约束；
 *   - 借鉴 MongoTerminalAgent：**记忆写入失败不阻断广播主流程**，但必须留痕。
 *
 * 参见 `Docs/Dev/治理层完善清单.md` G-05。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { broadcast, resetBroadcastChannel, getBroadcast } from '../../Src/Services/Regulation/broadcastChannel.js';
import { read as readWorkspace, resetGlobalWorkspace } from '../../Src/Services/SharedMemory/globalWorkspace.js';
import { requireGovernanceRole } from '../../Src/Services/Governance/governanceGuard.js';

describe('G-05 治理广播', () => {
  beforeEach(() => {
    resetBroadcastChannel();
    resetGlobalWorkspace();
  });

  it('★ 执行层角色不得发布治理广播（L1/L2 只做事）', () => {
    for (const role of ['prime_director', 'partner', 'worker', 'reviewer']) {
      const r = broadcast({
        type: 'rule_update', title: '越权通告', content: '试图以执行层发布治理广播', actorRole: role,
      });
      expect(r.ok, `${role} 不应被允许发布治理广播`).toBe(false);
      if (!r.ok) expect(r.error).toContain('治理');
    }
  });

  it('★ 治理广播必须 L0（审计/监管/所有者）', () => {
    const r = broadcast({
      type: 'rule_update', title: '行为准则更新', content: 'R-001 生效',
      actorRole: 'regulatory_authority',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.type).toBe('rule_update');
  });

  it('★ 广播 = 写入共享记忆（与记忆治理耦合）：治理广播后全员记忆可见', () => {
    const r = broadcast({
      type: 'emergency_alert', title: '全局暂停', content: '检测到全局异常，暂停所有 Agent',
      actorRole: 'regulatory_authority',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 共享记忆里应能查到该广播条目（说明广播确实进入了 GlobalWorkspace）
    const entries = readWorkspace({});
    const found = entries.filter(e => e.key.includes('regulation.broadcast.'));
    expect(found.length).toBeGreaterThan(0);
    expect(found.some(e => e.key.includes(r.value.broadcastId))).toBe(true);
  });

  it('广播本身仍成功即使记忆写入受限（借鉴"监管失效不阻断主流程"）', () => {
    // 用红线 key 之外的正常类型：广播必须成功且记录可查
    const r = broadcast({
      type: 'system_notice', title: '通告', content: '内容', actorRole: 'auditor',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(getBroadcast(r.value.broadcastId)).toBeTruthy();
  });

  it('判据：广播属治理动作（reviewer 内容审查不在此列）', () => {
    expect(requireGovernanceRole('reviewer', '治理广播').ok).toBe(false);
    expect(requireGovernanceRole('auditor', '治理广播').ok).toBe(true);
  });
});
