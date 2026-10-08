/**
 * ErrorBoundary——渲染进程兜底（2026-10-07 新增）。
 *
 * 背景：实测"跳过初始化引导后整个窗口全黑"——React 子树抛异常后没有任何兜底，
 * 用户只看到黑屏、也没有任何可复制的信息。这里做三件事：
 *   1. 捕获渲染异常，展示**可读的错误 + 组件栈**，而不是黑屏；
 *   2. 提供"重新加载"与"复制诊断信息"两个动作（用户能直接发给我们）；
 *   3. 把错误同时 `console.error`，由主进程转发进日志（见 electron/main.ts 的 console-message 监听）。
 *
 * 注意：错误边界只能捕获**渲染期**异常。事件回调/异步里的异常不会触发它，
 * 但那类错误会出现在主进程日志的 `[Renderer:error]` 行里。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

const boxStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '28px 32px',
  overflow: 'auto',
  background: 'var(--color-surface-950, #11111b)',
  color: 'var(--color-text-primary, #cdd6f4)',
  fontFamily: 'var(--font-sans, system-ui, sans-serif)',
};

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--color-surface-700, #313244)',
  borderRadius: 10,
  padding: '14px 16px',
  background: 'color-mix(in srgb, var(--color-surface-800, #1e1e2e) 55%, transparent)',
};

const preStyle: React.CSSProperties = {
  margin: '8px 0 0',
  padding: '10px 12px',
  borderRadius: 8,
  background: 'var(--color-surface-900, #11111b)',
  color: 'var(--color-text-secondary, #a6adc8)',
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: 11.5,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  userSelect: 'text',
  maxHeight: 260,
  overflow: 'auto',
};

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 进主进程日志（Electron 的 console-message 监听会带上 [Renderer:error] 前缀）
    console.error('[界面异常]', error?.message, info?.componentStack);
    this.setState({ info });
  }

  private diagnostics(): string {
    const { error, info } = this.state;
    return [
      `时间：${new Date().toISOString()}`,
      `错误：${error?.name ?? 'Error'}: ${error?.message ?? '(无)'}`,
      `版本：${(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ?? 'unknown'}`,
      `UA：${navigator.userAgent}`,
      '--- 组件栈 ---',
      info?.componentStack ?? '(无)',
      '--- JS 栈 ---',
      error?.stack ?? '(无)',
    ].join('\n');
  }

  private copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(this.diagnostics());
    } catch {
      // 剪贴板不可用（无权限）：退化为选中文本，用户可手动复制
    }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div style={boxStyle}>
        <div style={{ fontSize: 18, fontWeight: 650 }}>界面渲染出错了</div>
        <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary, #a6adc8)' }}>
          应用本体（后端服务、数据）仍在运行；这是前端某个视图的渲染异常。可以先点"重新加载界面"，
          若反复出现，请把下面的诊断信息复制给我们。
        </div>

        <div style={cardStyle}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>错误信息</div>
          <pre style={preStyle}>{this.diagnostics()}</pre>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: 'var(--color-brand-600, #7c3aed)', color: '#fff', fontSize: 12.5,
            }}
          >
            重新加载界面
          </button>
          <button
            onClick={() => void this.copy()}
            style={{
              padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5,
              background: 'transparent', color: 'var(--color-text-secondary, #a6adc8)',
              border: '1px solid var(--color-surface-700, #313244)',
            }}
          >
            复制诊断信息
          </button>
        </div>
      </div>
    );
  }
}
