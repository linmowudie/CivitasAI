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
const fetchModels = vi.fn().mockResolvedValue({ ok: true, data: [] });
vi.mock('@/services/ipcApi', () => ({
  ipcVerifyModels: vi.fn().mockResolvedValue({ ok: true, data: { results: [] } }),
  ipcGetProviders: vi.fn().mockResolvedValue([]),
  ipcAddProvider: (...args: unknown[]) => addProvider(...args),
  ipcRemoveProvider: vi.fn().mockResolvedValue({ ok: true }),
  ipcFetchProviderModels: (...args: unknown[]) => fetchModels(...args),
  ipcGetRouting: vi.fn().mockResolvedValue(null),
  ipcUpdateRouting: vi.fn().mockResolvedValue({ ok: true }),
  ipcGetModels: vi.fn().mockResolvedValue([]),
  ipcLoadProviderSecrets: vi.fn().mockResolvedValue({ ok: true, data: { providers: [] } }),
  ipcSaveProviderSecrets: vi.fn().mockResolvedValue({ ok: true }),
}));

import ModelProviderPanel from '../../Client/src/components/Settings/ModelProviderPanel';

const MODEL_SPEC = (id: string) => ({
  id,
  context_window: 128000,
  max_output: 8192,
  supports_vision: false,
  supports_tools: true,
  cost_per_1k_input: 0,
  cost_per_1k_output: 0,
});

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

/** 选华为云 MaaS 预设 → 地址自动填充 → 填 Key（端点不提供 /models 的真实场景） */
async function fillHuaweiForm() {
  const f = await openForm();
  fireEvent.change(f.select, { target: { value: 'huawei-maas' } });
  await waitFor(() => expect(f.url).toHaveValue('https://api.modelarts-maas.com/plan/v2'));
  fireEvent.change(f.key, { target: { value: 'sk-test' } });
  return f;
}

describe('ModelProviderPanel：API 地址与自动识别', () => {
  beforeEach(() => {
    addProvider.mockClear();
    fetchModels.mockReset().mockResolvedValue({ ok: true, data: [] });
  });

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

// ── 端点不提供 /models（华为云 MaaS Token Plan 的 /plan/v2）─────────────
//
// 实测（2026-10-17）：该端点 `GET /models` 返回 404 APIG.0101，但 `POST /chat/completions`
// 完全正常。旧实现把原始 404 文本当 `formError` 显示，用户只能断定"供应商有问题"，
// 而且列表为空 ⇒ 勾不到模型 ⇒ 无法注册。修复后：不是错误，改为引导手填模型名。

describe('ModelProviderPanel：端点不提供 /models 时的降级', () => {
  beforeEach(() => {
    addProvider.mockClear();
    fetchModels.mockReset().mockResolvedValue({ ok: true, data: [] });
  });

  it('拉取时把该供应商的内置候选模型名带给后端（否则列表天然为空）', async () => {
    const { url, key } = await fillHuaweiForm();
    void url; void key;
    fireEvent.click(screen.getByText('测试并拉取模型'));

    await waitFor(() => expect(fetchModels).toHaveBeenCalledTimes(1));
    const arg = fetchModels.mock.calls[0]![0] as { base_url: string; fallbackModels?: string[] };
    expect(arg.base_url).toBe('https://api.modelarts-maas.com/plan/v2');
    expect(arg.fallbackModels).toEqual(['GLM-5.1', 'DeepSeek-V4-Flash', 'Kimi-K2.6']);
  });

  it('404 不再显示为错误：给出候选列表 + 要求勾选，确认按钮在勾选前禁用', async () => {
    fetchModels.mockResolvedValueOnce({
      ok: true,
      data: [MODEL_SPEC('GLM-5.1'), MODEL_SPEC('DeepSeek-V4-Flash')],
      listNotProvided: true,
      listStatus: 404,
      modelsFromFallback: true,
    });
    await fillHuaweiForm();
    fireEvent.click(screen.getByText('测试并拉取模型'));

    await waitFor(() => expect(screen.getByTestId('list-not-provided')).toBeInTheDocument());
    expect(screen.getByText(/该端点不提供模型列表/)).toBeInTheDocument();
    // 绝不能出现"HTTP 404: {...APIG.0101...}"这类原始报文
    expect(screen.queryByText(/APIG\.0101/)).not.toBeInTheDocument();
    expect(screen.queryByText(/HTTP 404/)).not.toBeInTheDocument();
    // 候选已列出，但默认不勾选任何模型
    expect(screen.getByText('GLM-5.1')).toBeInTheDocument();
    expect(screen.getByTestId('add-provider-confirm')).toBeDisabled();

    fireEvent.click(screen.getByText('GLM-5.1'));
    await waitFor(() => expect(screen.getByTestId('add-provider-confirm')).toBeEnabled());
    fireEvent.click(screen.getByTestId('add-provider-confirm'));
    await waitFor(() => expect(addProvider).toHaveBeenCalledTimes(1));
    expect(addProvider.mock.calls[0]![0]).toMatchObject({
      provider: 'huawei-maas',
      models: [expect.objectContaining({ id: 'GLM-5.1' })],
    });
  });

  it('没有任何内置候选时，可手填模型名并勾选后注册', async () => {
    fetchModels.mockResolvedValueOnce({ ok: true, data: [], listNotProvided: true, listStatus: 404 });
    const { url, key, select } = await openForm();
    void select;
    // 自定义地址（无内置候选）
    fireEvent.change(url, { target: { value: 'https://api.internal.corp/plan/v2' } });
    fireEvent.change(key, { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('测试并拉取模型'));

    await waitFor(() => expect(screen.getByTestId('list-not-provided')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('手动填写模型名'), { target: { value: 'my-model-1' } });
    fireEvent.click(screen.getByText('添加'));

    await waitFor(() => expect(screen.getByText('my-model-1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('my-model-1'));
    await waitFor(() => expect(screen.getByTestId('add-provider-confirm')).toBeEnabled());
    fireEvent.click(screen.getByTestId('add-provider-confirm'));

    await waitFor(() => expect(addProvider).toHaveBeenCalledTimes(1));
    expect(addProvider.mock.calls[0]![0]).toMatchObject({
      base_url: 'https://api.internal.corp/plan/v2',
      models: [expect.objectContaining({ id: 'my-model-1' })],
    });
  });

  it('真正的错误（403/5xx）仍然如实显示，不被降级掩盖', async () => {
    fetchModels.mockResolvedValueOnce({ ok: false, error: 'HTTP 403: {"error_code":"ModelArts.81004"}' });
    await fillHuaweiForm();
    fireEvent.click(screen.getByText('测试并拉取模型'));

    await waitFor(() => expect(screen.getByText(/ModelArts\.81004/)).toBeInTheDocument());
    expect(screen.queryByTestId('list-not-provided')).not.toBeInTheDocument();
  });
});
