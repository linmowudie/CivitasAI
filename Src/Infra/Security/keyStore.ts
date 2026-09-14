/**
 * 密钥存储与引用管理（Docs/11 §3.6）
 *
 * 职责：
 * - 管理 `env:XXX` 引用解析（配置中的 api_key_ref: "env:OPENAI_API_KEY"）
 * - 密钥只存引用，禁明文（Docs/11 §2.2）
 * - 提供密钥获取的统一入口
 * - 支持密钥轮换（fallback 列表）
 *
 * 安全约束：
 * - 密钥不在日志中输出（自动脱敏）
 * - 密钥不在错误消息中暴露
 * - 环境变量未设置时返回明确错误，不用默认值兜底
 */

import type { Result } from '../types.js';
import { ok, err } from '../types.js';

// ===== 类型定义 =====

/** 密钥引用格式：env:ENV_VAR_NAME */
export type KeyRef = string;

/** 密钥解析结果 */
export interface ResolvedKey {
  /** 密钥值 */
  readonly keyValue: string;
  /** 来源环境变量名 */
  readonly source: string;
  /** 是否为 fallback（轮换场景） */
  readonly isFallback: boolean;
}

/** 密钥注册项 */
export interface KeyEntry {
  /** 引用标识（如 'openai_api_key'） */
  readonly name: string;
  /** 引用列表（支持轮换，第一个为主键） */
  readonly refs: KeyRef[];
  /** 用途描述（仅用于日志） */
  readonly purpose?: string;
}

// ===== 内部状态 =====

/** 已注册的密钥引用 */
const registry = new Map<string, KeyEntry>();

/** 已解析的密钥缓存（避免重复读取环境变量） */
const resolvedCache = new Map<string, ResolvedKey>();

// ===== 公开 API =====

/**
 * 注册一个密钥引用
 *
 * @param name 引用标识（如 'openai_api_key'）
 * @param refs 引用列表（env:XXX 格式），第一个为主键
 * @param purpose 用途描述
 */
export function registerKey(name: string, refs: KeyRef[], purpose?: string): void {
  registry.set(name, { name, refs, purpose });
  // 清除缓存以便重新解析
  resolvedCache.delete(name);
}

/**
 * 解析并获取密钥值
 *
 * 按引用列表顺序尝试，返回第一个可用的密钥。
 * 所有环境变量都未设置时返回错误。
 *
 * @param name 引用标识
 * @returns 密钥值或错误
 */
export function resolveKey(name: string): Result<ResolvedKey> {
  // 检查缓存
  const cached = resolvedCache.get(name);
  if (cached) return ok(cached);

  const entry = registry.get(name);
  if (!entry) {
    return err(`密钥引用 '${name}' 未注册`, 'ERROR');
  }

  // 按顺序尝试每个引用
  for (let i = 0; i < entry.refs.length; i++) {
    const ref = entry.refs[i];
    if (!ref.startsWith('env:')) continue;

    const envVar = ref.slice(4);
    const envValue = process.env[envVar];
    if (envValue !== undefined && envValue !== '') {
      const resolved: ResolvedKey = {
        keyValue: envValue,
        source: envVar,
        isFallback: i > 0,
      };
      resolvedCache.set(name, resolved);
      return ok(resolved);
    }
  }

  // 所有引用都未设置
  return err(
    `密钥引用 '${name}' 的所有环境变量均未设置: ${entry.refs.join(', ')}`,
    'FATAL',
  );
}

/**
 * 检查密钥是否可用（不返回值本身）
 */
export function isKeyAvailable(name: string): boolean {
  return resolveKey(name).ok;
}

/**
 * 获取密钥的脱敏摘要（仅用于日志）
 *
 * 返回格式：`sk-****7f3a`（前3位 + **** + 后4位）
 */
export function getMaskedKey(name: string): string {
  const result = resolveKey(name);
  if (!result.ok) return '[未设置]';

  const key = result.value.keyValue; // ResolvedKey.keyValue 是实际密钥字符串
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

/**
 * 解析单个 env: 引用
 *
 * @param ref 引用字符串（如 'env:OPENAI_API_KEY'）
 * @returns 环境变量值或错误
 */
export function resolveSingleRef(ref: string): Result<{ value: string; envVar: string }> {
  if (!ref.startsWith('env:')) {
    return err(`不支持的密钥引用格式: ${ref}（仅支持 env:XXX）`, 'ERROR');
  }

  const envVar = ref.slice(4);
  const value = process.env[envVar];

  if (value === undefined || value === '') {
    return err(`环境变量 '${envVar}' 未设置`, 'ERROR');
  }

  return ok({ value, envVar });
}

/**
 * 检查字符串是否为 env: 引用
 */
export function isKeyRef(value: string): boolean {
  return value.startsWith('env:');
}

/**
 * 清除所有注册和缓存（用于测试）
 */
export function clearKeyStore(): void {
  registry.clear();
  resolvedCache.clear();
}

/**
 * 获取所有已注册的密钥名称
 */
export function getRegisteredKeyNames(): string[] {
  return Array.from(registry.keys());
}

/**
 * 从配置对象中扫描并注册所有 env: 引用
 *
 * 递归遍历配置对象，找到所有值为 'env:XXX' 的字段并注册。
 * 字段名作为密钥引用标识。
 */
export function scanAndRegisterRefs(config: Record<string, unknown>, prefix = ''): void {
  for (const [key, value] of Object.entries(config)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string' && value.startsWith('env:')) {
      registerKey(path, [value], `Auto-scanned from config`);
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'object' && value[i] !== null) {
          scanAndRegisterRefs(value[i] as Record<string, unknown>, `${path}[${i}]`);
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      scanAndRegisterRefs(value as Record<string, unknown>, path);
    }
  }
}
