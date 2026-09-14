/**
 * 配置校验器（Docs/11 §1.2 / Docs/15 §7）
 *
 * 职责：
 * - 校验配置值类型是否正确（类型错误 → 启动失败，不用默认值兜底）
 * - 校验数值天花板（Docs/15 §7.1）
 * - 校验枚举值合法性
 * - 校验跨段一致性（如 profitSharing 权重和 = 1）
 */

import type { Result } from '../types.js';
import { ok, err } from '../types.js';

/** 校验错误汇总 */
export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

/**
 * 校验 default.json 基础段
 */
export function validateDefaultConfig(config: Record<string, unknown>): Result<ValidationError[]> {
  const errors: ValidationError[] = [];

  // system 段
  const system = config['system'];
  if (!system || typeof system !== 'object') {
    errors.push({ path: 'system', message: 'system 段缺失' });
  } else {
    const s = system as Record<string, unknown>;
    if (typeof s['name'] !== 'string') errors.push({ path: 'system.name', message: '必须为 string' });
    if (typeof s['version'] !== 'string') errors.push({ path: 'system.version', message: '必须为 string' });
    if (typeof s['logLevel'] !== 'string') errors.push({ path: 'system.logLevel', message: '必须为 string' });
    if (typeof s['dataDir'] !== 'string') errors.push({ path: 'system.dataDir', message: '必须为 string' });
    if (typeof s['logDir'] !== 'string') errors.push({ path: 'system.logDir', message: '必须为 string' });
    if (typeof s['promptDir'] !== 'string') errors.push({ path: 'system.promptDir', message: '必须为 string' });
  }

  // server 段
  const server = config['server'];
  if (!server || typeof server !== 'object') {
    errors.push({ path: 'server', message: 'server 段缺失' });
  } else {
    const sv = server as Record<string, unknown>;
    if (typeof sv['host'] !== 'string') errors.push({ path: 'server.host', message: '必须为 string' });
    if (typeof sv['httpPort'] !== 'number' || !Number.isInteger(sv['httpPort'])) {
      errors.push({ path: 'server.httpPort', message: '必须为整数' });
    }
    if (typeof sv['wsPort'] !== 'number' || !Number.isInteger(sv['wsPort'])) {
      errors.push({ path: 'server.wsPort', message: '必须为整数' });
    }
  }

  // database 段
  const db = config['database'];
  if (!db || typeof db !== 'object') {
    errors.push({ path: 'database', message: 'database 段缺失' });
  } else {
    const d = db as Record<string, unknown>;
    if (typeof d['mainPath'] !== 'string') errors.push({ path: 'database.mainPath', message: '必须为 string' });
    if (typeof d['eventsPath'] !== 'string') errors.push({ path: 'database.eventsPath', message: '必须为 string' });
    if (typeof d['memoryPath'] !== 'string') errors.push({ path: 'database.memoryPath', message: '必须为 string' });
    if (typeof d['walMode'] !== 'boolean') errors.push({ path: 'database.walMode', message: '必须为 boolean' });
    if (typeof d['busyTimeoutMs'] !== 'number') errors.push({ path: 'database.busyTimeoutMs', message: '必须为 number (ms)' });
  }

  if (errors.length > 0) {
    return err(`配置校验失败: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`, 'FATAL');
  }
  return ok(errors);
}

/**
 * 校验 loopConfig.json 硬约束（Docs/15 §7.1）
 */
