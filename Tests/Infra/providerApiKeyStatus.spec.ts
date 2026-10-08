/**
 * Provider API Key 就绪判定（2026-10-08）。
 *
 * 背景：`apiKeyStatus()` 让"缺 Key"从**异常**变成**返回值**，前端才能在发消息前
 * 明确提示并引导到设置页；否则模型调用失败后界面只剩一个空进度条。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { OpenAIProvider } from '../../Src/Infra/Llm/Provider/openaiProvider.js';

function makeProvider(apiKeyRef: string): OpenAIProvider {
  return new OpenAIProvider({
    provider: 'test-provider',
    base_url: 'https://example.invalid/v1',
    api_key_ref: apiKeyRef,
    display_name: '测试供应商',
    models: [{
      id: 'test-model',
      context_window: 4096,
      max_output: 1024,
      supports_vision: false,
      supports_tools: true,
      cost_per_1k_input: 0,
      cost_per_1k_output: 0,
    } as never],
  });
}

const ENV_VAR = 'CIVITAS_TEST_API_KEY_STATUS';

describe('LlmProvider.apiKeyStatus', () => {
  beforeEach(() => { delete process.env[ENV_VAR]; });
  afterEach(() => { delete process.env[ENV_VAR]; });

  it('env: 引用且环境变量未设置 → 未就绪，原因点名变量', () => {
    const status = makeProvider(`env:${ENV_VAR}`).apiKeyStatus();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toContain(ENV_VAR);
  });

  it('env: 引用且环境变量已设置 → 就绪', () => {
    process.env[ENV_VAR] = 'sk-test';
    expect(makeProvider(`env:${ENV_VAR}`).apiKeyStatus().ok).toBe(true);
  });

  it('inline: 密钥 → 就绪（运行期注入路径）', () => {
    expect(makeProvider('inline:sk-inline').apiKeyStatus().ok).toBe(true);
  });

  it('不支持的引用格式 → 未就绪，原因可读', () => {
    const status = makeProvider('file:/tmp/key.txt').apiKeyStatus();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toContain('不支持的 api_key_ref');
  });
});
