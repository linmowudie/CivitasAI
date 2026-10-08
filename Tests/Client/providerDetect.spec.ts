/**
 * API 地址 → 供应商自动识别（2026-10-08）。
 *
 * 需求：不选供应商时，用户只填「地址 + 密钥」即可；选了供应商则地址自动填充。
 * 识别失败不是错误（退化为"自定义供应商，OpenAI 兼容"），因此这里既验证命中，也验证**不误判**。
 */
import { describe, it, expect } from 'vitest';

import {
  detectProviderByUrl,
  isValidHttpUrl,
  normalizeBaseUrl,
  resolveProviderLabel,
} from '../../Client/src/services/providerDetect';

describe('normalizeBaseUrl / isValidHttpUrl', () => {
  it('去空白与尾斜杠', () => {
    expect(normalizeBaseUrl('  https://api.openai.com/v1/  ')).toBe('https://api.openai.com/v1');
  });

  it('只接受 http(s) 且要有主机名', () => {
    expect(isValidHttpUrl('https://api.openai.com/v1')).toBe(true);
    expect(isValidHttpUrl('http://localhost:11434/v1')).toBe(true);
    expect(isValidHttpUrl('api.openai.com/v1')).toBe(false);
    expect(isValidHttpUrl('ftp://api.openai.com')).toBe(false);
    expect(isValidHttpUrl('')).toBe(false);
  });
});

describe('detectProviderByUrl', () => {
  it.each([
    ['https://api.openai.com/v1', 'openai'],
    ['https://api.modelarts-maas.com/plan/v2', 'huawei-maas'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'dashscope'],
    ['https://qianfan.baidubce.com/v2', 'qianfan'],
    ['https://open.bigmodel.cn/api/paas/v4', 'zhipu'],
    ['https://api.deepseek.com/v1', 'deepseek'],
    ['https://api.moonshot.cn/v1', 'moonshot'],
    ['https://api.minimax.chat/v1', 'minimax'],
    ['https://api.lingyiwanwu.com/v1', 'lingyi'],
    ['https://api.siliconflow.cn/v1', 'siliconflow'],
    ['http://localhost:11434/v1', 'ollama'],
  ])('%s → %s', (url, id) => {
    expect(detectProviderByUrl(url)?.id).toBe(id);
  });

  it('大小写与尾斜杠不影响识别', () => {
    expect(detectProviderByUrl('HTTPS://API.DeepSeek.com/v1/')?.id).toBe('deepseek');
  });

  it('dashscope 需要 compatible-mode 路径特征（避免同域其它服务误判）', () => {
    expect(detectProviderByUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')?.id).toBe('dashscope');
    expect(detectProviderByUrl('https://dashscope.aliyuncs.com/api/v1')).toBeNull();
  });

  it('未知供应商 → null（退化为自定义，不瞎猜）', () => {
    expect(detectProviderByUrl('https://llm.internal.corp/v1')).toBeNull();
    expect(detectProviderByUrl('not-a-url')).toBeNull();
    expect(detectProviderByUrl('')).toBeNull();
  });

  it('返回识别依据（界面要说明"为什么是它"）', () => {
    expect(detectProviderByUrl('https://api.deepseek.com/v1')?.matchedBy).toContain('deepseek.com');
  });
});

describe('resolveProviderLabel', () => {
  it('识别到 → 用识别名；识别不到 → 自定义供应商', () => {
    expect(resolveProviderLabel('https://api.deepseek.com/v1')).toMatchObject({ id: 'deepseek', detected: true });
    expect(resolveProviderLabel('https://llm.internal.corp/v1')).toMatchObject({ id: 'custom', name: '自定义供应商', detected: false });
  });
});
