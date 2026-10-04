/**
 * 供应商 API_KEY 的**加密持久化与合并语义**（"重启后 API_KEY 被刷掉"修复）
 *
 * 背景：
 *  - `ipc-add-provider` 用的是 `inline:<key>`（仅内存），重启即失效；
 *  - 客户端保存密钥时整包写回，并把已有供应商的 apiKey/baseUrl 写成空串
 *    → 再加第二个模型就把第一个的密钥刷掉，重启后以空 key 恢复注册。
 *
 * 本测试锁定修复后的合并语义：只 upsert/remove 单条，绝不触碰其他供应商。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  upsertProviderSecret,
  removeProviderSecret,
  loadProviderSecrets,
  saveProviderSecrets,
  hasUsableSecret,
  type ProviderSecret,
} from '../../Src/Infra/Security/secretsStore.js';

const SECRETS_DIR = join(resolve(import.meta.dirname, '..', '..'), 'Data', '.secrets');
const SECRETS_FILE = join(SECRETS_DIR, 'providers.json.enc');
const BACKUP_FILE = join(SECRETS_DIR, 'providers.json.enc.testbak');

const A: ProviderSecret = {
  name: '供应商A', provider: 'openai-compatible', baseUrl: 'https://a.example.com/v1',
  apiKey: 'sk-aaa-111', displayName: '供应商A', models: [],
};
const B: ProviderSecret = {
  name: '供应商B', provider: 'openai-compatible', baseUrl: 'https://b.example.com/v1',
  apiKey: 'sk-bbb-222', displayName: '供应商B', models: [],
};

describe('供应商密钥持久化与合并语义', () => {
  let hadOriginal = false;

  beforeEach(() => {
    mkdirSync(SECRETS_DIR, { recursive: true });
    hadOriginal = existsSync(SECRETS_FILE);
    if (hadOriginal) copyFileSync(SECRETS_FILE, BACKUP_FILE);
    if (existsSync(SECRETS_FILE)) rmSync(SECRETS_FILE);
  });

  afterEach(() => {
    // 还原开发机上真实的凭据文件，避免测试污染用户数据
    if (existsSync(SECRETS_FILE)) rmSync(SECRETS_FILE);
    if (hadOriginal && existsSync(BACKUP_FILE)) {
      copyFileSync(BACKUP_FILE, SECRETS_FILE);
      rmSync(BACKUP_FILE);
    }
  });

  it('新增第二个供应商不会动到第一个的密钥与地址（原缺陷）', async () => {
    await upsertProviderSecret(A);
    await upsertProviderSecret(B);

    const stored = await loadProviderSecrets();
    expect(stored?.providers).toHaveLength(2);
    const a = stored!.providers.find((p) => p.name === '供应商A')!;
    const b = stored!.providers.find((p) => p.name === '供应商B')!;
    expect(a.apiKey).toBe('sk-aaa-111');
    expect(a.baseUrl).toBe('https://a.example.com/v1');
    expect(b.apiKey).toBe('sk-bbb-222');
  });

  it('同名单据更新视为覆盖（不产生重复条目）', async () => {
    await upsertProviderSecret(A);
    await upsertProviderSecret({ ...A, apiKey: 'sk-aaa-rotated' });
    const stored = await loadProviderSecrets();
    expect(stored?.providers).toHaveLength(1);
    expect(stored!.providers[0]!.apiKey).toBe('sk-aaa-rotated');
  });

  it('移除一个供应商不影响其他供应商', async () => {
    await upsertProviderSecret(A);
    await upsertProviderSecret(B);

    const removed = await removeProviderSecret('供应商B');
    expect(removed).toBe(true);

    const stored = await loadProviderSecrets();
    expect(stored?.providers.map((p) => p.name)).toEqual(['供应商A']);
    expect(stored!.providers[0]!.apiKey).toBe('sk-aaa-111');
  });

  it('移除不存在的供应商返回 false 且不写文件', async () => {
    await upsertProviderSecret(A);
    const before = readFileSync(SECRETS_FILE);
    expect(await removeProviderSecret('不存在')).toBe(false);
    expect(readFileSync(SECRETS_FILE).equals(before)).toBe(true);
  });

  it('hasUsableSecret 能识别"被写空"的脏数据（启动恢复时跳过）', () => {
    expect(hasUsableSecret(A)).toBe(true);
    expect(hasUsableSecret({ ...A, apiKey: '' })).toBe(false);
    expect(hasUsableSecret({ ...A, apiKey: '   ' })).toBe(false);
    expect(hasUsableSecret({ ...A, baseUrl: '' })).toBe(false);
  });

  it('凭据文件为加密/编码存储，不含明文 apiKey（降级模式为 base64）', async () => {
    await upsertProviderSecret(A);
    const raw = readFileSync(SECRETS_FILE, 'utf-8');
    expect(raw).not.toContain('sk-aaa-111');
    // 环境无非 Electron 加密时降级为 base64 包装，仍不应直接出现明文
    if (raw.startsWith('__base64__:')) {
      const decoded = Buffer.from(raw.slice('__base64__:'.length), 'base64').toString('utf-8');
      expect(decoded).toContain('sk-aaa-111');
    }
  });

  it('旧通道写入"含空密钥的整包数据"会被读取方识别为脏数据', async () => {
    // 直接模拟历史客户端行为：整包写入时把已有供应商的 key 写空
    await saveProviderSecrets({
      providers: [{ ...A, apiKey: '', baseUrl: '' }, B],
      updatedAt: Date.now(),
    });
    const stored = await loadProviderSecrets();
    const a = stored!.providers.find((p) => p.name === '供应商A')!;
    expect(hasUsableSecret(a)).toBe(false); // 启动恢复会跳过它
    expect(hasUsableSecret(stored!.providers.find((p) => p.name === '供应商B')!)).toBe(true);
  });

  // ── FE-036：注册名双键匹配（新数据 name=注册名；旧数据 name=展示名、provider=注册名）──

  it('按注册名（provider 字段）删除可命中旧数据（FE-036 键一致化）', async () => {
    await upsertProviderSecret(A); // 旧格式：name='供应商A'，provider='openai-compatible'
    const removed = await removeProviderSecret('openai-compatible');
    expect(removed).toBe(true);
    expect((await loadProviderSecrets())?.providers).toHaveLength(0);
  });

  it('upsert 以注册名匹配旧条目：重加同一供应商不产生重复（FE-036 键一致化）', async () => {
    await upsertProviderSecret(A);
    // 新格式：name 与 provider 均为注册名；应替换掉旧格式的同一供应商
    await upsertProviderSecret({
      ...A, name: 'openai-compatible', displayName: '供应商A', apiKey: 'sk-aaa-rotated',
    });
    const stored = await loadProviderSecrets();
    expect(stored?.providers).toHaveLength(1);
    expect(stored!.providers[0]!.apiKey).toBe('sk-aaa-rotated');
    expect(stored!.providers[0]!.name).toBe('openai-compatible');
  });
});
