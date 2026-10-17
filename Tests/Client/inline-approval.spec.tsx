/**
 * @vitest-environment jsdom
 *
 * 内嵌审批回归（2026-10-01 FE-024 + 2026-10-08 REV-264）：
 * - 被安全门阻塞的危险工具，其审批卡**内嵌在对话中的工具行**里；
 * - 与左侧「审批栏」读同一份 approvalStore → 任一处决策都同步生效；
 * - 自动审批（策略白名单）无需用户确认，显示已自动通过；拒绝/超时显示对应结果；
 * - 双人控制按**不同身份**判定：一次点击只投一票，同一身份重复提交被拒（不再假通过）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const h = vi.hoisted(() => ({
  posts: [] as Array<{ path: string; body: unknown }>,
  approvals: [] as unknown[],
  /** 已记账的 `role:identity`（模拟后端队列） */
  decidedBy: [] as string[],
  /** 当前活动账号（用于模拟"换另一位操作者登录"） */
  owner: 'local',
  status: 'PENDING' as string,
}));

vi.mock('@/services/api', () => ({
  apiGet: vi.fn(async (path: string) => {
    const withQueue = (a: unknown) => ({ ...(a as object), decidedBy: [...h.decidedBy], status: h.status });
    // 审批详情端点：点击时若 store 里还没有该审批，decide 会拉详情取决策池角色
    if (path.startsWith('/api/approvals/')) return { ok: true, data: withQueue(PENDING_APPROVAL) };
    if (path === '/api/reviews') return { ok: true, data: [] };
    return { ok: true, data: h.approvals.map(withQueue) };
  }),
  apiPost: vi.fn(async (path: string, body: unknown) => {
    h.posts.push({ path, body });
    const b = body as { approve: boolean; decidedBy: string };

    // 与后端 approvalIdentity 同构：人类自报身份一律绑到当前活动账号，
    // 只有形如 agent-* 的身份才是独立行为主体。
    const sep = b.decidedBy.indexOf(':');
    const role = sep > 0 ? b.decidedBy.slice(0, sep) : b.decidedBy;
    const claimed = sep > 0 ? b.decidedBy.slice(sep + 1) : '';
    const identity = /^agent-[a-z_]+-\d+$/i.test(claimed) ? claimed : h.owner;
    const entry = `${role}:${identity}`;

    const requiredRoles = PENDING_APPROVAL.deciders.map(d => d.role);
    const before = countDistinctRoleMatches(requiredRoles, h.decidedBy);
    const after = countDistinctRoleMatches(requiredRoles, [...h.decidedBy, entry]);
    if (after === before) {
      return {
        ok: false,
        error: { type: '4xx', message: `裁决未计入：身份 ${entry} 已在本审批中行使过投票权` },
      };
    }

    h.decidedBy.push(entry);
    h.status = after >= 2 ? 'APPROVED' : 'PENDING';
    return {
      ok: true,
      data: {
        ...PENDING_APPROVAL,
        decidedBy: [...h.decidedBy],
        status: h.status,
        ...(h.status === 'PENDING'
          ? {
            quorumBlocked: {
              required: 2,
              matched: after,
              remainingIdentities: 2 - after,
              reason: `已记录本身份的裁决，仍需 ${2 - after} 位不同身份的审批人`,
            },
          }
          : {}),
      },
    };
  }),
  apiPut: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
  apiPatch: vi.fn(async () => ({ ok: false, error: { type: '4xx', message: 'n/a' } })),
}));

import { ToolGroup } from '../../Client/src/ai-components/harness/ToolGroup';
import ApprovalQueue from '../../Client/src/views/ApprovalQueue';
import {
  useApprovalStore,
  countDistinctRoleMatches,
  type Approval,
} from '../../Client/src/stores/approvalStore';

const PENDING_APPROVAL: Approval = {
  approvalId: 'ap-1',
  loopId: 'loop-1',
  iteration: 1,
  kind: 'irreversible_action',
  riskLevel: 'CRITICAL',
  requestedBy: 'agent-1',
  payload: { toolName: 'ShellExec', arguments: { command: 'dir' } },
  status: 'PENDING',
  timeoutSec: 60,
  requestedAt: Date.now(),
  deciders: [{ role: 'user', weight: 1 }, { role: 'prime_director', weight: 1 }],
  decisionPolicy: 'unanimous',
};

function toolCalls(approvalStatus?: 'pending' | 'approved' | 'rejected' | 'timeout' | 'auto-approved') {
  return [{
    id: 'tc-1',
    name: 'ShellExec',
    arguments: { command: 'dir' },
    status: 'pending' as const,
    approvalId: 'ap-1',
    approvalStatus,
  }];
}

beforeEach(() => {
  h.posts.length = 0;
  h.decidedBy.length = 0;
  h.owner = 'local';
  h.status = 'PENDING';
  h.approvals = [PENDING_APPROVAL];
  useApprovalStore.setState({
    approvals: [PENDING_APPROVAL],
    loading: false,
    lastError: null,
    lastErrorId: null,
    listError: null,
  });
  vi.clearAllMocks();
});

