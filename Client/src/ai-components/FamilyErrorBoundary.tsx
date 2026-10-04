/**
 * FamilyErrorBoundary——族级错误边界。
 * Docs/Client/03-AI组件族架构 §3.4。
 *
 * 职责：
 * - 单个 AI 组件崩溃不导致整个聊天白屏
 * - 不同族之间互不影响
 * - 错误日志输出（预留 Sentry 上报接口）
 *
 * 使用方式：
 * ```tsx
 * <FamilyErrorBoundary family="harness">
 *   <HarnessComponents />
 * </FamilyErrorBoundary>
 * ```
 */

import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { FallbackUI } from './FallbackUI';

interface Props {
  /** 族名（用于日志和降级 UI） */
  family: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class FamilyErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 错误日志（预留 Sentry 上报接口）
    console.error(
      `[${this.props.family} 族错误]`,
      error,
      info.componentStack,
    );
    // TODO: reportErrorToSentry(error, {
    //   tags: { family: this.props.family },
    //   extra: { componentStack: info.componentStack },
    // });
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: undefined });
  };

  render() {
    if (this.state.hasError) {
      return (
        <FallbackUI
          family={this.props.family}
          error={this.state.error}
          onRetry={this.handleRetry}
        />
      );
    }
    return this.props.children;
  }
}
