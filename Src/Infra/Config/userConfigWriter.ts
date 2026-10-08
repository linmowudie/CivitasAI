/**
 * @module Infra/Config/userConfigWriter
 * @description
 * 用户配置层（`<DATA_ROOT>/Configs/local.json`）的**白名单写入**。
 *
 * 为什么需要白名单：`local.json` 是覆盖层里优先级最高的一层（见 `configLoader`），
 * 首启引导与设置面板要能写它，但**不能**让 UI 任意改写 L0 配置（数据库路径、安全策略、
 * 循环上限等）——那会让用户一条设置就把系统写坏。
 *
 * 白名单（点路径前缀）：
 * - `server.httpPort` / `server.host` / `server.corsOrigins`
 * - `system.logLevel`
 * - `ui.*`（界面节流等）
 * - `routing.*`（默认/规划/执行/校验模型、仲裁模型、超时）
 * - `reasoningSandwich.*`
 * - `workspace.root`（工作空间根；**下次启动生效**）
 * - `onboarding.*`（引导备注）
 *
 * 写入策略：读现有 `local.json` → 深度合并白名单内的键 → 原子写。
 * 白名单外的键**不写入**并如实返回 `rejected`（UI 需提示，而不是静默丢弃）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Result } from '../types.js';
import { ok, err } from '../types.js';
import { atomicWrite } from '../Fs/atomicWrite.js';
import { ensureDirSafe, getConfigDir } from '../Fs/pathResolver.js';

/** 允许写入的点路径前缀（精确匹配或带 `.*` 前缀） */
const ALLOWED_PREFIXES = [
  'server.httpPort',
  'server.host',
  'server.corsOrigins',
  'system.logLevel',
  'ui.',
  'routing.',
  'reasoningSandwich.',
  'workspace.',
  'onboarding.',
] as const;

export interface UserConfigWriteResult {
  /** 实际写入的文件 */
  path: string;
  /** 已写入的点路径 */
  applied: string[];
  /** 白名单外被拒绝的点路径 */
  rejected: string[];
  /** 校验不通过（类型/取值非法）的点路径与原因 */
  invalid: Array<{ path: string; reason: string }>;
}

export function getUserConfigPath(): string {
  return join(getConfigDir(), 'local.json');
}

/** 点路径是否命中白名单 */
export function isAllowedConfigPath(path: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) =>
    prefix.endsWith('.') ? path.startsWith(prefix) || path === prefix.slice(0, -1) : path === prefix,
  );
}

/** 具体取值校验（越具体越安全；未列出的路径只做类型合理性检查） */
function validateValue(path: string, value: unknown): string | null {
  if (path === 'server.httpPort') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
      return '必须是 1..65535 的整数';
    }
  }
  if (path === 'system.logLevel') {
    if (!['debug', 'info', 'warn', 'error', 'fatal'].includes(String(value))) {
      return '必须是 debug/info/warn/error/fatal';
    }
  }
  if (path === 'server.corsOrigins') {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return '必须是字符串数组';
  }
  if (path.startsWith('routing.arbitrationModels') || path.startsWith('routing.fallbackOrder')) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return '必须是字符串数组';
  }
  if (path.startsWith('routing.') && path.endsWith('Model')) {
    if (typeof value !== 'string') return '必须是字符串（模型全限定名）';
  }
  if (value === undefined) return '值不能是 undefined';
  return null;
}

/** 把扁平的 `{ 'a.b': v }` 写进对象树 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cursor = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const next = cursor[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]!] = value;
}

/** 深度合并（override 覆盖 base） */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key];
    if (
      prev !== null && value !== null && typeof prev === 'object' && typeof value === 'object' &&
      !Array.isArray(prev) && !Array.isArray(value)
    ) {
      out[key] = deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 写用户配置层。
 *
 * @param patch 点路径 → 值（如 `{ 'routing.defaultModel': 'p/m', 'system.logLevel': 'warn' }`）
 */
export function writeUserConfig(patch: Record<string, unknown>): Result<UserConfigWriteResult> {
  const path = getUserConfigPath();
  const applied: string[] = [];
  const rejected: string[] = [];
  const invalid: Array<{ path: string; reason: string }> = [];

  // 1. 过滤 + 校验
  const accepted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!isAllowedConfigPath(key)) {
      rejected.push(key);
      continue;
    }
    const reason = validateValue(key, value);
    if (reason) {
      invalid.push({ path: key, reason });
      continue;
    }
    setPath(accepted, key, value);
    applied.push(key);
  }

  if (applied.length === 0) {
    return ok({ path, applied, rejected, invalid });
  }

  // 2. 读取现有 local.json（不存在则从空对象开始）
  const dirResult = ensureDirSafe(getConfigDir());
  if (!dirResult.ok) {
    return err(`配置目录不可写：${getConfigDir()}（${dirResult.error ?? '未知原因'}）`, 'ERROR');
  }

  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch (e) {
      return err(`现有 local.json 解析失败（请先修好它再写入）：${e instanceof Error ? e.message : String(e)}`, 'FATAL');
    }
  }

  // 3. 合并 + 原子写
  const merged = deepMerge(current, accepted);
  const writeResult = atomicWrite(path, JSON.stringify(merged, null, 2));
  if (!writeResult.ok) {
    return err(`用户配置写入失败：${writeResult.error}`, 'ERROR');
  }

  return ok({ path, applied, rejected, invalid });
}

/** 读取现有用户配置层（不存在返回空对象） */
export function readUserConfig(): Record<string, unknown> {
  const path = getUserConfigPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
