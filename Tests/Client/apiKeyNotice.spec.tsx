/**
 * @vitest-environment jsdom
 *
 * 「未配置 API Key」弹窗与标记（2026-10-08）。
 *
 * 覆盖：
 *  - 前端标记常量必须与后端一致（防漂移，直接读后端源码断言）；
 *  - 标记识别与清理；
 *  - 弹窗渲染、「前往设置密钥」跳转到 feature/settings 并关闭。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';

import {
  MISSING_API_KEY_MARKER,
  isMissingApiKeyError,
  stripMissingApiKeyMarker,
} from '../../Client/src/shared/apiKeyNotice';
import ApiKeyDialog from '../../Client/src/components/Settings/ApiKeyDialog';
import { useUIStore } from '../../Client/src/stores/uiStore';

describe('MISSING_API_KEY 标记', () => {
  it('前端常量与后端源码中的常量一致（防止两侧漂移）', () => {
    const backendSrc = readFileSync(
      resolve(import.meta.dirname, '../../Src/Interface/IpcBridge/ipcBridge.ts'),
      'utf8',
    );
    // 引号风格无关（2026-10-15）：后端源码已统一为双引号，原正则只认单引号 → 误报。
    // 断言意图不变：仍严格比对两侧**取值**（下一行 expect(m![1]).toBe(...)）。
    const m = backendSrc.match(/export const MISSING_API_KEY_MARKER\s*=\s*['"]([^'"]*)['"]/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(MISSING_API_KEY_MARKER);
  });

  it('识别缺 Key 错误', () => {
    expect(isMissingApiKeyError(`${MISSING_API_KEY_MARKER}未配置 API Key：华为云`)).toBe(true);
    expect(isMissingApiKeyError('模型调用失败: 500')).toBe(false);
    expect(isMissingApiKeyError(undefined)).toBe(false);
  });

  it('清理标记后得到面向用户的文案', () => {
    const raw = `${MISSING_API_KEY_MARKER}未配置 API Key：huawei-maas（环境变量 X 未设置）。`;
    expect(stripMissingApiKeyMarker(raw)).toBe('未配置 API Key：huawei-maas（环境变量 X 未设置）。');
    // 非前缀位置出现时也一并清掉（防御式）
    expect(stripMissingApiKeyMarker(`a${MISSING_API_KEY_MARKER}b`)).toBe('ab');
  });
});

describe('ApiKeyDialog', () => {
  beforeEach(() => {
    useUIStore.setState({ apiKeyNotice: null, mainView: { type: 'conversation' } });
  });

  it('无提示时不渲染', () => {
    render(<ApiKeyDialog />);
    expect(screen.queryByTestId('api-key-dialog')).not.toBeInTheDocument();
  });

  it('有提示时渲染原因与两个动作', () => {
    useUIStore.setState({ apiKeyNotice: '未配置 API Key：huawei-maas（环境变量 X 未设置）。' });
    render(<ApiKeyDialog />);
    expect(screen.getByTestId('api-key-dialog')).toBeInTheDocument();
    expect(screen.getByText(/未配置 API Key：huawei-maas/)).toBeInTheDocument();
    expect(screen.getByText('前往设置密钥')).toBeInTheDocument();
    expect(screen.getByText('稍后处理')).toBeInTheDocument();
  });

  it('「前往设置密钥」→ 跳转到 feature/settings 并关闭弹窗', () => {
    useUIStore.setState({ apiKeyNotice: '缺 Key' });
    render(<ApiKeyDialog />);
    fireEvent.click(screen.getByText('前往设置密钥'));

    expect(useUIStore.getState().mainView).toEqual({ type: 'feature', id: 'settings' });
    expect(useUIStore.getState().apiKeyNotice).toBeNull();
  });

  it('「稍后处理」→ 仅关闭，不改视图', () => {
    useUIStore.setState({ apiKeyNotice: '缺 Key' });
    render(<ApiKeyDialog />);
    fireEvent.click(screen.getByText('稍后处理'));

    expect(useUIStore.getState().apiKeyNotice).toBeNull();
    expect(useUIStore.getState().mainView).toEqual({ type: 'conversation' });
  });
});
