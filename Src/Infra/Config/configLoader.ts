/**
 * 配置加载器（Docs/Agent/10 §1.2 / Docs/Agent/02 §7.1 ①）
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
import { getBundledConfigDir, getConfigDir } from '../Fs/pathResolver.js';

/** 配置加载选项 */
export interface ConfigLoaderOptions {
  /** 内置（只读种子）配置目录，默认 `<APP_ROOT>/Configs` */
  configDir?: string;
  /** 用户覆盖层目录，默认 `pathResolver.getConfigDir()`（安装态 `<DATA_ROOT>/Configs`） */
  userConfigDir?: string;
  /** 环境名，默认从 CIVITAS_ENV 读取，缺省 'dev' */
  env?: string;
}

/**
 * 功能配置文件清单（顶层键直接合并进 merged）。
 *
 * 注：`dataStorage.json` / `tools.json` 至今不在清单内（历史遗留，主设计文档已登记），
 * 本轮不改动其接线状态，避免顺带改变工具头部冻结与保留期行为。
 */
const FEATURE_CONFIGS = [
  'modelRouter', 'routingRules', 'economyRules',
  'arbitration', 'audit', 'supervision',
  'loopConfig', 'durable', 'session',
  'memory', 'security',
] as const;

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
 * 加载并合并配置层。
 *
 * ## 层序（低 → 高优先级）
 * ```
 * 内置(<APP_ROOT>/Configs)/default.json
 * 内置/{env}.json
 * 内置/{feature}.json        ← modelRouter / security / …（11 个）
 * 内置/local.json
 * 用户(<DATA_ROOT>/Configs)/{env}.json     ← 安装态：用户可写层（首次运行引导写入）
 * 用户/{feature}.json
 * 用户/local.json            ← 最高优先级：个性化设置与供应商选择的落点
 * ```
 * 开发态 `用户目录 == 内置目录`（都是仓库 `Configs/`），行为与历史一致。
 *
 * ## 与历史行为的差异（有意的修复）
 * 历史实现把 11 个功能文件**无条件**覆盖到最后，导致 `local.json` 覆盖不了
 * `modelRouter.routing` 等键（`Configs/README.md` 自认的已知问题）；首次运行引导
 * 需要"用户写入 `local.json` 即生效"，故调整为 local 最高。
 *
 * ## `env:` 引用解析口径（保持不变，勿动）
 * 只在 `default + {env}` 层解析 `env:XXX`，**不能**对功能文件解析：
 * `modelRouter.json` 的 `api_key_ref: "env:HUAWEI_MAAS_API_KEY"` 必须保持"引用"形态，
 * 由 `providerBase.resolveApiKey()` 在请求期解析；提前展开会被判定为非法 `api_key_ref` 格式。
 *
 * @param options 覆盖目录 / 环境名
 */
export function loadConfig(options: ConfigLoaderOptions = {}): Result<LoadedConfig> {
  const bundledDir = options.configDir ?? getBundledConfigDir();
  const userDir = options.userConfigDir ?? getConfigDir();
  const env = options.env ?? process.env['CIVITAS_ENV'] ?? 'dev';

  /** 需要读取的目录序列（低 → 高）；开发态两者相同，去重避免重复合并 */
  const dirs = userDir && resolve(userDir) !== resolve(bundledDir)
    ? [bundledDir, userDir]
    : [bundledDir];

  const readIfExists = (dir: string, file: string): Result<Record<string, unknown>> | null => {
    const filePath = join(dir, file);
    return existsSync(filePath) ? readJsonFile(filePath) : null;
  };

  // 1. 加载 default.json（内置目录必须存在）
  const defaultPath = join(bundledDir, 'default.json');
  if (!existsSync(defaultPath)) {
    return err(`[FATAL] default.json 不存在: ${defaultPath}`, 'FATAL');
  }
  const defaultConfig = readJsonFile(defaultPath);
  if (!defaultConfig.ok) return defaultConfig as unknown as Result<LoadedConfig>;

  // 2. {env}.json（内置 → 用户，用户层后写覆盖）
  let envConfig: Record<string, unknown> = {};
  for (const dir of dirs) {
    const result = readIfExists(dir, `${env}.json`);
    if (!result) continue;
    if (!result.ok) return result as unknown as Result<LoadedConfig>;
    envConfig = deepMerge(envConfig, result.value);
  }

  // 3. 基础层合并 + `env:` 引用解析（口径见上方注释）
  const merged = deepMerge(defaultConfig.value, envConfig);
  resolveEnvReferences(merged);

  // 4. 功能配置文件（内置 → 用户；用户的同名文件覆盖内置）
  const mergeTopLevel = (target: Record<string, unknown>, source: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(source)) {
      if (key in target && typeof target[key] === 'object' && typeof value === 'object' &&
          !Array.isArray(target[key]) && !Array.isArray(value)) {
        target[key] = deepMerge(
          target[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        target[key] = value;
      }
    }
  };

  for (const dir of dirs) {
    for (const name of FEATURE_CONFIGS) {
      const result = readIfExists(dir, `${name}.json`);
      if (!result) continue;
      if (!result.ok) return result as unknown as Result<LoadedConfig>;
      mergeTopLevel(merged, result.value);
    }
  }

  // 5. local.json（最高优先级：个性化设置 / 路由选择 / 供应商覆盖的落点）
  let localConfig: Record<string, unknown> = {};
  for (const dir of dirs) {
    const result = readIfExists(dir, 'local.json');
    if (!result) continue;
    if (!result.ok) return result as unknown as Result<LoadedConfig>;
    localConfig = deepMerge(localConfig, result.value);
  }
  const finalMerged = deepMerge(merged, localConfig);

  // 6. 校验配置（merged 已包含所有文件的顶层键）
  const allConfigs: Record<string, Record<string, unknown>> = {
    'default': finalMerged,
    'loopConfig': finalMerged,
  };
  const validationResult = validateAllConfigs(allConfigs);
  if (!validationResult.ok) {
    return err(validationResult.error, validationResult.severity);
  }

  return ok({
    merged: finalMerged,
    layers: {
      default: defaultConfig.value,
      env: envConfig,
      local: localConfig,
    },
    env,
    configDir: bundledDir,
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

/**
 * 兼容导出：内置配置目录（历史私有函数 `resolveProjectConfigDir` 的公开替代）。
 *
 * 历史实现按"本文件位置向上 3 层"推算目录，安装态在 asar 内虽可用但语义含糊；
 * 现在统一走 `pathResolver` 的目录契约。
 */
export function getDefaultConfigDir(): string {
  return getBundledConfigDir();
}
