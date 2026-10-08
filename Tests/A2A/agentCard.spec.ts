/**
 * Tests/A2A/agentCard.spec.ts
 *
 * P0a · Agent Card 派生签发（设计 §2 + 自审修正 §18 #2/#3）
 * 验收要点：
 *  1. 分层/权限派生正确（治理键仅 L0；L2 不得 `propose`）
 *  2. 能力**从工具注册表派生**（与执行期可见性同源，不靠人填）
 *  3. 指纹确定性 + 防篡改
 *  4. **运行态同步不失真**（status/health 变化不动指纹、不升版本）
 *  5. 能力/权限变更 → **必须新版本重签**
 *  6. 可用性 fail-closed（过期/停用/销毁/指纹不符）
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { registerBuiltinTools } from '../../Src/Tools/builtinLoader.js';
import { getVisibleToolsForRole } from '../../Src/Tools/Factory/toolFactory.js';
import {
  deriveAgentCard, deriveAbility, reissueCard, syncRuntimeState,
  verifyCardFingerprint, isCardUsable, isKindAllowed, DEFAULT_CARD_TTL_MS,
} from '../../Src/Services/A2A/agentCard.js';
import type { AgentInstance, AgentRole } from '../../Src/Core/AgentRuntime/types.js';
import type { DangerLevel } from '../../Src/Infra/Security/trustLevels.js';

const NOW = 1_800_000_000_000;

function mkAgent(role: AgentRole, over: Partial<AgentInstance> = {}): AgentInstance {
  return {
    agentId: `agent-${role}-1`,
    role,
    status: 'ready',
    model: 'test-model',
    createdAt: NOW - 1000,
    updatedAt: NOW,
    consecutiveFailures: 0,
    awaitingApproval: false,
    ...over,
  };
}

const DANGER_ORDER: DangerLevel[] = ['SAFE', 'CONTROLLED', 'DANGEROUS', 'FORBIDDEN'];
function expectedCeiling(role: AgentRole): DangerLevel {
  let max = 0;
  for (const t of getVisibleToolsForRole(role)) {
    const lvl = (t as { dangerLevel?: DangerLevel }).dangerLevel;
    const idx = lvl ? DANGER_ORDER.indexOf(lvl) : -1;
    if (idx > max) max = idx;
  }
  return DANGER_ORDER[max];
}

beforeAll(() => { registerBuiltinTools(); });

describe('P0a · Agent Card 派生（§2）', () => {
  it('能力从工具注册表派生：tools 与 getVisibleToolsForRole 逐字一致', () => {
    for (const role of ['worker', 'reviewer', 'prime_director', 'auditor'] as AgentRole[]) {
      const ability = deriveAbility(mkAgent(role));
      const expected = getVisibleToolsForRole(role).map(t => t.name).sort();
      expect(ability.tools, `${role} 的工具应来自注册表`).toEqual(expected);
      expect(ability.tools.length, `${role} 应至少可见 1 个工具`).toBeGreaterThan(0);
    }
  });

  it('危险级上限由可见工具派生（非人工填写）', () => {
    for (const role of ['worker', 'reviewer', 'auditor', 'arbitrator'] as AgentRole[]) {
      const card = deriveAgentCard(mkAgent(role), { now: NOW });
      expect(card.permission.dangerCeiling, `${role} 的危险级上限`).toBe(expectedCeiling(role));
    }
  });

  it('L0 卡片：可写治理键、可广播、可审批本角色、不可招募', () => {
    const card = deriveAgentCard(mkAgent('auditor'), { now: NOW });
    expect(card.permission.tier).toBe('L0');
    expect(card.permission.canWriteGovernanceKeys).toBe(true);
    expect(card.permission.canBroadcast).toBe(true);
    expect(card.permission.canApprove).toEqual(['auditor']);
    expect(card.permission.canDelegate).toBe(false);
    expect(card.role).toBe('auditor');
    expect(card.createTime).toBe(NOW - 1000);
  });

  it('L1 卡片：可招募但不可审批/不可写治理键', () => {
    const card = deriveAgentCard(mkAgent('prime_director'), { now: NOW });
    expect(card.permission.tier).toBe('L1');
    expect(card.permission.canDelegate).toBe(true);
    expect(card.permission.canApprove).toEqual([]);
    expect(card.permission.canWriteGovernanceKeys).toBe(false);
    expect(card.permission.canBroadcast).toBe(false);
  });

  it('L2 卡片：不得 propose（§18 #10），配额更低', () => {
    const card = deriveAgentCard(mkAgent('worker'), { now: NOW });
    expect(card.permission.tier).toBe('L2');
    expect(isKindAllowed(card, 'propose')).toBe(false);
    expect(isKindAllowed(card, 'query')).toBe(true);
    expect(isKindAllowed(card, 'handoff')).toBe(true);
    expect(card.permission.a2a.maxMessagesPerHour).toBe(30);
    expect(card.permission.a2a.maxPeers).toBe(3);
    expect(card.permission.canWriteGovernanceKeys).toBe(false);
  });

  it('father / lineage 为正式字段（替代旁挂 Map —— §18 #3）', () => {
    const card = deriveAgentCard(mkAgent('worker'), {
      now: NOW,
      father: { agentId: 'agent-prime_director-1', role: 'prime_director' },
      lineage: ['agent-prime_director-1'],
    });
    expect(card.father).toEqual({ agentId: 'agent-prime_director-1', role: 'prime_director' });
    expect(card.lineage).toEqual(['agent-prime_director-1']);
    const root = deriveAgentCard(mkAgent('prime_director'), { now: NOW });
    expect(root.father).toBeNull();
    expect(root.lineage).toEqual([]);
  });
});

describe('P0a · 卡片指纹与版本（§18 #2）', () => {
  it('指纹确定性：相同输入 → 相同指纹；可校验', () => {
    const a = deriveAgentCard(mkAgent('worker'), { now: NOW, ownerUserId: 'local' });
    const b = deriveAgentCard(mkAgent('worker'), { now: NOW, ownerUserId: 'local' });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(verifyCardFingerprint(a)).toBe(true);
  });

  it('防篡改：改动能力/权限任一字段 → 校验失败', () => {
    const card = deriveAgentCard(mkAgent('worker'), { now: NOW });
    expect(verifyCardFingerprint({ ...card, ability: { ...card.ability, tools: [...card.ability.tools, 'shell.exec'] } })).toBe(false);
    expect(verifyCardFingerprint({ ...card, permission: { ...card.permission, canBroadcast: true } })).toBe(false);
    expect(verifyCardFingerprint({ ...card, role: 'auditor' })).toBe(false);
    expect(verifyCardFingerprint({ ...card, expiresAt: card.expiresAt + 1 })).toBe(false);
  });

  it('★ 运行态同步不失真：status/health 变化不破坏指纹、不升版本', () => {
    const card = deriveAgentCard(mkAgent('worker'), { now: NOW });
    const running = syncRuntimeState(card, mkAgent('worker', { status: 'running', consecutiveFailures: 2, updatedAt: NOW + 500 }), NOW + 500);
    expect(running.status).toBe('running');
    expect(running.health.consecutiveFailures).toBe(2);
    expect(running.cardVersion).toBe(card.cardVersion);      // 未升版本
    expect(running.fingerprint).toBe(card.fingerprint);      // 指纹不变
    expect(verifyCardFingerprint(running)).toBe(true);       // 仍可信
  });

  it('★ 能力/权限变更 → 新版本重签（旧版本可审计）', () => {
    const v1 = deriveAgentCard(mkAgent('worker'), { now: NOW });
    const v2 = reissueCard(v1, mkAgent('worker'), { a2a: { maxMessagesPerHour: 5 } }, NOW + 10);
    expect(v2.cardVersion).toBe(2);
    expect(v2.cardId).toBe('card-agent-worker-1-v2');
    expect(v2.permission.a2a.maxMessagesPerHour).toBe(5);
    expect(v2.fingerprint).not.toBe(v1.fingerprint);
    expect(verifyCardFingerprint(v2)).toBe(true);
    expect(verifyCardFingerprint(v1)).toBe(true);            // 旧版本仍自洽（可审计）
  });
});

describe('P0a · 卡片可用性（fail-closed）', () => {
  it('正常卡片可用，且默认有效期 24h', () => {
    const card = deriveAgentCard(mkAgent('worker'), { now: NOW });
    expect(card.expiresAt).toBe(NOW + DEFAULT_CARD_TTL_MS);
    expect(isCardUsable(card, NOW)).toEqual({ usable: true });
  });

  it('过期 / 停用 / 销毁 / 指纹不符 → 一律不可用', () => {
    const expired = deriveAgentCard(mkAgent('worker'), { now: NOW, ttlMs: -1 });
    expect(isCardUsable(expired, NOW)).toEqual({ usable: false, reason: 'expired' });

    for (const status of ['suspended', 'destroyed', 'failed'] as const) {
      const card = deriveAgentCard(mkAgent('worker', { status }), { now: NOW });
      expect(isCardUsable(card, NOW).usable, `status=${status}`).toBe(false);
      expect(isCardUsable(card, NOW).reason).toBe(`status_${status}`);
    }

    const tampered = deriveAgentCard(mkAgent('worker'), { now: NOW });
    tampered.permission.canBroadcast = true;                 // 越权篡改
    expect(isCardUsable(tampered, NOW)).toEqual({ usable: false, reason: 'fingerprint_mismatch' });
  });
});
