/**
 * 供应商多实例隔离（FE-036）
 *
 * 修复背景：注册表以 provider（注册名）为键 —— 同类型多实例（两个"OpenAI 兼容"）
 * 若都用同一注册名注册，后注册的会覆盖先注册的（模型一并被顶掉；按加密凭据
 * 恢复时同样）。修复后调用方（IPC 层）先经 uniqueProviderName 取得唯一注册名，
 * 同类型实例以 `xxx`、`xxx-2`、`xxx-3`… 共存。
 *
 * 本测试锁定：① uniqueProviderName 生成唯一名；② 同类型两实例共存不覆盖；
 * ③ 模型全限定名各自独立；④ 注销一个实例不影响另一个。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvider,
  unregisterProvider,
  getProviders,
  getRegisteredModels,
  resolveModel,
  resetRouter,
  uniqueProviderName,
} from '../../Src/Infra/Llm/Router/modelRouter.js';
import { OpenAIProvider } from '../../Src/Infra/Llm/Provider/openaiProvider.js';
import type { ModelSpec } from '../../Src/Infra/Llm/Provider/providerBase.js';

function modelSpec(id: string): ModelSpec {
  return {
    id, context_window: 128000, max_output: 4096,
    supports_vision: false, supports_tools: true,
    cost_per_1k_input: 0.001, cost_per_1k_output: 0.002,
  };
}

function makeProvider(regName: string, baseUrl: string, modelId: string): OpenAIProvider {
  return new OpenAIProvider({
    provider: regName,
    base_url: baseUrl,
    api_key_ref: 'inline:sk-test',
    display_name: `Display ${regName}`,
    models: [modelSpec(modelId)],
  });
}

describe('供应商多实例隔离（FE-036）', () => {
  beforeEach(() => resetRouter());

  it('uniqueProviderName：未占用返回原名；占用依次加序号', () => {
    expect(uniqueProviderName('openai-compatible')).toBe('openai-compatible');

    registerProvider(makeProvider('openai-compatible', 'https://a.example.com/v1', 'model-a'));
    expect(uniqueProviderName('openai-compatible')).toBe('openai-compatible-2');

    registerProvider(makeProvider('openai-compatible-2', 'https://b.example.com/v1', 'model-b'));
    expect(uniqueProviderName('openai-compatible')).toBe('openai-compatible-3');
  });

  it('同类型两实例共存：注册名唯一化后互不覆盖，模型各自注册', () => {
    // 模拟 IPC 恢复流程：两条 provider 同为 openai-compatible 的凭据
    const first = uniqueProviderName('openai-compatible');
    registerProvider(makeProvider(first, 'https://a.example.com/v1', 'model-a'));
    const second = uniqueProviderName('openai-compatible');
    registerProvider(makeProvider(second, 'https://b.example.com/v1', 'model-b'));

    expect(getProviders().map((p) => p.name).sort()).toEqual(['openai-compatible', 'openai-compatible-2']);
    expect(getRegisteredModels()).toContain('openai-compatible/model-a');
    expect(getRegisteredModels()).toContain('openai-compatible-2/model-b');
  });

  it('模型解析指向各自实例（base_url 不串）', () => {
    registerProvider(makeProvider(uniqueProviderName('openai-compatible'), 'https://a.example.com/v1', 'model-a'));
    registerProvider(makeProvider(uniqueProviderName('openai-compatible'), 'https://b.example.com/v1', 'model-b'));

    const a = resolveModel('openai-compatible/model-a');
    const b = resolveModel('openai-compatible-2/model-b');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok) expect(a.value.provider.config.base_url).toBe('https://a.example.com/v1');
    if (b.ok) expect(b.value.provider.config.base_url).toBe('https://b.example.com/v1');
  });

  it('注销一个实例不影响另一个（模型随实例删除，另一实例保留）', () => {
    registerProvider(makeProvider('openai-compatible', 'https://a.example.com/v1', 'model-a'));
    registerProvider(makeProvider('openai-compatible-2', 'https://b.example.com/v1', 'model-b'));

    unregisterProvider('openai-compatible-2');
    expect(getProviders().map((p) => p.name)).toEqual(['openai-compatible']);
    expect(getRegisteredModels()).toEqual(['openai-compatible/model-a']);
  });
});