describe('工具行内嵌审批', () => {
  it('阻塞期间显示 L0 审查中 + 确认/拒绝按钮', () => {
    render(<ToolGroup toolCalls={toolCalls('pending')} />);
    expect(screen.getByText(/L0 级权限审查中/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /确认执行/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /拒绝/ })).toBeInTheDocument();
  });

  it('点击"确认执行"走与审批栏相同的决策接口', async () => {
    render(<ToolGroup toolCalls={toolCalls('pending')} />);

    fireEvent.click(screen.getByRole('button', { name: /确认执行/ }));

    await waitFor(() => expect(h.posts.length).toBeGreaterThan(0));
    expect(h.posts[0]?.path).toBe('/api/approvals/ap-1/decide');
    expect(h.posts[0]?.body).toMatchObject({ approve: true });
  });

  it('自动通过（策略白名单）不再要求用户确认', () => {
    render(<ToolGroup toolCalls={toolCalls('auto-approved')} />);
    expect(screen.getByText(/已自动通过（策略白名单）/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /确认执行/ })).not.toBeInTheDocument();
  });

  it('拒绝/超时显示结果且不显示确认按钮', () => {
    const { rerender } = render(<ToolGroup toolCalls={toolCalls('rejected')} />);
    expect(screen.getByText(/审批被拒绝（工具未执行）/)).toBeInTheDocument();

    rerender(<ToolGroup toolCalls={toolCalls('timeout')} />);
    expect(screen.getByText(/审批超时，已默认拒绝/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /确认执行/ })).not.toBeInTheDocument();
  });

  it('审批记录落定后（事件缺失）卡片也切换为已通过，按钮移除', async () => {
    // 工具行没有 approvalStatus（模拟 APPROVAL_DECIDED 事件未带 toolCallId 的旧路径），
    // 但审批栏/store 内同一条记录已落定 → 卡片必须反映为已通过
    useApprovalStore.setState({
      approvals: [{ ...PENDING_APPROVAL, status: 'APPROVED' }],
      loading: false,
    });
    render(<ToolGroup toolCalls={[{ id: 'tc-1', name: 'ShellExec', arguments: {}, status: 'pending', approvalId: 'ap-1' }]} />);

    expect(screen.getByText(/审批已通过，工具已放行执行/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /确认执行/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /拒绝/ })).not.toBeInTheDocument();
  });

  it('store 尚未拉取到该审批时：先取详情再提交一票，并如实显示法定人数缺口', async () => {
    // 审批栏轮询还没跑到 → store 为空（此前会拿不到决策池角色，投错角色而永久 PENDING）
    useApprovalStore.setState({ approvals: [] });

    render(<ToolGroup toolCalls={toolCalls('pending')} />);
    fireEvent.click(screen.getByRole('button', { name: /确认执行/ }));

    await waitFor(() => expect(h.posts.length).toBe(1));
    expect((h.posts[0]!.body as { decidedBy: string }).decidedBy).toBe('user:human-operator');
    // 一票 = 一个身份 → 只满足 1/2，状态仍是 PENDING，缺口必须回传并显示
    expect(useApprovalStore.getState().approvals[0]?.status).toBe('PENDING');
    expect(useApprovalStore.getState().approvals[0]?.quorumBlocked?.remainingIdentities).toBe(1);
    expect(await screen.findByText(/仍需 1 位不同身份的审批人/)).toBeInTheDocument();
  });

  it('双人控制按不同身份判定：同一身份第二次点击被拒且原因可见（不再假通过）', async () => {
    render(<ToolGroup toolCalls={toolCalls('pending')} />);

    fireEvent.click(screen.getByRole('button', { name: /确认执行/ }));
    await waitFor(() => expect(h.posts.length).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /确认执行/ }));
    await waitFor(() => expect(h.posts.length).toBe(2));

    // 第二票由同一身份投出 → 后端当场拒绝，前端显示原文（旧行为：静默补齐角色后永久阻塞）
    expect(useApprovalStore.getState().lastError).toContain('已在本审批中行使过投票权');
    expect(useApprovalStore.getState().approvals[0]?.status).toBe('PENDING');
  });

  it('两处同步：两位不同身份分别裁决后落定 APPROVED，审批栏同步显示已通过', async () => {
    render(
      <>
        <ToolGroup toolCalls={toolCalls('pending')} />
        <ApprovalQueue embedded />
      </>,
    );
    await waitFor(() => expect(screen.getByText('ap-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /确认执行/ }));
    await waitFor(() => expect(h.posts.length).toBe(1));

    // 另一位操作者登录（活动账号切换）后投第二票：应投给仍未被满足的角色
    h.owner = 'account-b';
    fireEvent.click(screen.getByRole('button', { name: /确认执行/ }));

    await waitFor(() => expect(h.posts.length).toBe(2));
    expect((h.posts[1]!.body as { decidedBy: string }).decidedBy).toBe('prime_director:human-operator');
    await waitFor(() => {
      expect(useApprovalStore.getState().approvals[0]?.status).toBe('APPROVED');
    });
    expect(h.decidedBy).toEqual(['user:local', 'prime_director:account-b']);
    await waitFor(() => expect(screen.getByText('已通过')).toBeInTheDocument());
  });

  it('评审记录读取失败时区分于"没有审批"（REV-317 只读轨迹）', async () => {
    const apiGet = vi.mocked((await import('@/services/api')).apiGet);
    apiGet.mockImplementation(async (path: string) => {
      if (path === '/api/reviews') return { ok: false, error: { type: 'network', message: '评审记录不可达' } };
      if (path.startsWith('/api/approvals/')) return { ok: true, data: PENDING_APPROVAL };
      return { ok: true, data: [PENDING_APPROVAL] };
    });

    render(<ApprovalQueue embedded />);
    await waitFor(() => expect(screen.getByText(/评审记录读取失败/)).toBeInTheDocument());
    expect(screen.getByText(/1 项待处理/)).toBeInTheDocument();
  });
});
