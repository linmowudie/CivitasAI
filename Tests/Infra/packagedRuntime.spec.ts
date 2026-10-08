/**
 * 打包态后端修复的回归测试（2026-10-06）。
 *
 * 背景：这些问题**只在打包/安装态暴露**（开发态直跑时 `process.cwd()`、日志目录都可写，
 * 看上去一切正常）。本组测试用"模拟打包态"的方式把它们钉住：
 *
 * 1. `logWriter` 可写探针必须**真删除**探针文件，且清掉历史版本遗留的 `.write_test.tmp`；
 * 2. `shellRunner` 在**没有** `context.workDir` 时，命令 cwd 必须收敛到会话工作目录/工作空间根，
 *    **绝不**回落到 `process.cwd()`；
 * 3. `pathResolver` 的便携标记检测在打包态**不再看 cwd**（否则快捷方式"起始位置"里的
 *    `.portable` 会把安装版误判成便携版，数据根整体错位）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LogWriter } from '../../Src/Infra/Logging/logWriter.js';
import { getInstallMode, resetPathCache } from '../../Src/Infra/Fs/pathResolver.js';

const MANAGED = ['CIVITAS_PORTABLE', 'CIVITAS_INSTALLED', 'CIVITAS_APP_ROOT', 'CIVITAS_DATA_ROOT', 'CIVITAS_WORKSPACE_ROOT'] as const;

let sandbox = '';
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'civitas-pkgfix-'));
  saved = {};
  for (const key of MANAGED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetPathCache();
});

afterEach(() => {
  for (const key of MANAGED) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetPathCache();
  vi.restoreAllMocks();
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

// ── 1. 日志可写探针不留垃圾 ────────────────────────────────────────

describe('logWriter 可写探针（打包态垃圾文件修复）', () => {
  it('初始化后日志目录里不残留 .write_test / .write_test.tmp', () => {
    const logDir = join(sandbox, 'Logs');
    const writer = new LogWriter({ logDir, flushIntervalMs: 60_000 });
    writer.init();                       // 可写探针在 init() 里执行
    expect(writer.isDirWritable()).toBe(true);

    const names = readdirSync(logDir);
    expect(names).not.toContain('.write_test');
    expect(names).not.toContain('.write_test.tmp');
    writer.close();
  });

  it('自动清理历史版本遗留的 .write_test.tmp（升级后收敛）', () => {
    const logDir = join(sandbox, 'Logs');
    mkdirSync(logDir, { recursive: true });
    // 模拟旧版本启动留下的垃圾文件
    writeFileSync(join(logDir, '.write_test.tmp'), 'legacy');
    expect(existsSync(join(logDir, '.write_test.tmp'))).toBe(true);

    const writer = new LogWriter({ logDir, flushIntervalMs: 60_000 });
    writer.init();
    expect(existsSync(join(logDir, '.write_test.tmp'))).toBe(false);
    writer.close();
  });

  it('目录不可写时不抛错，仅标记为不可写（Gate G1：日志失败不阻断）', () => {
    const blocked = new LogWriter({ logDir: join('Z:', 'definitely', 'missing', 'Logs'), flushIntervalMs: 60_000 });
    blocked.init();
    expect(blocked.isDirWritable()).toBe(false);
    // 刷盘/关闭都不应抛异常
    expect(() => blocked.flush()).not.toThrow();
    expect(() => blocked.close()).not.toThrow();
  });
});

// ── 2. shellRunner 的 cwd 兜底 ─────────────────────────────────────

describe('shellRunner 无 workDir 时的 cwd 兜底', () => {
  /** 构造最小可用执行上下文（ToolExecutionContext） */
  const ctx = (sessionId?: string) => ({
    operationId: 'op-cwd',
    agentId: 'agent-1',
    agentRole: 'worker' as const,
    sessionId,
    // 故意不传 workDir：模拟"会话未绑定工作目录"
  });

  it('使用会话工作目录执行命令，而不是 process.cwd()', async () => {
    process.env['CIVITAS_DATA_ROOT'] = join(sandbox, 'data');
    process.env['CIVITAS_WORKSPACE_ROOT'] = join(sandbox, 'Workspace');
    resetPathCache();

    const { shellRunner } = await import('../../Src/Tools/Builtin/Execute/shellRunner.js');
    const processCwd = process.cwd();   // 打包态下这个值不可控，绝不能被用作命令 cwd

    const result = await shellRunner.execute(
      { command: 'node -e "console.log(process.cwd())"' },
      ctx('sess-1'),
    );

    const payload = JSON.stringify(result);
    expect(payload).toContain('Workspace');
    expect(payload).toContain('sess-1');
    expect(result.status).toBe('success');
    // 关键断言：命令实际 cwd 是会话工作目录，而不是进程当前目录
    expect(payload).not.toContain(processCwd);
  });

  it('工作目录无法准备时返回 PATH_DENIED，而不是退回进程当前目录', async () => {
    // 用一个"父路径是文件"的不可创建目录，逼 mkdirSync 失败
    const blocker = join(sandbox, 'blocker');
    writeFileSync(blocker, 'not a dir');
    process.env['CIVITAS_DATA_ROOT'] = join(sandbox, 'data');
    process.env['CIVITAS_WORKSPACE_ROOT'] = join(blocker, 'Workspace');
    resetPathCache();

    const { shellRunner } = await import('../../Src/Tools/Builtin/Execute/shellRunner.js');
    const result = await shellRunner.execute(
      { command: 'node -e "console.log(1)"' },
      ctx('sess-2'),
    );

    expect(result.status).toBe('error');
    expect(JSON.stringify(result)).toMatch(/PATH_DENIED|无法准备工作目录/);
  });
});

// ── 3. 便携标记检测不再看 cwd ──────────────────────────────────────

describe('pathResolver 便携标记检测（打包态误判修复）', () => {
  it('打包态（Electron 注入 resourcesPath）忽略 cwd 里的 .portable', () => {
    // 伪造打包运行时特征
    const proc = process as unknown as { resourcesPath?: string; defaultApp?: boolean };
    const originalResources = proc.resourcesPath;
    const originalDefaultApp = proc.defaultApp;
    proc.resourcesPath = join(sandbox, 'resources');
    proc.defaultApp = false;

    // cwd 下放一个 .portable（模拟快捷方式"起始位置"里有该文件）
    const originalCwd = process.cwd;
    process.cwd = (() => sandbox) as typeof process.cwd;
    writeFileSync(join(sandbox, '.portable'), '');
    delete process.env['CIVITAS_PORTABLE'];
    resetPathCache();

    try {
      expect(getInstallMode()).not.toBe('portable');
    } finally {
      process.cwd = originalCwd;
      if (originalResources === undefined) delete proc.resourcesPath; else proc.resourcesPath = originalResources;
      if (originalDefaultApp === undefined) delete proc.defaultApp; else proc.defaultApp = originalDefaultApp;
      resetPathCache();
    }
  });

  it('开发态仍保留 cwd 兜底（源码直跑时可用 .portable 标记切换）', () => {
    const proc = process as unknown as { resourcesPath?: string; defaultApp?: boolean };
    delete proc.resourcesPath;
    delete proc.defaultApp;

    const originalCwd = process.cwd;
    process.cwd = (() => sandbox) as typeof process.cwd;
    writeFileSync(join(sandbox, '.portable'), '');
    delete process.env['CIVITAS_PORTABLE'];
    resetPathCache();

    try {
      expect(getInstallMode()).toBe('portable');
    } finally {
      process.cwd = originalCwd;
      resetPathCache();
    }
  });
});
