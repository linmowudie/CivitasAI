/**
 * @vitest-environment jsdom
 *
 * AI 组件族 React 组件测试。
 *
 * 测试范围：
 * - StreamBuffer：流式内容渲染
 * - CoTFolder：思维链折叠/展开
 * - MessageShell：消息外壳布局
 * - ToolGroup：工具调用展示
 * - AIEventBus + Subscribe：事件订阅容器
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';

// ── Mock 依赖 ───────────────────────────────────────────────────────

// Mock MarkdownRenderer
vi.mock('@/components/Chat/MarkdownRenderer', () => ({
  default: ({ content, isStreaming }: { content: string; isStreaming: boolean }) => (
    <div data-testid="markdown" data-streaming={isStreaming}>{content}</div>
  ),
}));

// Mock eventBusBridge
vi.mock('@/services/eventBusBridge', () => ({
  subscribe: vi.fn(() => vi.fn()),
  connectBridge: vi.fn(),
  disconnectBridge: vi.fn(),
  send: vi.fn(),
}));

// Mock systemStore
vi.mock('@/stores/systemStore', () => ({
  useSystemStore: { getState: () => ({ setOnline: vi.fn() }) },
}));

// ── 导入组件 ────────────────────────────────────────────────────────

import { StreamBuffer } from '../../Client/src/ai-components/core/StreamBuffer';
import { CoTFolder } from '../../Client/src/ai-components/core/CoTFolder';
import { MessageShell } from '../../Client/src/ai-components/core/MessageShell';
import { ToolGroup } from '../../Client/src/ai-components/harness/ToolGroup';
import { AIEventBus } from '../../Client/src/ai-components/AIEventBus';
import { Subscribe } from '../../Client/src/ai-components/Subscribe';
import { FamilyErrorBoundary } from '../../Client/src/ai-components/FamilyErrorBoundary';
import { FallbackUI } from '../../Client/src/ai-components/FallbackUI';
import { useEventStore } from '../../Client/src/stores/eventStore';
import type { ToolCallEntry } from '../../Client/src/stores/chatStore';

// ── StreamBuffer 测试 ───────────────────────────────────────────────

describe('StreamBuffer', () => {
  it('有内容时渲染 Markdown', () => {
    render(<StreamBuffer content="Hello world" isStreaming={false} />);
    expect(screen.getByTestId('markdown')).toHaveTextContent('Hello world');
  });

  it('无内容且非流式时不渲染', () => {
    const { container } = render(<StreamBuffer content="" isStreaming={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('流式中无内容时仍渲染', () => {
    render(<StreamBuffer content="" isStreaming={true} />);
    expect(screen.getByTestId('markdown')).toBeTruthy();
  });

  it('传递 isStreaming 到 MarkdownRenderer', () => {
    render(<StreamBuffer content="test" isStreaming={true} />);
    expect(screen.getByTestId('markdown').getAttribute('data-streaming')).toBe('true');
  });

  it('包裹在 streamBuffer CSS Module 类中', () => {
    const { container } = render(<StreamBuffer content="test" isStreaming={false} />);
    // CSS Module 类名在 vitest 中为 identity mapping
    expect(container.querySelector('[class]')).toBeTruthy();
  });
});

// ── CoTFolder 测试 ──────────────────────────────────────────────────

describe('CoTFolder', () => {
  it('无 reasoning 时不渲染', () => {
    const { container } = render(<CoTFolder reasoning="" isStreaming={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('有 reasoning 时渲染折叠区', () => {
    render(<CoTFolder reasoning="Let me think..." isStreaming={false} />);
    expect(screen.getByText('思考过程')).toBeTruthy();
  });

  it('流式中显示"思考中…"', () => {
    render(<CoTFolder reasoning="Thinking..." isStreaming={true} />);
    expect(screen.getByText('思考中…')).toBeTruthy();
  });

  it('流式期间默认展开', () => {
    render(<CoTFolder reasoning="Thinking..." isStreaming={true} />);
    expect(screen.getByText('Thinking...')).toBeTruthy();
  });

  it('非流式默认折叠，点击展开', () => {
    render(<CoTFolder reasoning="Hidden thought" isStreaming={false} />);
    // 默认折叠，内容不可见
    expect(screen.queryByText('Hidden thought')).toBeNull();

    // 点击展开
    fireEvent.click(screen.getByText('思考过程'));
    expect(screen.getByText('Hidden thought')).toBeTruthy();
  });

  it('展开后再次点击折叠', () => {
    render(<CoTFolder reasoning="Toggle me" isStreaming={false} />);

    // 展开
    fireEvent.click(screen.getByText('思考过程'));
    expect(screen.getByText('Toggle me')).toBeTruthy();

    // 折叠
    fireEvent.click(screen.getByText('思考过程'));
    expect(screen.queryByText('Toggle me')).toBeNull();
  });
});

// ── MessageShell 测试 ───────────────────────────────────────────────

describe('MessageShell', () => {
  it('用户消息：显示"你"和用户头像', () => {
    render(
      <MessageShell role="user" status="complete" createdAt={Date.now()}>
        <span>Test content</span>
      </MessageShell>
    );
    expect(screen.getByText('你')).toBeTruthy();
    expect(screen.getByText('Test content')).toBeTruthy();
  });

  it('助手消息：显示"Assistant"', () => {
    render(
      <MessageShell role="assistant" status="complete" createdAt={Date.now()}>
        <span>AI response</span>
      </MessageShell>
    );
    expect(screen.getByText('Assistant')).toBeTruthy();
    expect(screen.getByText('AI response')).toBeTruthy();
  });

  it('系统消息：居中显示', () => {
    const { container } = render(
      <MessageShell role="system" status="complete" createdAt={Date.now()}>
        System event
      </MessageShell>
    );
    // 系统消息使用 flex justify-center 布局
    expect(screen.getByText('System event')).toBeTruthy();
  });

  it('显示模型名称（仅助手消息）', () => {
    render(
      <MessageShell role="assistant" status="complete" createdAt={Date.now()} model="gpt-4">
        <span>content</span>
      </MessageShell>
    );
    expect(screen.getByText('gpt-4')).toBeTruthy();
  });

  it('显示 Token 消耗', () => {
    render(
      <MessageShell role="assistant" status="complete" createdAt={Date.now()} tokensUsed={1234}>
        <span>content</span>
      </MessageShell>
    );
    expect(screen.getByText(/1234 tok/)).toBeTruthy();
  });

  it('显示迭代轮次', () => {
    render(
      <MessageShell role="assistant" status="complete" createdAt={Date.now()} totalIterations={3}>
        <span>content</span>
      </MessageShell>
    );
    expect(screen.getByText('3 轮迭代')).toBeTruthy();
  });

  it('非 complete 状态显示状态图标', () => {
    render(
      <MessageShell role="assistant" status="streaming" createdAt={Date.now()}>
        <span>content</span>
      </MessageShell>
    );
    expect(screen.getByText('生成中')).toBeTruthy();
  });

  it('complete 状态不显示状态标签', () => {
    render(
      <MessageShell role="assistant" status="complete" createdAt={Date.now()}>
        <span>content</span>
      </MessageShell>
    );
    expect(screen.queryByText('生成中')).toBeNull();
  });

  it('error 状态显示错误提示', () => {
    render(
      <MessageShell role="assistant" status="error" createdAt={Date.now()}>
        <span>content</span>
      </MessageShell>
    );
    expect(screen.getByText(/生成出错/)).toBeTruthy();
  });

  it('error 状态展示后端返回的具体原因', () => {
    render(
      <MessageShell
        role="assistant"
        status="error"
        createdAt={Date.now()}
        error="环境变量 HUAWEI_MAAS_API_KEY 未设置"
      >
        <span>content</span>
      </MessageShell>
    );
    expect(screen.getByText(/环境变量 HUAWEI_MAAS_API_KEY 未设置/)).toBeTruthy();
    expect(screen.getByText(/生成出错/)).toBeTruthy();
  });
});

// ── ToolGroup 测试 ──────────────────────────────────────────────────

describe('ToolGroup', () => {
  const mockToolCalls: ToolCallEntry[] = [
    {
      id: 'tc-1',
      name: 'read_file',
      arguments: { path: '/test.txt' },
      status: 'success',
      content: 'file content here',
    },
    {
      id: 'tc-2',
      name: 'exec_run',
      arguments: { cmd: 'ls -la' },
      status: 'error',
      error: { code: 'EXEC_FAIL', message: 'Command failed' },
    },
    {
      id: 'tc-3',
      name: 'write_output',
      arguments: {},
      status: 'pending',
    },
  ];

  it('空工具列表不渲染', () => {
    const { container } = render(<ToolGroup toolCalls={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('有工具调用时显示工具数量', () => {
    render(<ToolGroup toolCalls={mockToolCalls} />);
    expect(screen.getByText('3 次')).toBeTruthy();
  });

  it('显示多轮迭代标识', () => {
    render(<ToolGroup toolCalls={mockToolCalls} totalIterations={3} />);
    expect(screen.getByText('3 轮')).toBeTruthy();
  });

  it('单轮迭代不显示轮次标识', () => {
    render(<ToolGroup toolCalls={mockToolCalls} totalIterations={1} />);
    expect(screen.queryByText('1 轮')).toBeNull();
  });

  it('点击工具名展开参数详情', () => {
    render(<ToolGroup toolCalls={mockToolCalls} />);

    // 点击第一个工具
    const toolButtons = screen.getAllByText(/read_file|exec_run|write_output/);
    fireEvent.click(toolButtons[0].closest('button')!);

    // 展开后显示参数
    expect(screen.getByText('参数：')).toBeTruthy();
  });

  it('显示工具子分组 badge', () => {
    render(<ToolGroup toolCalls={mockToolCalls} />);
    expect(screen.getByText('read')).toBeTruthy();
    expect(screen.getByText('exec')).toBeTruthy();
    expect(screen.getByText('write')).toBeTruthy();
  });

  it('默认展开工具列表', () => {
    render(<ToolGroup toolCalls={mockToolCalls} />);
    // 工具名可见说明列表已展开
    expect(screen.getByText('read_file')).toBeTruthy();
  });

  it('点击折叠按钮收起工具列表', () => {
    render(<ToolGroup toolCalls={mockToolCalls} />);
    // 点击"工具调用"按钮
    fireEvent.click(screen.getByText('工具调用'));
    // 工具名不可见
    expect(screen.queryByText('read_file')).toBeNull();
  });
});

// ── AIEventBus + Subscribe 测试 ─────────────────────────────────────

describe('AIEventBus + Subscribe', () => {
  // 每个测试前清空事件缓冲（zustand store 是单例）
  beforeEach(() => {
    useEventStore.getState().clearEvents();
  });

  it('AIEventBus 提供事件上下文（空缓冲）', () => {
    render(
      <AIEventBus sessionId="session-1">
        <Subscribe eventTypes={['agent:stream_chunk']}>
          {(events) => <div data-testid="sub">{events.length} events</div>}
        </Subscribe>
      </AIEventBus>
    );

    expect(screen.getByTestId('sub')).toHaveTextContent('0 events');
  });

  it('Subscribe 无匹配事件时渲染空数组', () => {
    render(
      <AIEventBus sessionId="session-1">
        <Subscribe eventTypes={['nonexistent:event']}>
          {(events) => <div data-testid="sub">{events.length} events</div>}
        </Subscribe>
      </AIEventBus>
    );

    expect(screen.getByTestId('sub')).toHaveTextContent('0 events');
  });

  it('从 eventStore 读取事件（单一数据源验证）', () => {
    render(
      <AIEventBus sessionId="session-1">
        <Subscribe eventTypes={['agent:*']}>
          {(events) => <div data-testid="sub">{events.length} events</div>}
        </Subscribe>
      </AIEventBus>
    );

    // 通过 eventStore 推入事件（模拟 useEventBus 的行为）
    act(() => {
      useEventStore.getState().pushEvent({ type: 'agent:stream_chunk', data: {}, timestamp: Date.now() });
      useEventStore.getState().pushEvent({ type: 'agent:stream_end', data: {}, timestamp: Date.now() });
    });

    expect(screen.getByTestId('sub')).toHaveTextContent('2 events');
  });

  it('切换 sessionId 时清空事件缓冲', () => {
    // 先推入事件
    act(() => {
      useEventStore.getState().pushEvent({ type: 'test:evt', data: {}, timestamp: Date.now() });
    });

    const { rerender } = render(
      <AIEventBus sessionId="session-1">
        <Subscribe eventTypes={['test:*']}>
          {(events) => <div data-testid="sub">{events.length}</div>}
        </Subscribe>
      </AIEventBus>
    );

    expect(screen.getByTestId('sub')).toHaveTextContent('1');

    // 切换 session → 触发 clearEvents
    act(() => {
      rerender(
        <AIEventBus sessionId="session-2">
          <Subscribe eventTypes={['test:*']}>
            {(events) => <div data-testid="sub">{events.length}</div>}
          </Subscribe>
        </AIEventBus>
      );
    });

    // 事件已清空
    expect(screen.getByTestId('sub')).toHaveTextContent('0');
  });

  it('无 children 时尝试注册表动态渲染（无匹配组件时不渲染）', () => {
    render(
      <AIEventBus sessionId="session-1">
        <Subscribe eventTypes={['unknown:event_type']} />
      </AIEventBus>
    );

    // 无匹配组件，不渲染任何内容
    const { container } = render(
      <AIEventBus sessionId="session-1">
        <Subscribe eventTypes={['unknown:event_type']} />
      </AIEventBus>
    );
    expect(container.innerHTML).toBe('');
  });
});

// ── FamilyErrorBoundary 测试 ─────────────────────────────────────────

describe('FamilyErrorBoundary', () => {
  // 抑制错误边界测试中的 console.error
  const origError = console.error;
  beforeEach(() => { console.error = vi.fn(); });
  afterEach(() => { console.error = origError; });

  it('正常渲染子组件', () => {
    render(
      <FamilyErrorBoundary family="test">
        <div data-testid="child">Hello</div>
      </FamilyErrorBoundary>
    );
    expect(screen.getByTestId('child')).toHaveTextContent('Hello');
  });

  it('子组件崩溃时显示 FallbackUI', () => {
    const ThrowError = () => { throw new Error('Test crash'); };

    render(
      <FamilyErrorBoundary family="harness">
        <ThrowError />
      </FamilyErrorBoundary>
    );

    expect(screen.getByText(/harness 族组件加载失败/)).toBeTruthy();
  });

  it('开发环境显示错误详情', () => {
    const ThrowError = () => { throw new Error('Detailed error msg'); };

    render(
      <FamilyErrorBoundary family="core">
        <ThrowError />
      </FamilyErrorBoundary>
    );

    // vitest 默认 DEV 模式
    expect(screen.getByText(/Detailed error msg/)).toBeTruthy();
  });

  it('点击重试可恢复', () => {
    let shouldThrow = true;
    const MaybeThrow = () => {
      if (shouldThrow) throw new Error('crash');
      return <div data-testid="recovered">Recovered</div>;
    };

    const { rerender } = render(
      <FamilyErrorBoundary family="test">
        <MaybeThrow />
      </FamilyErrorBoundary>
    );

    expect(screen.getByText(/test 族组件加载失败/)).toBeTruthy();

    // 修复错误源，点击重试
    shouldThrow = false;
    fireEvent.click(screen.getByText('重试'));

    expect(screen.getByTestId('recovered')).toHaveTextContent('Recovered');
  });
});

// ── FallbackUI 测试 ──────────────────────────────────────────────────

describe('FallbackUI', () => {
  it('显示族名和失败提示', () => {
    render(<FallbackUI family="memory" />);
    expect(screen.getByText(/memory 族组件加载失败/)).toBeTruthy();
  });

  it('提供 onRetry 时显示重试按钮', () => {
    const onRetry = vi.fn();
    render(<FallbackUI family="loop" onRetry={onRetry} />);
    const btn = screen.getByText('重试');
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('无 onRetry 时不显示重试按钮', () => {
    render(<FallbackUI family="core" />);
    expect(screen.queryByText('重试')).toBeNull();
  });
});