export function validateLoopConfig(config: Record<string, unknown>): Result<ValidationError[]> {
  const errors: ValidationError[] = [];

  const loopDefaults = config['loopDefaults'] as Record<string, unknown> | undefined;
  const hardLimits = config['hardLimits'] as Record<string, unknown> | undefined;
  const stopRules = config['stopRules'] as Record<string, unknown> | undefined;
  const roleOverrides = config['roleOverrides'] as Record<string, unknown> | undefined;

  if (!loopDefaults || !hardLimits || !stopRules || !roleOverrides) {
    return err('loopConfig.json 缺少必要段（loopDefaults/hardLimits/stopRules/roleOverrides）', 'FATAL');
  }

  // 校验 roleOverrides 键集必须与 agents.role 全集一一对应
  const expectedRoles = [
    'prime_director', 'partner', 'worker', 'reviewer',
    'assembly_node', 'arbitrator', 'auditor', 'regulator',
  ];
  for (const role of expectedRoles) {
    if (!(role in roleOverrides)) {
      errors.push({ path: `roleOverrides.${role}`, message: '缺少角色覆盖配置' });
    }
  }
  // 检查未知角色键
  for (const key of Object.keys(roleOverrides)) {
    if (!expectedRoles.includes(key)) {
      errors.push({ path: `roleOverrides.${key}`, message: `未知角色键，合法值: ${expectedRoles.join('/')}` });
    }
  }

  // 校验 roleOverrides 内只允许 max_iterations / token_budget / temperature
  const allowedOverrideKeys = ['max_iterations', 'token_budget', 'temperature'];
  for (const [role, overrides] of Object.entries(roleOverrides)) {
    if (overrides && typeof overrides === 'object') {
      for (const key of Object.keys(overrides as Record<string, unknown>)) {
        if (!allowedOverrideKeys.includes(key)) {
          errors.push({
            path: `roleOverrides.${role}.${key}`,
            message: `不允许覆盖此键，合法值: ${allowedOverrideKeys.join('/')}`,
          });
        }
      }
    }
  }

  // 校验 budget 比例递增：warmRatio < softRatio < expandRequestRatio < hardRatio <= 1.0
  const budget = stopRules['budget'] as Record<string, unknown> | undefined;
  if (budget) {
    const warm = budget['warmRatio'] as number;
    const soft = budget['softRatio'] as number;
    const expand = budget['expandRequestRatio'] as number;
    const hard = budget['hardRatio'] as number;
    if (!(warm < soft && soft < expand && expand <= hard && hard <= 1.0)) {
      errors.push({
        path: 'stopRules.budget',
        message: `比例必须递增: warm(${warm}) < soft(${soft}) < expand(${expand}) <= hard(${hard}) <= 1.0`,
      });
    }
  }

  // 校验 partitionCeilingRatio 四项和 <= 1.0
  const context = config['context'] as Record<string, unknown> | undefined;
  if (context) {
    const ceiling = context['partitionCeilingRatio'] as Record<string, number> | undefined;
    if (ceiling) {
      const sum = (ceiling['static'] ?? 0) + (ceiling['lowFreq'] ?? 0) +
                  (ceiling['midFreq'] ?? 0) + (ceiling['highFreq'] ?? 0);
      if (sum > 1.0 + 1e-9) {
        errors.push({
          path: 'context.partitionCeilingRatio',
          message: `四项之和 ${sum} > 1.0`,
        });
      }
    }
  }

  // 校验 profitSharing 权重和 = 1
  const economy = config['economy'] as Record<string, unknown> | undefined;
  if (economy) {
    const ps = (economy['profitSharing'] as Record<string, number>) ?? {};
    const weightSum = (ps['qualityWeight'] ?? 0) + (ps['quantityWeight'] ?? 0) + (ps['efficiencyWeight'] ?? 0);
    if (Math.abs(weightSum - 1.0) > 1e-9) {
      errors.push({
        path: 'economy.profitSharing',
        message: `权重和 ${weightSum} != 1.0`,
      });
    }
  }

  // 校验 arbitrationModels 长度 >= 3
  const routing = config['routing'] as Record<string, unknown> | undefined;
  if (routing) {
    const models = routing['arbitrationModels'];
    if (!Array.isArray(models) || models.length < 3) {
      errors.push({
        path: 'routing.arbitrationModels',
        message: '仲裁模型列表长度必须 >= 3',
      });
    }
  }

  if (errors.length > 0) {
    return err(`Loop 配置校验失败: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`, 'FATAL');
  }
  return ok(errors);
}

/**
 * 运行全部配置校验
 */
export function validateAllConfigs(configs: Record<string, Record<string, unknown>>): Result<void> {
  // 校验 default.json
  const defaultResult = validateDefaultConfig(configs['default'] ?? {});
  if (!defaultResult.ok) return defaultResult as unknown as Result<void>;

  // 校验 loopConfig.json
  const loopResult = validateLoopConfig(configs['loopConfig'] ?? {});
  if (!loopResult.ok) return loopResult as unknown as Result<void>;

  return ok(undefined);
}
