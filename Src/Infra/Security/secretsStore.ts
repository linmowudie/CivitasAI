/**
 * @module Infra/Security/secretsStore
 * @description
 * API_KEY 加密存储——使用 Electron safeStorage API（系统级加密：
 * Windows DPAPI / macOS Keychain / Linux libsecret）。
 * 
 * 存储位置：Data/.secrets/providers.json.enc
 * 
 * 安全保证：
 *  - 明文 API_KEY 只存在于内存中，落盘即加密
 *  - 不通过 syncService 上传到云端
 *  - .gitignore 排除 Data/.secrets/ 目录
 * 
 * 降级策略：
 *  - 非 Electron 环境或 safeStorage 不可用时，使用 Base64 编码（仅开发环境）
 *  - 生产环境必须使用 Electron safeStorage
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../Logging/logger.js';

// ── Electron safeStorage 动态导入 ──────────────────────────────────

type SafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

let safeStorage: SafeStorage | null = null;
let safeStorageChecked = false;

async function getSafeStorage(): Promise<SafeStorage | null> {
  if (safeStorageChecked) return safeStorage;
  safeStorageChecked = true;
  
  try {
    const electron = await import('electron');
    if (electron.safeStorage) {
      safeStorage = electron.safeStorage;
    }
  } catch {
    // 非 Electron 环境
  }
  return safeStorage;
}

// ── 存储路径 ────────────────────────────────────────────────────────

function getSecretsDir(): string {
  // Data/.secrets/ 目录（相对于项目根目录）
  const dataDir = join(process.cwd(), 'Data');
  const secretsDir = join(dataDir, '.secrets');
  if (!existsSync(secretsDir)) {
    mkdirSync(secretsDir, { recursive: true });
  }
  return secretsDir;
}

function getProvidersFilePath(): string {
  return join(getSecretsDir(), 'providers.json.enc');
}

// ── 数据结构 ────────────────────────────────────────────────────────

export interface ProviderSecret {
  /** 唯一键（新数据=注册名；旧数据为展示名，匹配时用 name/provider 双键兼容） */
  name: string;
  apiKey: string;
  baseUrl: string;
  /** 注册名（内存注册表键、模型全限定名前缀；同类型多实例须唯一，FE-036） */
  provider: string;
  /** 展示名（UI 显示） */
  displayName: string;
  models?: Array<{
    id: string;
    context_window: number;
    max_output: number;
    supports_vision: boolean;
    supports_tools: boolean;
    cost_per_1k_input: number;
    cost_per_1k_output: number;
  }>;
}

export interface ProvidersSecrets {
  providers: ProviderSecret[];
  updatedAt: number;
}

// ── 加密/解密 ───────────────────────────────────────────────────────

async function encrypt(plain: string): Promise<Buffer> {
  const ss = await getSafeStorage();
  if (ss && ss.isEncryptionAvailable()) {
    return ss.encryptString(plain);
  }
  // 降级：Base64 编码（仅开发环境）
  logger.warn('safeStorage 不可用，使用 Base64 降级存储（仅限开发环境）', { source: 'secretsStore' });
  return Buffer.from(`__base64__:${Buffer.from(plain, 'utf-8').toString('base64')}`);
}

async function decrypt(encrypted: Buffer): Promise<string> {
  const text = encrypted.toString('utf-8');
  // 检测 Base64 降级格式
  if (text.startsWith('__base64__:')) {
    const base64 = text.slice('__base64__:'.length);
    return Buffer.from(base64, 'base64').toString('utf-8');
  }
  // Electron safeStorage 加密
  const ss = await getSafeStorage();
  if (ss && ss.isEncryptionAvailable()) {
    return ss.decryptString(encrypted);
  }
  throw new Error('无法解密：safeStorage 不可用且数据非 Base64 降级格式');
}

// ── 公开 API ────────────────────────────────────────────────────────

/** 加密保存供应商 API_KEY 列表 */
export async function saveProviderSecrets(secrets: ProvidersSecrets): Promise<void> {
  const filePath = getProvidersFilePath();
  const json = JSON.stringify(secrets);
  const encrypted = await encrypt(json);
  writeFileSync(filePath, encrypted);
  logger.info('供应商密钥已加密保存', { source: 'secretsStore', count: secrets.providers.length });
}

/** 解密读取供应商 API_KEY 列表 */
export async function loadProviderSecrets(): Promise<ProvidersSecrets | null> {
  const filePath = getProvidersFilePath();
  if (!existsSync(filePath)) return null;
  
  try {
    const encrypted = readFileSync(filePath);
    const json = await decrypt(encrypted);
    const parsed = JSON.parse(json) as ProvidersSecrets;
    return parsed;
  } catch (e) {
    logger.error('读取供应商密钥失败', { source: 'secretsStore', error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** 检查加密存储是否可用 */
export async function isEncryptionAvailable(): Promise<boolean> {
  const ss = await getSafeStorage();
  return ss?.isEncryptionAvailable() ?? false;
}

// ── 单个供应商凭据的增删（"不覆盖其他供应商"的合并语义）────────────────
//
// 背景：原先客户端整包写回 secrets，且把已有供应商的 apiKey/baseUrl 写成空串，
// 导致"再加一个模型就把上一个的 API_KEY 刷掉"（重启后按空 key 恢复注册 → 认证失败）。
// 这里提供**只增删单条**的合并函数，供 IPC 层在添加/移除供应商时就地持久化。

/** 记录是否以 key 为标识：匹配注册名 name 或 provider（兼容旧数据 name=展示名） */
function matchesSecret(entry: ProviderSecret, key: string): boolean {
  return entry.name === key || entry.provider === key;
}

/** 新增或更新单个供应商凭据（保留其余供应商不变；键=注册名，FE-036） */
export async function upsertProviderSecret(entry: ProviderSecret): Promise<void> {
  const current = (await loadProviderSecrets()) ?? { providers: [], updatedAt: 0 };
  const rest = current.providers.filter((p) => !matchesSecret(p, entry.name));
  await saveProviderSecrets({ providers: [...rest, entry], updatedAt: Date.now() });
}

/** 删除单个供应商凭据（保留其余；不存在时不做写操作） */
export async function removeProviderSecret(name: string): Promise<boolean> {
  const current = await loadProviderSecrets();
  if (!current) return false;
  const rest = current.providers.filter((p) => !matchesSecret(p, name));
  if (rest.length === current.providers.length) return false;
  await saveProviderSecrets({ providers: rest, updatedAt: Date.now() });
  return true;
}

/** 合并语义的自检：这些供应商的凭据是否都完整（用于启动时跳过脏数据） */
export function hasUsableSecret(entry: ProviderSecret): boolean {
  return typeof entry.apiKey === 'string' && entry.apiKey.trim().length > 0
    && typeof entry.baseUrl === 'string' && entry.baseUrl.trim().length > 0;
}
