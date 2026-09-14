/**
 * S1-① Infra/Config 模块测试
 *
 * 覆盖：configLoader / configValidator / mutationLevels
 */

import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';

import { loadConfig, getConfigValue, getConfigValueOr } from '../../Src/Infra/Config/configLoader.js';
import { validateDefaultConfig, validateLoopConfig } from '../../Src/Infra/Config/configValidator.js';
import {
  getMutabilityLevel, isHotReloadable, isStartupLocked, getStartupLockedSections,
} from '../../Src/Infra/Config/mutationLevels.js';
import { MutabilityLevel } from '../../Src/Infra/types.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CONFIG_DIR = join(ROOT, 'Configs');

describe('S1-① Config 模块', () => {
  // ===== configLoader =====
  describe('configLoader', () => {
    it('加载成功：全默认值可运行', () => {
      const result = loadConfig({ configDir: CONFIG_DIR });
      if (!result.ok) {
        console.error('loadConfig error:', result.error);
      }
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.env).toBe('dev');
        expect(result.value.configDir).toBe(CONFIG_DIR);
        expect(result.value.merged).toHaveProperty('system');
        expect(result.value.merged).toHaveProperty('server');
        expect(result.value.merged).toHaveProperty('database');
      }
    });

    it('getConfigValue 可正确读取嵌套值', () => {
      const result = loadConfig({ configDir: CONFIG_DIR });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(getConfigValue<string>(result.value, 'system.name')).toBe('Civitas-AI');
        expect(getConfigValue<number>(result.value, 'server.httpPort')).toBe(3000);
        expect(getConfigValue<boolean>(result.value, 'database.walMode')).toBe(true);
      }
    });

    it('getConfigValueOr 不存在时返回默认值', () => {
      const result = loadConfig({ configDir: CONFIG_DIR });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(getConfigValueOr(result.value, 'nonexistent.path', 'fallback')).toBe('fallback');
        expect(getConfigValueOr(result.value, 'system.name', 'fallback')).toBe('Civitas-AI');
      }
    });

    it('加载失败：不存在的配置目录', () => {
      const result = loadConfig({ configDir: '/nonexistent/path' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.severity).toBe('FATAL');
      }
    });
  });

  // ===== configValidator =====
  describe('configValidator', () => {
    it('validateDefaultConfig: 合法配置通过', () => {
      const result = validateDefaultConfig({
        system: { name: 'test', version: '0.1.0', logLevel: 'info', dataDir: 'Data/', logDir: 'Logs/', promptDir: 'Prompts/' },
        server: { host: '0.0.0.0', httpPort: 3000, wsPort: 3001 },
        database: { mainPath: 'a.db', eventsPath: 'b.db', memoryPath: 'c.db', walMode: true, busyTimeoutMs: 5000 },
      });
      expect(result.ok).toBe(true);
    });

    it('validateDefaultConfig: 类型错误被拒绝', () => {
      const result = validateDefaultConfig({
        system: { name: 123 }, // 类型错误
      });
      expect(result.ok).toBe(false);
    });

    it('validateLoopConfig: 合法 loopConfig 通过', () => {
      const result = validateLoopConfig({
        loopDefaults: { model: 'workerModel', max_iterations: 30, timeout_ms: 60000, temperature: 0.2, token_budget: 100000, stream: true },
        hardLimits: { maxIterationsCeiling: 200, timeoutMsCeiling: 600000, maxWallClockMsCeiling: 3600000, tokenBudgetCeiling: 2000000 },
        roleOverrides: {
          prime_director: { max_iterations: 100, token_budget: 500000, temperature: 0.3 },
          partner: { max_iterations: 50, token_budget: 200000, temperature: 0.3 },
          worker: { max_iterations: 30, token_budget: 100000, temperature: 0.2 },
          reviewer: { max_iterations: 5, token_budget: 50000, temperature: 0.0 },
          assembly_node: { max_iterations: 10, token_budget: 60000, temperature: 0.1 },
          arbitrator: { max_iterations: 5, token_budget: 50000, temperature: 0.0 },
          auditor: { max_iterations: 20, token_budget: 80000, temperature: 0.0 },
          regulator: { max_iterations: 15, token_budget: 80000, temperature: 0.1 },
        },
        stopRules: {
          limits: { maxIterations: 30, maxWallClockMs: 900000, maxToolCalls: 100, maxConsecutiveErrors: 3 },
          budget: { warmRatio: 0.36, softRatio: 0.6, expandRequestRatio: 0.8, hardRatio: 1.0 },
          noProgress: { metric: 'goal_distance', stagnationWindowRounds: 3, minDeltaRatio: 0.05, action: 'switch_strategy' },
          evaluationOrder: ['risk', 'limits', 'budget', 'noProgress', 'success'],
        },
        context: {
          partitionCeilingRatio: { static: 0.15, lowFreq: 0.15, midFreq: 0.15, highFreq: 0.45 },
        },
        economy: {
          profitSharing: { qualityWeight: 0.5, quantityWeight: 0.3, efficiencyWeight: 0.2 },
        },
        routing: {
          arbitrationModels: ['openai/gpt-4o', 'anthropic/claude', 'aliyun/qwen-max'],
        },
      });
      expect(result.ok).toBe(true);
    });

    it('validateLoopConfig: 未知角色键被拒绝', () => {
      const result = validateLoopConfig({
        loopDefaults: {},
        hardLimits: {},
        roleOverrides: { unknown_role: {} },
        stopRules: { budget: { warmRatio: 0.36, softRatio: 0.6, expandRequestRatio: 0.8, hardRatio: 1.0 } },
      });
      expect(result.ok).toBe(false);
    });

    it('validateLoopConfig: budget 比例非递增被拒绝', () => {
      const result = validateLoopConfig({
        loopDefaults: {},
        hardLimits: {},
        roleOverrides: {
          prime_director: {}, partner: {}, worker: {}, reviewer: {},
          assembly_node: {}, arbitrator: {}, auditor: {}, regulator: {},
        },
        stopRules: { budget: { warmRatio: 0.8, softRatio: 0.6, expandRequestRatio: 0.9, hardRatio: 1.0 } },
      });
      expect(result.ok).toBe(false);
    });
  });

  // ===== mutationLevels =====
  describe('mutationLevels', () => {
    it('security 段为 L0 启动锁定', () => {
      expect(getMutabilityLevel('security')).toBe(MutabilityLevel.L0);
      expect(isStartupLocked('security')).toBe(true);
      expect(isHotReloadable('security')).toBe(false);
    });

    it('database 段为 L0 启动锁定', () => {
      expect(getMutabilityLevel('database')).toBe(MutabilityLevel.L0);
      expect(isStartupLocked('database')).toBe(true);
    });

    it('routing 段为 L2 运行时可重载', () => {
      expect(getMutabilityLevel('routing')).toBe(MutabilityLevel.L2);
      expect(isHotReloadable('routing')).toBe(true);
      expect(isStartupLocked('routing')).toBe(false);
    });

    it('未注册段默认 L2', () => {
      expect(getMutabilityLevel('unknownSection')).toBe(MutabilityLevel.L2);
      expect(isHotReloadable('unknownSection')).toBe(true);
    });

    it('getStartupLockedSections 返回 L0 段', () => {
      const sections = getStartupLockedSections();
      expect(sections).toContain('security');
      expect(sections).toContain('database');
      expect(sections).not.toContain('routing');
    });
  });
});
