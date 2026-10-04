/**
 * G-09 方案 B 验收：服务端令牌验真 + 身份绑定优先级（2026-10-04）
 *
 * 不变量：
 *  1. 令牌 → `GET /v1/me` 验真，得到可信 `userId`；HTTP 非 2xx / 缺 id → fail-closed；
 *  2. 验真结果**优先**于本地活动账号与自报身份；
 *  3. 缓存生效（同令牌短时间内不重复打服务端），且缓存键为令牌哈希；
 *  4. 人类代理治理角色**显式留痕**（`approval.human_proxy`），不静默；
 *  5. 形如 `agent-xxx` 的身份仍走"真实注册 Agent + 角色匹配"严格校验。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  resolveServerIdentity, extractBearerToken, resetServerIdentityCache, serverBaseUrl,
} from '../../Src/Services/Governance/serverIdentity.js';
import { bindApprovalIdentity } from '../../Src/Services/Governance/approvalIdentity.js';
import { listGovernanceRecords, resetGovernanceLedger } from '../../Src/Services/Governance/governanceAudit.js';

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const AGENTS: Record<string, { agentId: string; role: string }> = {
  'agent-auditor-1': { agentId: 'agent-auditor-1', role: 'auditor' },
  'agent-worker-1': { agentId: 'agent-worker-1', role: 'worker' },
};

describe('G-09 方案 B：服务端令牌验真', () => {
  beforeEach(() => resetServerIdentityCache());

  it('★ 令牌验真成功 → 返回可信 userId（兼容 {data:{user:{id}}} 与 {id} 两种返回体）', async () => {
    const r1 = await resolveServerIdentity('tok-a', {
      fetchImpl: mockFetch(200, { ok: true, data: { user: { id: 'user-42' } } }),
      cacheTtlMs: 0,
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.userId).toBe('user-42');

    const r2 = await resolveServerIdentity('tok-b', {
      fetchImpl: mockFetch(200, { id: 'user-7' }),
      cacheTtlMs: 0,
    });
    if (r2.ok) expect(r2.value.userId).toBe('user-7');
  });

  it('★ 验真失败 fail-closed：HTTP 401 / 缺 id / 网络异常', async () => {
    const unauthorized = await resolveServerIdentity('bad', { fetchImpl: mockFetch(401, {}), cacheTtlMs: 0 });
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) expect(unauthorized.error).toContain('401');

    const noId = await resolveServerIdentity('weird', { fetchImpl: mockFetch(200, { ok: true, data: {} }), cacheTtlMs: 0 });
    expect(noId.ok).toBe(false);

    const throwing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const netErr = await resolveServerIdentity('x', { fetchImpl: throwing, cacheTtlMs: 0 });
    expect(netErr.ok).toBe(false);
    if (!netErr.ok) expect(netErr.error).toContain('ECONNREFUSED');
  });

  it('★ 缓存生效：同令牌第二次不再请求服务端', async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'user-c' }) }));
    const fetchImpl = spy as unknown as typeof fetch;
    await resolveServerIdentity('tok-cache', { fetchImpl, cacheTtlMs: 60_000 });
    await resolveServerIdentity('tok-cache', { fetchImpl, cacheTtlMs: 60_000 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('缺少令牌 → 拒绝；请求头解析兼容两种写法', async () => {
    expect((await resolveServerIdentity('')).ok).toBe(false);
    expect(extractBearerToken({ authorization: 'Bearer abc.def' })).toBe('abc.def');
    expect(extractBearerToken({ 'X-Account-Token': 'raw-token' })).toBe('raw-token');
    expect(extractBearerToken({ authorization: 'Basic xyz' })).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('服务端基址可由环境/覆盖指定，且去掉尾部斜杠', () => {
    expect(serverBaseUrl('http://example.test:1234/')).toBe('http://example.test:1234');
  });
});

describe('G-09 方案 B：身份绑定优先级与代理留痕', () => {
  beforeEach(() => resetGovernanceLedger());

  it('★ 服务端已验身份优先于本地活动账号', () => {
    const r = bindApprovalIdentity('user:自报名字', {
      getOwner: () => 'local',
      verifiedUserId: 'user-42',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.decidedBy).toBe('user:user-42');
      expect(r.value.source).toBe('server_token');
      expect(r.value.rewritten).toBe(true);
    }
    const mismatch = listGovernanceRecords({ action: 'approval.identity_mismatch' });
    expect(mismatch.length).toBe(1);
    expect(mismatch[0]!.reason).toContain('服务端令牌身份');
  });

  it('无令牌时回退方案 A（绑定活动账号）', () => {
    const r = bindApprovalIdentity('user:随便', { getOwner: () => 'alice' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.decidedBy).toBe('user:alice');
      expect(r.value.source).toBe('active_account');
    }
  });

  it('★ 人类代理治理角色 → 显式留痕（不静默）', () => {
    const r = bindApprovalIdentity('auditor:操作者', {
      getOwner: () => 'alice',
      getAgentById: (id) => AGENTS[id],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.source).toBe('human_proxy');
      expect(r.value.proxiedByHuman).toBe(true);
      expect(r.value.identity).toBe('alice');
    }
    const proxy = listGovernanceRecords({ action: 'approval.human_proxy' });
    expect(proxy.length).toBe(1);
    expect(proxy[0]!.outcome).toBe('allowed');
    expect(proxy[0]!.reason).toContain('人类代理');
  });

  it('★ 形如 agent-xxx 的身份仍走严格校验（不存在 / 角色不符 → 拒绝）', () => {
    const unknown = bindApprovalIdentity('auditor:agent-ghost-9', { getOwner: () => 'alice', getAgentById: (id) => AGENTS[id] });
    expect(unknown.ok).toBe(false);

    const mismatch = bindApprovalIdentity('auditor:agent-worker-1', { getOwner: () => 'alice', getAgentById: (id) => AGENTS[id] });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error).toContain('与所报');
  });

  it('真实注册 Agent 且角色匹配 → 通过（source=registered_agent）', () => {
    const r = bindApprovalIdentity('auditor:agent-auditor-1', { getOwner: () => 'alice', getAgentById: (id) => AGENTS[id] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.source).toBe('registered_agent');
      expect(r.value.identity).toBe('agent-auditor-1');
    }
  });
});
