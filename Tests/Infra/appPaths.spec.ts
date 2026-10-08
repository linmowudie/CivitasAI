/**
 * 目录与环境契约测试（安装态 / 便携态 / 开发态）。
 *
 * 覆盖：
 * - 两个根环境变量 `CIVITAS_APP_ROOT` / `CIVITAS_DATA_ROOT` 与 `CIVITAS_WORKSPACE_ROOT`
 * - 旧变量兼容（`CIVITAS_DATA_DIR` / `CIVITAS_LOG_DIR` / …）
 * - 便携态 vs 安装态的数据根/工作空间根差异，及"安装目录只读 → 工作空间回落"
 * - `resolveDataPath` 的 `Data/...` 兼容语义
 * - `ensureDirSafe` / `probeWrite` 不抛错
 * - `loadConfig` 的分层：用户 local.json 覆盖内置功能文件，且 `api_key_ref: env:…` 保持引用形态
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  getAppRoot,
  getDataRoot,
  getDataDir,
  getWorkspaceRoot,
  getLogDir,
  getDatabaseDir,
  getSecretsDir,
  getBackupDir,
  getConfigDir,
  getBundledConfigDir,
  getPromptsDir,
  getSkillsDir,
  getEnvFilePaths,
  getInstallMode,
  resolveDataPath,
  isWithin,
  ensureDirSafe,
  probeWrite,
  resetPathCache,
  describePaths,
} from '../../Src/Infra/Fs/pathResolver.js';
import { loadConfig } from '../../Src/Infra/Config/configLoader.js';

// ── 环境变量沙箱 ────────────────────────────────────────────────────

const MANAGED_ENV = [
  'CIVITAS_APP_ROOT', 'CIVITAS_DATA_ROOT', 'CIVITAS_DATA_DIR', 'CIVITAS_WORKSPACE_ROOT',
  'CIVITAS_LOG_DIR', 'CIVITAS_CONFIG_DIR', 'CIVITAS_CONFIG_DIR_BUILTIN',
  'CIVITAS_PROMPTS_DIR', 'CIVITAS_SKILLS_DIR', 'CIVITAS_BACKUP_DIR',
  'CIVITAS_PORTABLE', 'CIVITAS_INSTALLED', 'CIVITAS_ENV',
] as const;

let savedEnv: Record<string, string | undefined> = {};
let tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `civitas-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetPathCache();
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetPathCache();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }
  tempDirs = [];
});

// ── 开发态缺省 ──────────────────────────────────────────────────────

describe('pathResolver · 开发态缺省', () => {
  it('未设置任何环境变量时按仓库根解析（与历史布局一致）', () => {
    expect(getInstallMode()).toBe('development');
    const repoRoot = resolve(__dirname, '../..');
    expect(getAppRoot()).toBe(repoRoot);
    expect(getDataRoot()).toBe(join(repoRoot, 'Data'));
    expect(getDataDir()).toBe(getDataRoot());
    // 开发态工作空间根 == 数据根：保持 <仓库>/Data/workspaces 的历史布局
    expect(getWorkspaceRoot()).toBe(getDataRoot());
    expect(getConfigDir()).toBe(join(repoRoot, 'Configs'));
    expect(getBundledConfigDir()).toBe(join(repoRoot, 'Configs'));
    expect(getLogDir()).toBe(join(repoRoot, 'Data', 'Logs'));
    expect(getDatabaseDir()).toBe(join(repoRoot, 'Data', 'db'));
    expect(getSecretsDir()).toBe(join(repoRoot, 'Data', '.secrets'));
    expect(getBackupDir()).toBe(join(repoRoot, 'Data', '.civitas'));
    expect(getPromptsDir()).toBe(join(repoRoot, 'Prompts'));
    expect(getSkillsDir()).toBe(join(repoRoot, 'Skills'));
  });

  it('CIVITAS_APP_ROOT 覆盖程序根，其余目录随动', () => {
    const appRoot = tempDir('approot');
    process.env['CIVITAS_APP_ROOT'] = appRoot;
    resetPathCache();
    expect(getAppRoot()).toBe(appRoot);
    expect(getDataRoot()).toBe(join(appRoot, 'Data'));
    expect(getBundledConfigDir()).toBe(join(appRoot, 'Configs'));
  });
});

// ── 两个根变量 ──────────────────────────────────────────────────────

describe('pathResolver · 根变量契约', () => {
  it('CIVITAS_DATA_ROOT 决定全局数据根（库/日志/密钥随动；配置层随运行形态）', () => {
    const appRoot = tempDir('approot');
    const dataRoot = tempDir('dataroot');
    process.env['CIVITAS_APP_ROOT'] = appRoot;
    process.env['CIVITAS_DATA_ROOT'] = dataRoot;
    process.env['CIVITAS_INSTALLED'] = '1'; // 安装态：用户配置层落数据根
    resetPathCache();
    expect(getDataRoot()).toBe(dataRoot);
    expect(getLogDir()).toBe(join(dataRoot, 'Logs'));
    expect(getDatabaseDir()).toBe(join(dataRoot, 'db'));
    expect(getSecretsDir()).toBe(join(dataRoot, '.secrets'));
    expect(getConfigDir()).toBe(join(dataRoot, 'Configs'));
    // 只读资产仍在程序根
    expect(getPromptsDir()).toBe(join(appRoot, 'Prompts'));
    expect(getSkillsDir()).toBe(join(appRoot, 'Skills'));
  });

  it('开发态：配置层仍读仓库 Configs（不因数据根覆盖而漂移）', () => {
    const appRoot = tempDir('approot');
    const dataRoot = tempDir('dataroot');
    process.env['CIVITAS_APP_ROOT'] = appRoot;
    process.env['CIVITAS_DATA_ROOT'] = dataRoot;
    resetPathCache();
    expect(getConfigDir()).toBe(join(appRoot, 'Configs'));
  });

  it('CIVITAS_WORKSPACE_ROOT 决定工作空间根与 .civitas 备份根', () => {
    const dataRoot = tempDir('dataroot');
    const wsRoot = tempDir('wsroot');
    process.env['CIVITAS_DATA_ROOT'] = dataRoot;
    process.env['CIVITAS_WORKSPACE_ROOT'] = wsRoot;
    resetPathCache();
    expect(getWorkspaceRoot()).toBe(wsRoot);
    expect(getBackupDir()).toBe(join(wsRoot, '.civitas'));
  });

  it('旧变量 CIVITAS_DATA_DIR / CIVITAS_LOG_DIR 仍生效（向后兼容）', () => {
    const legacy = tempDir('legacy');
    process.env['CIVITAS_DATA_DIR'] = legacy;
    process.env['CIVITAS_LOG_DIR'] = join(legacy, 'my-logs');
    resetPathCache();
    expect(getDataRoot()).toBe(legacy);
    expect(getLogDir()).toBe(join(legacy, 'my-logs'));
  });

  it('CIVITAS_DATA_ROOT 优先于旧的 CIVITAS_DATA_DIR', () => {
    const newRoot = tempDir('new');
    const oldRoot = tempDir('old');
    process.env['CIVITAS_DATA_ROOT'] = newRoot;
    process.env['CIVITAS_DATA_DIR'] = oldRoot;
    resetPathCache();
    expect(getDataRoot()).toBe(newRoot);
  });

  it('getEnvFilePaths 覆盖"数据根 .env"与"程序根 .env"', () => {
    const appRoot = tempDir('approot');
    const dataRoot = tempDir('dataroot');
    process.env['CIVITAS_APP_ROOT'] = appRoot;
    process.env['CIVITAS_DATA_ROOT'] = dataRoot;
    resetPathCache();
    expect(getEnvFilePaths()).toEqual([join(dataRoot, '.env'), join(appRoot, '.env')]);
  });
});

// ── 便携态 / 安装态 ─────────────────────────────────────────────────

describe('pathResolver · 便携态与安装态', () => {
  it('便携态（CIVITAS_PORTABLE=1）：数据与工作空间都在程序目录下', () => {
    const appRoot = tempDir('approot');
    process.env['CIVITAS_APP_ROOT'] = appRoot;
    process.env['CIVITAS_PORTABLE'] = '1';
    resetPathCache();
    expect(getInstallMode()).toBe('portable');
    expect(getDataRoot()).toBe(join(appRoot, 'Data'));
    expect(getWorkspaceRoot()).toBe(join(appRoot, 'Workspace'));
    expect(getBackupDir()).toBe(join(appRoot, 'Workspace', '.civitas'));
  });

  it('安装态：全局数据在数据根、工作空间在安装目录（用户明确要求的分布）', () => {
    const appRoot = tempDir('install');   // 可写，模拟 %LOCALAPPDATA%\Programs\CivitasAI
    const appdata = tempDir('appdata');   // 模拟 %APPDATA%\CivitasAI
    process.env['CIVITAS_APP_ROOT'] = appRoot;
    process.env['CIVITAS_INSTALLED'] = '1';
    process.env['CIVITAS_DATA_ROOT'] = appdata;
    resetPathCache();

    expect(getInstallMode()).toBe('installed');
    expect(getDataRoot()).toBe(appdata);
    expect(getDatabaseDir()).toBe(join(appdata, 'db'));
    expect(getSecretsDir()).toBe(join(appdata, '.secrets'));
    // 工作空间数据落安装目录
    expect(getWorkspaceRoot()).toBe(join(appRoot, 'Workspace'));
    expect(getBackupDir()).toBe(join(appRoot, 'Workspace', '.civitas'));
  });

  it('安装目录不可写（如 Program Files）时工作空间自动回落到数据根并给出告警', () => {
    const missingAppRoot = join(tmpdir(), `civitas-missing-${process.pid}-${Date.now()}`);
    const appdata = tempDir('appdata');
    process.env['CIVITAS_APP_ROOT'] = missingAppRoot;
    process.env['CIVITAS_INSTALLED'] = '1';
    process.env['CIVITAS_DATA_ROOT'] = appdata;
    resetPathCache();

    expect(getWorkspaceRoot()).toBe(join(appdata, 'Workspace'));
    const diag = describePaths();
    expect(diag.warnings.join('\n')).toContain('工作空间目录不可写');
    expect(existsSync(missingAppRoot)).toBe(false); // 解析过程不得创建不可写位置
  });

  it('打包不等于便携：仅有 CIVITAS_INSTALLED 时不是便携态', () => {
    process.env['CIVITAS_INSTALLED'] = '1';
    resetPathCache();
    expect(getInstallMode()).toBe('installed');
    expect(getInstallMode()).not.toBe('portable');
  });
});

// ── 配置相对路径解析 ────────────────────────────────────────────────

describe('resolveDataPath', () => {
  beforeEach(() => {
    process.env['CIVITAS_DATA_ROOT'] = resolve(tmpdir(), 'civitas-data-for-test');
    resetPathCache();
  });

  it('`Data/...` 前缀按数据根解析（兼容历史配置写法）', () => {
    expect(resolveDataPath('Data/db/civitas_main.db', 'x'))
      .toBe(join(resolve(tmpdir(), 'civitas-data-for-test'), 'db', 'civitas_main.db'));
  });

  it('普通相对路径也按数据根解析', () => {
    expect(resolveDataPath('db/x.db', 'y'))
      .toBe(join(resolve(tmpdir(), 'civitas-data-for-test'), 'db', 'x.db'));
  });

  it('绝对路径原样使用（不拼接数据根）', () => {
    const abs = join(tmpdir(), 'other', 'z.db');
    expect(resolveDataPath(abs, 'y')).toBe(abs);
  });

  it('空值回落到缺省相对路径', () => {
    expect(resolveDataPath(undefined, 'Data/db/fallback.db'))
      .toBe(join(resolve(tmpdir(), 'civitas-data-for-test'), 'db', 'fallback.db'));
    expect(resolveDataPath('   ', 'Data/db/fallback.db'))
      .toBe(join(resolve(tmpdir(), 'civitas-data-for-test'), 'db', 'fallback.db'));
  });
});

describe('isWithin', () => {
  it('识别同根与子路径，拒绝旁系', () => {
    expect(isWithin('C:\\a\\b', 'C:\\a\\b')).toBe(true);
    expect(isWithin('C:\\a\\b', 'C:\\a\\b\\c\\d.txt')).toBe(true);
    expect(isWithin('C:\\a\\b', 'C:\\a\\bc\\d.txt')).toBe(false);
    expect(isWithin('C:\\a\\b', 'C:\\a\\b\\..\\c')).toBe(false);
  });
});

// ── 目录创建不抛错 ──────────────────────────────────────────────────

describe('目录工具不抛错（安装态只读场景的兜底）', () => {
  it('ensureDirSafe 对非法位置返回 ok:false 而不抛异常', () => {
    const file = join(tempDir('fs'), 'a-file.txt');
    writeFileSync(file, 'x', 'utf8');
    // 以"文件"为父目录建子目录必然失败
    const result = ensureDirSafe(join(file, 'child'));
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('probeWrite 在可写目录成功，在非法位置失败而不抛异常', () => {
    const dir = tempDir('writable');
    expect(probeWrite(dir).ok).toBe(true);

    const file = join(dir, 'b.txt');
    writeFileSync(file, 'x', 'utf8');
    const bad = probeWrite(join(file, 'sub'));
    expect(bad.ok).toBe(false);
  });
});

// ── 配置分层 ────────────────────────────────────────────────────────

describe('loadConfig · 内置种子 + 用户覆盖层', () => {
  function writeJson(dir: string, name: string, value: unknown): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2), 'utf8');
  }

  const REPO_CONFIGS = resolve(__dirname, '../../Configs');

  /** 用仓库真实 default.json 作基线（保证通过 configValidator 的必填项校验） */
  function writeDefault(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const content = readFileSync(join(REPO_CONFIGS, 'default.json'), 'utf8');
    writeFileSync(join(dir, 'default.json'), content, 'utf8');
    // loopConfig 等必填段来自同名功能文件：一并作为"内置种子"复制
    for (const name of ['loopConfig.json', 'security.json']) {
      writeFileSync(join(dir, name), readFileSync(join(REPO_CONFIGS, name)), 'utf8');
    }
  }

  it('用户 local.json 覆盖内置功能文件（首次运行引导的写入路径）', () => {
    const bundled = tempDir('bundled');
    const user = tempDir('user');
    writeDefault(bundled);
    writeJson(bundled, 'modelRouter.json', {
      // arbitrationModels 长度 ≥ 3 是 loopConfig 校验硬约束，基线必须带上
      routing: { defaultModel: 'huawei-maas/DeepSeek-V4-Flash', timeoutMs: 60000, arbitrationModels: ['a', 'b', 'c'] },
      providers: [{ provider: 'huawei-maas', api_key_ref: 'env:HUAWEI_MAAS_API_KEY' }],
    });
    // 首次运行引导写入：用户层 local.json 选自己的供应商与模型
    writeJson(user, 'local.json', {
      routing: { defaultModel: 'my-provider/my-model' },
    });

    const result = loadConfig({ configDir: bundled, userConfigDir: user, env: 'dev' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const routing = (result.value.merged['routing'] ?? {}) as Record<string, unknown>;
    expect(routing['defaultModel']).toBe('my-provider/my-model');
    // 未被覆盖的键保留内置值
    expect(routing['timeoutMs']).toBe(60000);
  });

  it('功能文件里的 api_key_ref 保持 `env:` 引用形态（不得被提前展开）', () => {
    const bundled = tempDir('bundled');
    const user = tempDir('user');
    writeDefault(bundled);
    writeJson(bundled, 'modelRouter.json', {
      providers: [{ provider: 'p1', api_key_ref: 'env:CIVITAS_TEST_KEY_XYZ' }],
    });
    process.env['CIVITAS_TEST_KEY_XYZ'] = 'sk-should-not-be-inlined';

    const result = loadConfig({ configDir: bundled, userConfigDir: user, env: 'dev' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const providers = result.value.merged['providers'] as Array<Record<string, unknown>>;
    expect(providers[0]?.['api_key_ref']).toBe('env:CIVITAS_TEST_KEY_XYZ');

    delete process.env['CIVITAS_TEST_KEY_XYZ'];
  });

  it('用户层功能文件（如 modelRouter.json）覆盖内置同名文件', () => {
    const bundled = tempDir('bundled');
    const user = tempDir('user');
    writeDefault(bundled);
    writeJson(bundled, 'modelRouter.json', {
      routing: { defaultModel: 'builtin/model', arbitrationModels: ['a', 'b', 'c'] },
    });
    writeJson(user, 'modelRouter.json', { routing: { defaultModel: 'user/model' } });

    const result = loadConfig({ configDir: bundled, userConfigDir: user });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const routing = result.value.merged['routing'] as Record<string, unknown>;
    expect(routing['defaultModel']).toBe('user/model');
  });

  it('缺少 default.json → FATAL（错误信息含路径）', () => {
    const empty = tempDir('empty');
    const result = loadConfig({ configDir: empty, userConfigDir: empty });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('default.json');
  });

  it('用户目录 == 内置目录时不重复合并（开发态）', () => {
    const bundled = tempDir('same');
    writeDefault(bundled);
    writeJson(bundled, 'local.json', { server: { httpPort: 4321 } });
    const result = loadConfig({ configDir: bundled, userConfigDir: bundled });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const server = result.value.merged['server'] as Record<string, unknown>;
    expect(server['httpPort']).toBe(4321);
  });
});
