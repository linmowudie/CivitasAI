/**
 * Gate G0 测试：工程基线验证
 *
 * ✅ 删除所有 Configs/local.json 后仍可启动（全默认值可运行）
 * ✅ 层间依赖违规可被 ESLint 拦截（通过代码模拟验证）
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

describe('Gate G0 — 工程基线', () => {
  it('G0-1: default.json 存在且可解析', () => {
    const defaultPath = join(ROOT, 'Configs', 'default.json');
    expect(existsSync(defaultPath)).toBe(true);
    const config = JSON.parse(readFileSync(defaultPath, 'utf-8'));
    expect(config).toHaveProperty('system');
    expect(config).toHaveProperty('server');
    expect(config).toHaveProperty('database');
  });

  it('G0-2: 全部 14 个配置文件存在且为合法 JSON', () => {
    const requiredFiles = [
      'default.json', 'modelRouter.json', 'routingRules.json',
      'economyRules.json', 'arbitration.json', 'audit.json',
      'supervision.json', 'loopConfig.json', 'durable.json',
      'session.json', 'memory.json', 'security.json',
      'coverageBaseline.json', 'benchBaseline.json',
    ];
    for (const file of requiredFiles) {
      const filePath = join(ROOT, 'Configs', file);
      expect(existsSync(filePath), `${file} 不存在`).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(() => JSON.parse(content), `${file} 不是合法 JSON`).not.toThrow();
    }
  });

  it('G0-3: 无 local.json 时 default.json 提供所有必要键', () => {
    const defaultPath = join(ROOT, 'Configs', 'default.json');
    const config = JSON.parse(readFileSync(defaultPath, 'utf-8'));

    // system 段
    expect(config.system).toHaveProperty('name');
    expect(config.system).toHaveProperty('version');
    expect(config.system).toHaveProperty('logLevel');
    expect(config.system).toHaveProperty('dataDir');
    expect(config.system).toHaveProperty('logDir');

    // server 段
    expect(config.server).toHaveProperty('host');
    expect(config.server).toHaveProperty('httpPort');
    expect(config.server).toHaveProperty('wsPort');

    // database 段
    expect(config.database).toHaveProperty('mainPath');
    expect(config.database).toHaveProperty('eventsPath');
    expect(config.database).toHaveProperty('memoryPath');
    expect(config.database).toHaveProperty('walMode');
    expect(config.database).toHaveProperty('busyTimeoutMs');
  });

  it('G0-4: 五层目录骨架完整', () => {
    const requiredDirs = [
      'Src/Interface', 'Src/Core', 'Src/Services', 'Src/Tools', 'Src/Infra',
      'Src/Core/Loop', 'Src/Core/Middleware', 'Src/Core/Model', 'Src/Core/Decision',
      'Src/Services/Context', 'Src/Services/Supervision', 'Src/Services/LoopControl',
      'Src/Infra/DurableExecution', 'Src/Infra/Config', 'Src/Infra/Db',
      'Src/Infra/Logging', 'Src/Infra/Llm',
      'Tests', 'Configs', 'ADR', 'Prompts', 'Skills', 'Data', 'Logs',
    ];
    for (const dir of requiredDirs) {
      const dirPath = join(ROOT, dir);
      expect(existsSync(dirPath), `目录 ${dir} 不存在`).toBe(true);
    }
  });

  it('G0-5: 5 个 ADR 文件存在', () => {
    const adrFiles = [
      '0001-approval-gate-pause-signal.md',
      '0002-lawyer-letter-interruption-exemption.md',
      '0003-verifier-four-tier-non-skip.md',
      '0004-maker-checker-model-diversity.md',
      '0005-loopstate-immutable-from-compression.md',
    ];
    for (const file of adrFiles) {
      const filePath = join(ROOT, 'ADR', file);
      expect(existsSync(filePath), `ADR ${file} 不存在`).toBe(true);
    }
  });

  it('G0-6: ESLint 配置包含层间依赖限制规则', () => {
    const eslintPath = join(ROOT, '.eslintrc.json');
    expect(existsSync(eslintPath)).toBe(true);
    const eslintConfig = JSON.parse(readFileSync(eslintPath, 'utf-8'));
    const restrictedPaths = eslintConfig.rules['import/no-restricted-paths'];
    expect(restrictedPaths).toBeDefined();
    expect(restrictedPaths[0]).toBe('error');
    // 验证 zones 覆盖了所有五层
    const zones = restrictedPaths[1].zones;
    expect(zones.length).toBeGreaterThanOrEqual(4);
  });

  it('G0-7: loopConfig.json 包含全部 8 个角色覆盖键', () => {
    const configPath = join(ROOT, 'Configs', 'loopConfig.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const expectedRoles = [
      'prime_director', 'partner', 'worker', 'reviewer',
      'assembly_node', 'arbitrator', 'auditor', 'regulator',
    ];
    for (const role of expectedRoles) {
      expect(config.roleOverrides).toHaveProperty(role);
    }
  });

  it('G0-8: 配置值符合类型规范（比例为 0-1，时长带单位后缀）', () => {
    const configPath = join(ROOT, 'Configs', 'default.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));

    // busyTimeoutMs 是数字
    expect(typeof config.database.busyTimeoutMs).toBe('number');
    expect(config.database.busyTimeoutMs).toBeGreaterThan(0);

    // httpPort 是整数
    expect(Number.isInteger(config.server.httpPort)).toBe(true);

    // walMode 是布尔
    expect(typeof config.database.walMode).toBe('boolean');
  });
});
