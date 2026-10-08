/**
 * 供应商凭据写入守卫（2026-10-08）。
 *
 * 回归背景：实测出现过 `供应商密钥已加密保存 {"count":0}`（此前 2 条）——
 * 应用自己把用户保存的 API Key 清空，之后每次调用都报"密钥未设置"，
 * 用户完全无从理解。这是**静默数据丢失**，必须由后端兜底拒绝。
 */
import { describe, it, expect } from 'vitest';

import { evaluateSecretWrite, isUsableSecret } from '../../Src/Infra/Security/secretWriteGuard.js';

const good = (name: string) => ({ name, apiKey: 'sk-x', baseUrl: 'https://api.example.com/v1' });
const blank = (name: string) => ({ name, apiKey: '', baseUrl: '' });

describe('isUsableSecret', () => {
  it('apiKey 与 baseUrl 都非空才算可用', () => {
    expect(isUsableSecret(good('a'))).toBe(true);
    expect(isUsableSecret(blank('a'))).toBe(false);
    expect(isUsableSecret({ name: 'a', apiKey: 'sk', baseUrl: '   ' })).toBe(false);
    expect(isUsableSecret(null)).toBe(false);
  });
});

describe('evaluateSecretWrite', () => {
  it('已有凭据时，拒绝用空列表清空（核心回归）', () => {
    const d = evaluateSecretWrite(2, []);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toContain('拒绝清空');
  });

  it('本来就没有凭据时，空写入是合法的', () => {
    expect(evaluateSecretWrite(0, []).ok).toBe(true);
  });

  it('已有凭据时，拒绝写入字段为空的条目（历史客户端写空串）', () => {
    const d = evaluateSecretWrite(1, [good('a'), blank('b')]);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toContain('b');
  });

  it('无历史凭据时，允许写入（不误伤首次保存）', () => {
    expect(evaluateSecretWrite(0, [blank('a')]).ok).toBe(true);
  });

  it('数量减少但内容完整 → 放行并给出警告（便于归因误删）', () => {
    const d = evaluateSecretWrite(3, [good('a')]);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.warning).toContain('3 → 1');
  });

  it('数量不变或增加 → 放行且无警告', () => {
    expect(evaluateSecretWrite(2, [good('a'), good('b')])).toEqual({ ok: true });
    expect(evaluateSecretWrite(1, [good('a'), good('b')])).toEqual({ ok: true });
  });
});
