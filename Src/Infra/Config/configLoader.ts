/**
 * 配置加载器（Docs/11 §1.2 / Docs/02 §7.1 ①）
 *
 * 职责：
 * - 加载 default.json → {env}.json → local.json 三层合并
 * - 优先级：local > {env} > default
 * - 环境变量仅解析 api_key_ref: "env:XXX" 引用，不参与层级竞争
 * - 类型错误 → 启动失败（FATAL）；键缺失 → 用默认值
 * - 解析 env: 引用
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

import type { Result } from '../types.js';
import { ok, err } from '../types.js';
import { validateAllConfigs } from './configValidator.js';

/** 配置加载选项 */
export interface ConfigLoaderOptions {
  /** 配置文件目录，默认为项目根目录下的 Configs/ */
  configDir?: string;
  /** 环境名，默认从 CIVITAS_ENV 读取，缺省 'dev' */
  env?: string;
}

/** 已加载的配置集合 */
export interface LoadedConfig {
  /** 合并后的完整配置 */
  readonly merged: Record<string, unknown>;
  /** 各层原始配置（用于调试） */
  readonly layers: {
    readonly default: Record<string, unknown>;
    readonly env: Record<string, unknown>;
    readonly local: Record<string, unknown>;
  };
  /** 实际使用的环境名 */
  readonly env: string;
  /** 配置文件目录 */
  readonly configDir: string;
}

/**
 * 加载并合并三层配置
 *
 * 合并策略：local > {env} > default（深度合并）
 * 类型错误 → 返回 FATAL 结果
 * 键缺失 → 使用 default.json 的默认值
 */
export function loadConfig(options: ConfigLoaderOptions = {}): Result<LoadedConfig> {
  const configDir = options.configDir ?? resolveProjectConfigDir();
  const env = options.env ?? process.env['CIVITAS_ENV'] ?? 'dev';

  // 1. 加载 default.json（必须存在）
  const defaultPath = join(configDir, 'default.json');
  if (!existsSync(defaultPath)) {
    return err(`[FATAL] default.json 不存在: ${defaultPath}`, 'FATAL');
  }
  const defaultConfig = readJsonFile(defaultPath);
  if (!defaultConfig.ok) return defaultConfig as unknown as Result<LoadedConfig>;

  // 2. 加载 {env}.json（可选）
  const envPath = join(configDir, `${env}.json`);
  let envConfig: Record<string, unknown> = {};
  if (existsSync(envPath)) {
    const result = readJsonFile(envPath);
    if (!result.ok) return result as unknown as Result<LoadedConfig>;
    envConfig = result.value;
  }

  // 3. 加载 local.json（可选，gitignore）
  const localPath = join(configDir, 'local.json');
  let localConfig: Record<string, unknown> = {};
  if (existsSync(localPath)) {
    const result = readJsonFile(localPath);
    if (!result.ok) return result as unknown as Result<LoadedConfig>;
    localConfig = result.value;
  }

  // 4. 深度合并：default < env < local
  const merged = deepMerge(defaultConfig.value, deepMerge(envConfig, localConfig));

  // 5. 解析 env: 引用
  resolveEnvReferences(merged);

  // 6. 加载其他配置文件（合并到 merged）
  const extraConfigs = [
    'modelRouter', 'routingRules', 'economyRules',
    'arbitration', 'audit', 'supervision',
    'loopConfig', 'durable', 'session',
    'memory', 'security',
  ];

  for (const name of extraConfigs) {
    const filePath = join(configDir, `${name}.json`);
    if (existsSync(filePath)) {
      const result = readJsonFile(filePath);
      if (!result.ok) return result as unknown as Result<LoadedConfig>;
      const fileConfig = result.value;
      // 将文件内容合并到顶层（文件内的顶层键直接合并）
      for (const [key, value] of Object.entries(fileConfig)) {
        if (key in merged && typeof merged[key] === 'object' && typeof value === 'object' &&
            !Array.isArray(merged[key]) && !Array.isArray(value)) {
          merged[key] = deepMerge(
            merged[key] as Record<string, unknown>,
            value as Record<string, unknown>,
          );
        } else {
          merged[key] = value;
        }
      }
    }
  }

  // 7. 校验配置（merged 已包含所有文件的顶层键）
  const allConfigs: Record<string, Record<string, unknown>> = {
    'default': merged,
    'loopConfig': merged,
  };
  const validationResult = validateAllConfigs(allConfigs);
  if (!validationResult.ok) {
    return err(validationResult.error, validationResult.severity);
  }

  return ok({
    merged,
    layers: {
      default: defaultConfig.value,
      env: envConfig,
      local: localConfig,
    },
    env,
    configDir,
  });
}

/**
 * 从合并后的配置中读取某个值
 *
 * @param config 已加载的配置
 * @param path 点分隔路径，如 'database.busyTimeoutMs'
 */
export function getConfigValue<T>(config: LoadedConfig, path: string): T | undefined {
  const keys = path.split('.');
  let current: unknown = config.merged;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current as T | undefined;
}

/**
 * 从配置中读取某个值，不存在则返回默认值
 */
export function getConfigValueOr<T>(config: LoadedConfig, path: string, defaultValue: T): T {
  return getConfigValue<T>(config, path) ?? defaultValue;
}

// ===== 内部辅助函数 =====

/** 深度合并两个对象（override 覆盖 base） */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overrideVal = override[key];
    if (
      baseVal !== null && overrideVal !== null &&
      typeof baseVal === 'object' && typeof overrideVal === 'object' &&
      !Array.isArray(baseVal) && !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

/** 读取并解析 JSON 文件 */
function readJsonFile(filePath: string): Result<Record<string, unknown>> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return ok(parsed);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`JSON 解析失败 [${filePath}]: ${message}`, 'FATAL');
  }
}

/**
 * 递归解析 env: 引用
 *
 * 将 "env:OPENAI_API_KEY" 替换为 process.env.OPENAI_API_KEY 的值。
 * 环境变量未设置时保留原值（不报错，由使用方决定是否必须）。
 */
function resolveEnvReferences(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.startsWith('env:')) {
      const envVar = value.slice(4);
      const envValue = process.env[envVar];
      if (envValue !== undefined) {
        obj[key] = envValue;
      }
      // 未设置时保留原值，由使用方检查
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      resolveEnvReferences(value as Record<string, unknown>);
    }
  }
}

/** 获取项目 Configs 目录的绝对路径 */
function resolveProjectConfigDir(): string {
  // 从当前文件位置推算：Src/Infra/Config/ → 项目根/Configs/
  return resolve(import.meta.dirname, '..', '..', '..', 'Configs');
}
