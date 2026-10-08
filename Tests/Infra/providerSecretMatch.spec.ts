/**
 * 已保存凭据 ↔ 已注册 Provider 的匹配（2026-10-08）。
 *
 * 为什么值得单测：这里匹配失败的表现是"用户保存过 API Key，却每次都提示未设置"——
 * 密钥静默不生效，属最难排查的一类缺陷（本次就是这个根因）。
 */
import { describe, it, expect } from 'vitest';

import {
  findProviderToMerge,
  normalizeBaseUrl,
} from '../../Src/Infra/Llm/providerSecretMatch.js';

const p = (name: string, base_url: string) => ({ name, config: { base_url } });

describe('normalizeBaseUrl', () => {
  it('去尾斜杠、统一大小写、裁剪空白', () => {
    expect(normalizeBaseUrl('  HTTPS://API.Example.com/v1/  ')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl(undefined)).toBe('');
    expect(normalizeBaseUrl(null)).toBe('');
  });
});

describe('findProviderToMerge', () => {
  const registered = [
    p('huawei-maas', 'https://api.modelarts-maas.com/v1'),
    p('openai-compatible', 'https://api.openai.com/v1'),
  ];

  it('注册名相同 → 命中（就地换密钥）', () => {
    const hit = findProviderToMerge(registered, { name: 'huawei-maas', provider: 'huawei-maas' });
    expect(hit?.name).toBe('huawei-maas');
  });

  it('名字漂移但端点相同 → 仍命中（本次根因：恢复时被唯一化改名）', () => {
    const hit = findProviderToMerge(registered, {
      name: 'huawei-maas-2',
      provider: 'huawei-maas-2',
      baseUrl: 'https://api.modelarts-maas.com/v1',
    });
    expect(hit?.name).toBe('huawei-maas');
  });

  it('旧数据用展示名 → provider 字段与 name 任一命中即可', () => {
    const hit = findProviderToMerge(registered, { name: '华为云 MaaS', provider: 'openai-compatible' });
    expect(hit?.name).toBe('openai-compatible');
  });

  it('端点大小写/尾斜杠差异不影响匹配', () => {
    const hit = findProviderToMerge(registered, {
      name: 'whatever',
      provider: 'whatever',
      baseUrl: 'HTTPS://API.ModelArts-MaaS.com/v1/',
    });
    expect(hit?.name).toBe('huawei-maas');
  });

  it('完全不同 → 不命中（按新供应商注册，避免误覆盖）', () => {
    expect(findProviderToMerge(registered, {
      name: 'other-vendor', provider: 'other-vendor', baseUrl: 'https://other.example.com/v1',
    })).toBeUndefined();
  });

  it('凭据信息为空 → 不命中（不冒险覆盖任何现有供应商）', () => {
    expect(findProviderToMerge(registered, { name: '', provider: '' })).toBeUndefined();
  });
});
