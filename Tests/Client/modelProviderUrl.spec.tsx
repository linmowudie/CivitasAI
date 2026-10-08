/**
 * @vitest-environment jsdom
 *
 * 「添加供应商」表单：URL 可填可改 + 选预设自动填充 + 不选则自动识别（2026-10-08）。
 *
 * 需求原文：配置缺 URL 设置；不指定供应商时只填 URL 与密钥、自动识别供应商；
 * 选了供应商则自动填充 URL。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// IPC 层在 jsdom 下无 Electron，统一打桩（本测试只关心表单行为）
const addProvider = vi.fn().mockResolvedValue({ ok: true });
vi.mock('@/services/ipcApi', () => ({
  ipcVerifyModels: vi.fn().mockResolvedValue({ ok: true, data: { results: [] } }),
  ipcGetProviders: vi.fn().mockResolvedValue([]),
  ipcAddProvider: (...args: unknown[]) => addProvider(...args),
  ipcRemoveProvider: vi.fn().mockResolvedValue({ ok: true }),
  ipcFetchProviderModels: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  ipcGetRouting: vi.fn().mockResolvedValue(null),
  ipcUpdateRouting: vi.fn().mockResolvedValue({ ok: true }),
  ipcGetModels: vi.fn().mockResolvedValue([]),
  ipcLoadProviderSecrets: vi.fn().mockResolvedValue({ ok: true, data: { providers: [] } }),
  ipcSaveProviderSecrets: vi.fn().mockResolvedValue({ ok: true }),
}));

import ModelProviderPanel from '../../Client/src/components/Settings/ModelProviderPanel';

async function openForm() {
  render(<ModelProviderPanel />);
  fireEvent.click(screen.getByText('添加供应商'));
  await screen.findByText('添加新供应商');
  return {
    url: screen.getByLabelText('API 地址') as HTMLInputElement,
    key: screen.getByLabelText('API Key') as HTMLInputElement,
    select: screen.getByLabelText('选择供应商') as HTMLSelectElement,
  };
}

describe('ModelProviderPanel：API 地址与自动识别', () => {
  beforeEach(() => { addProvider.mockClear(); });

  it('表单里有可编辑的 API 地址输入框（此前只有只读展示）', async () => {
    const { url } = await openForm();
    expect(url).toBeInTheDocument();
    expect(url).toHaveValue('');
    expect(url.placeholder).toContain('https://');
  });

  it('选择供应商 → 自动填充该供应商的地址', async () => {
    const { url, select } = await openForm();
    fireEvent.change(select, { target: { value: 'deepseek' } });
    await waitFor(() => expect(url).toHaveValue('https://api.deepseek.com/v1'));
  });

  it('自动填充后仍可手动修改（不锁死）', async () => {
    const { url, select } = await openForm();
    fireEvent.change(select, { target: { value: 'deepseek' } });
    await waitFor(() => expect(url).toHaveValue('https://api.deepseek.com/v1'));
    fireEvent.change(url, { target: { value: 'https://api.deepseek.com/v2' } });
    expect(url).toHaveValue('https://api.deepseek.com/v2');
  });

  it('不选供应商、只填地址 → 自动识别出供应商', async () => {
    const { url, select } = await openForm();
    expect(select).toHaveValue('');
    fireEvent.change(url, { target: { value: 'https://api.modelarts-maas.com/plan/v2' } });
    await waitFor(() =>
      expect(screen.getByTestId('provider-detect-hint')).toHaveTextContent('自动识别：华为云 MaaS'),
    );
  });

  it('未知地址 → 明确告知按"自定义供应商（OpenAI 兼容）"接入', async () => {
    const { url } = await openForm();
    fireEvent.change(url, { target: { value: 'https://llm.internal.corp/v1' } });
    await waitFor(() =>
      expect(screen.getByTestId('provider-detect-hint')).toHaveTextContent('自定义供应商'),
    );
  });

  it('地址不合法时给出原因，且拉取/添加按钮不可用', async () => {
    const { url, key } = await openForm();
    fireEvent.change(url, { target: { value: 'api.deepseek.com/v1' } });
    fireEvent.change(key, { target: { value: 'sk-test' } });
    expect(await screen.findByText(/地址格式不对/)).toBeInTheDocument();
    expect(screen.getByText(/测试并拉取模型/)).toBeDisabled();
    expect(screen.getByTestId('add-provider-confirm')).toBeDisabled();
  });

  it('不选供应商也能提交：按识别出的供应商 id 与用户填写的地址注册', async () => {
    const { url, key } = await openForm();
    fireEvent.change(url, { target: { value: 'https://api.deepseek.com/v1' } });
    fireEvent.change(key, { target: { value: 'sk-test' } });
    const confirm = screen.getByTestId('add-provider-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);

    await waitFor(() => expect(addProvider).toHaveBeenCalledTimes(1));
    expect(addProvider.mock.calls[0]![0]).toMatchObject({
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-test',
      display_name: 'DeepSeek',
    });
  });
});
