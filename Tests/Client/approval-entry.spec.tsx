/**
 * @vitest-environment jsdom
 *
 * 人工审批入口回归测试。
 *
 * 背景：审批组件（ApprovalCard/approvalStore）此前已实现，但三栏工作区里
 * 没有入口、也没有主容器视图，只能手敲 /approvals 路由 —— 用户实际看不到审批。
 * 本测试锁定：左面板"审批"入口 + 待处理角标 + 点击进入审批视图 + 批准动作调用后端。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';

const h = vi.hoisted(() => ({ approvals: [] as unknown[] }));

vi.mock('@/services/api', () => ({
  apiGet: vi.fn(async () => ({ ok: true, data: h.approvals })),
  apiPost: vi.fn(async () => ({ ok: true, data: { approvalId: 'ap-1', status: 'PENDING' } })),
  apiPut: vi.fn(async () => ({ ok: false, error: { type: 'network', message: 'n/a' } })),
}));

import { apiPost } from '@/services/api';
import FeatureList from '../../Client/src/components/Layout/LeftPanel/FeatureList';
import ApprovalQueue from '../../Client/src/views/ApprovalQueue';
import { useUIStore } from '../../Client/src/stores/uiStore';
import { useApprovalStore } from '../../Client/src/stores/approvalStore';

function pendingApproval() {
  return {
    approvalId: 'ap-1',
    loopId: 'loop-1',
    iteration: 1,
    kind: 'irreversible_action',
    riskLevel: 'CRITICAL',
    requestedBy: 'agent-1',
    payload: { toolName: 'agent.recruit', arguments: { role: 'partner' } },
    status: 'PENDING',
    timeoutSec: 60,
    requestedAt: Date.now(),
    deciders: [{ role: 'user', weight: 1 }, { role: 'prime_director', weight: 1 }],
    decisionPolicy: 'unanimous',
  };
}

beforeEach(() => {
  h.approvals.length = 0;
  useApprovalStore.setState({ approvals: [] });
  useUIStore.setState({ mainView: { type: 'conversation' }, expandedFeatures: new Set<string>() });
  vi.clearAllMocks();
});

describe('审批入口（左面板）', () => {
  it('有待处理审批时显示入口与角标，点击后进入审批视图', async () => {
    h.approvals.push(pendingApproval());
    render(<FeatureList />);

    const entry = await screen.findByRole('button', { name: /审批/ });
    // 待处理角标
    await waitFor(() => expect(screen.getByTitle('1 项待审批')).toBeInTheDocument());

    fireEvent.click(entry);
    expect(useUIStore.getState().mainView).toEqual({ type: 'feature', id: 'approvals' });
  });

  it('无待处理审批时不显示角标', async () => {
    render(<FeatureList />);
    await screen.findByRole('button', { name: /审批/ });
    await waitFor(() => expect(useApprovalStore.getState().loading).toBe(false));
    expect(screen.queryByTitle(/项待审批/)).not.toBeInTheDocument();
  });
});

describe('审批视图（主容器内嵌）', () => {
  it('渲染待审批卡片，点击"批准"调用决策接口', async () => {
    h.approvals.push(pendingApproval());
    render(<ApprovalQueue embedded />);

    await waitFor(() => expect(screen.getByText('ap-1')).toBeInTheDocument());
    // 危险等级与请求信息可见
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
    expect(screen.getByText(/agent\.recruit/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /批准/ }));

    await waitFor(() => {
      // 单操作者模式：以所需角色（deciders[0] = user）提交，审计留痕 role:操作者
      expect(apiPost).toHaveBeenCalledWith(
        '/api/approvals/ap-1/decide',
        expect.objectContaining({ approve: true, decidedBy: 'user:human-operator' }),
      );
    });
  });

  it('无审批时显示空态', async () => {
    render(<ApprovalQueue embedded />);
    await waitFor(() => expect(screen.getByText('暂无审批请求')).toBeInTheDocument());
  });

  it('payload 缺失的审批不会导致视图崩溃', async () => {
    // 决策接口只回传状态时，store 中的数据可能没有 payload
    h.approvals.push({ ...pendingApproval(), payload: undefined });
    render(<ApprovalQueue embedded />);
    await waitFor(() => expect(screen.getByText('ap-1')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /批准/ })).toBeInTheDocument();
  });
});
