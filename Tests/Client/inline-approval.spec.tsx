/**
 * @vitest-environment jsdom
 *
 * 内嵌审批回归（2026-10-01 FE-024）：
 * - 被安全门阻塞的危险工具，其审批卡**内嵌在对话中的工具行**里；
 * - 与左侧「审批栏」读同一份 approvalStore → 任一处决策都同步生效；
 * - 自动审批（策略白名单）无需用户确认，显示已自动通过；拒绝/超时显示对应结果。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const h = vi.hoisted(() => ({ posts: [] as Array<{ path: string; body: unknown }>, approvals: [] as unknown[] }));

vi.mock('@/services/api', () => ({
  apiGet: vi.fn(async (path: string) => {
    // 审批详情端点：点击时若 store 里还没有该审批，decide 会拉详情取所需角色
    if (path.startsWith('/api/approvals/')) return { ok: true, data: PENDING_APPROVAL };
    return { ok: true, data: h.approvals };
  }),
  apiPost: vi.fn(async (path: string, body: unknown) => {
  apiPut: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
    h.posts.push({ path, body });
    // 模拟后端 unanimous 策略：集齐 2 个不同角色才落 APPROVED
    const roles = new Set(h.posts.map(p => String((p.body as { decidedBy?: string }).decidedBy ?? '')));
    const status = roles.size >= 2 ? 'APPROVED' : 'PENDING';
    return { ok: true, data: { approvalId: 'ap-1', status, decidedBy: [...roles] } };
  }),
  apiPatch: vi.fn(async () => ({ ok: false, error: { type: '4xx', message: 'n/a' } })),
}));

import { ToolGroup } from '../../Client/src/ai-components/harness/ToolGroup';
import ApprovalQueue from '../../Client/src/views/ApprovalQueue';
import { useApprovalStore, type Approval } from '../../Client/src/stores/approvalStore';

const PENDING_APPROVAL: Approval = {
  approvalId: 'ap-1',
  loopId: 'loop-1',
  iteration: 1,
  kind: 'irreversible_action',
  riskLevel: 'CRITICAL',
  requestedBy: 'agent-1',
  payload: { toolName: 'shell.exec', arguments: { command: 'dir' } },
  status: 'PENDING',
  timeoutSec: 60,
  requestedAt: Date.now(),
  deciders: [{ role: 'user', weight: 1 }, { role: 'prime_director', weight: 1 }],
  decisionPolicy: 'unanimous',
};

function toolCalls(approvalStatus?: 'pending' | 'approved' | 'rejected' | 'timeout' | 'auto-approved') {
  return [{
    id: 'tc-1',
    name: 'shell.exec',
    arguments: { command: 'dir' },
    status: 'pending' as const,
    approvalId: 'ap-1',
    approvalStatus,
  }];
}

beforeEach(() => {
  h.posts.length = 0;
  h.approvals = [PENDING_APPROVAL];
  useApprovalStore.setState({ approvals: [PENDING_APPROVAL], loading: false });
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
    render(<ToolGroup toolCalls={[{ id: 'tc-1', name: 'shell.exec', arguments: {}, status: 'pending', approvalId: 'ap-1' }]} />);

    expect(screen.getByText(/审批已通过，工具已放行执行/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /确认执行/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /拒绝/ })).not.toBeInTheDocument();
  });

  it('store 尚未拉取到该审批时，点击也能补齐全部角色（先取详情再逐个提交）', async () => {
    // 审批栏轮询还没跑到 → store 为空（此前会导致只提交 1/N，工具一直阻塞）
    useApprovalStore.setState({ approvals: [], loading: false });

    render(<ToolGroup toolCalls={toolCalls('pending')} />);
    fireEvent.click(screen.getByRole('button', { name: /确认执行/ }));

    await waitFor(() => {
      expect(h.posts.map(p => (p.body as { decidedBy: string }).decidedBy)).toEqual([
        'user:human-operator',
        'prime_director:human-operator',
      ]);
    });
    expect(useApprovalStore.getState().approvals[0]?.status).toBe('APPROVED');
  });

  it('单操作者模式：一次点击依次满足双角色策略（否则永远阻塞到超时）', async () => {
    render(<ToolGroup toolCalls={toolCalls('pending')} />);

    fireEvent.click(screen.getByRole('button', { name: /确认执行/ }));

    await waitFor(() => {
      expect(h.posts.map(p => (p.body as { decidedBy: string }).decidedBy)).toEqual([
        'user:human-operator',
        'prime_director:human-operator',
      ]);
    });
    expect(useApprovalStore.getState().approvals[0]?.status).toBe('APPROVED');
  });

  it('两处同步：内嵌卡决策后，审批栏同步反映为已通过', async () => {
    // 同时渲染"对话中的内嵌卡"与"审批栏"（两者都读 approvalStore）
    render(
      <>
        <ToolGroup toolCalls={toolCalls('pending')} />
        <ApprovalQueue embedded />
      </>,
    );
    await waitFor(() => expect(screen.getByText('ap-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /确认执行/ }));

    // 同一条审批被更新 → 审批栏卡片同步显示决策后状态
    await waitFor(() => {
      expect(useApprovalStore.getState().approvals[0]?.status).toBe('APPROVED');
    });
    await waitFor(() => expect(screen.getByText('已通过')).toBeInTheDocument());
  });
});
