/**
 * 任务工作目录守卫测试（2026-10-01 FE-019/FE-020）。
 *
 * 覆盖：
 * - 默认目录 `<dataDir>/workspaces/<sessionId>/` 且幂等创建
 * - 相对路径在工作目录内解析；`../` 逃逸被拒
 * - 绝对路径在工作目录内通过、在目录外被拒
 * - shell 命令中的越界路径片段检测
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  defaultWorkspaceDir,
  ensureWorkspaceDir,
  resolveWithinWorkspace,
  isWithinWorkspace,
  findEscapingPathInCommand,
} from '../../Src/Infra/Security/workspaceGuard.js';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'civitas-ws-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('workspaceGuard', () => {
  it('默认工作目录为 <workspaces 基址>/<sessionId>/', () => {
    const dir = defaultWorkspaceDir('sess-abc', '/tmp/data/workspaces');
    expect(dir).toBe(resolve('/tmp/data/workspaces', 'sess-abc'));
  });

  it('未指定基址时落在项目根 Data/workspaces 下', () => {
    const dir = defaultWorkspaceDir('sess-default');
    expect(dir.replace(/\\/g, '/')).toMatch(/\/Data\/workspaces\/sess-default$/);
  });

  it('ensureWorkspaceDir 创建空目录且幂等', () => {
    const dir = join(root, 'ws-1');
    const first = ensureWorkspaceDir(dir);
    expect(first.ok).toBe(true);
    expect(existsSync(dir)).toBe(true);
    const second = ensureWorkspaceDir(dir);
    expect(second.ok).toBe(true);
  });

  it('相对路径解析到工作目录内', () => {
    const ws = join(root, 'ws-2');
    ensureWorkspaceDir(ws);
    const result = resolveWithinWorkspace('notes/a.txt', ws);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(join(ws, 'notes', 'a.txt'));
  });

  it('`..` 逃逸被拒绝', () => {
    const ws = join(root, 'ws-3');
    ensureWorkspaceDir(ws);
    const result = resolveWithinWorkspace('../outside.txt', ws);
    expect(result.ok).toBe(false);
  });

  it('相对路径多级 `..` 逃逸被拒绝', () => {
    const ws = join(root, 'ws-4');
    ensureWorkspaceDir(ws);
    expect(resolveWithinWorkspace('a/../../x.txt', ws).ok).toBe(false);
  });

  it('工作目录内的绝对路径通过', () => {
    const ws = join(root, 'ws-5');
    ensureWorkspaceDir(ws);
    const inside = join(ws, 'sub', 'file.txt');
    const result = resolveWithinWorkspace(inside, ws);
    expect(result.ok).toBe(true);
  });

  it('工作目录外的绝对路径被拒绝', () => {
    const ws = join(root, 'ws-6');
    ensureWorkspaceDir(ws);
    expect(resolveWithinWorkspace(join(root, 'elsewhere.txt'), ws).ok).toBe(false);
    // 典型的越界读取（用户主目录/系统目录）
    expect(resolveWithinWorkspace(join(tmpdir(), 'other.txt'), ws).ok).toBe(false);
  });

  it('空路径被拒绝', () => {
    expect(resolveWithinWorkspace('   ', root).ok).toBe(false);
  });

  it('isWithinWorkspace 对目录自身返回 true', () => {
    const ws = join(root, 'ws-7');
    ensureWorkspaceDir(ws);
    expect(isWithinWorkspace(ws, ws)).toBe(true);
    // 前缀相似但不同目录不算在内（ws-7-evil）
    expect(isWithinWorkspace(`${ws}-evil`, ws)).toBe(false);
  });

  it('已存在文件的真实路径校验同样生效', () => {
    const ws = join(root, 'ws-8');
    ensureWorkspaceDir(ws);
    writeFileSync(join(ws, 'a.txt'), 'x');
    expect(resolveWithinWorkspace('a.txt', ws).ok).toBe(true);
    expect(resolveWithinWorkspace('../ws-8/a.txt', ws).ok).toBe(true); // 归一化后仍在目录内
  });

  it('shell 命令中的越界路径被检出', () => {
    const ws = join(root, 'ws-9');
    ensureWorkspaceDir(ws);
    expect(findEscapingPathInCommand('dir /s', ws)).toBeNull();
    expect(findEscapingPathInCommand('cat notes.txt', ws)).toBeNull();
    expect(findEscapingPathInCommand('cat ../../etc/passwd', ws)).not.toBeNull();
    expect(findEscapingPathInCommand('type C:\\Windows\\win.ini', ws)).not.toBeNull();
    expect(findEscapingPathInCommand(`type ${join(ws, 'ok.txt')}`, ws)).toBeNull();
  });

  // ── 重复路径归一化（2026-10-08：工作目录注入模型上下文后的新风险面）──
  // 背景：模型看到绝对工作目录后，可能把该目录的"一部分"当成相对路径写，
  // 直接解析会拼出 <root>/Data/workspaces/<sess>/... 这种根内但不存在的重复目录，
  // 表现为"文件不存在/列目录为空"，比越界拒绝更难归因。

  it('相对路径里重复了工作目录尾部（多段）→ 剥离后正确解析', () => {
    const ws = join(root, 'ws-dup-1', 'Data', 'workspaces', 'sess-dup');
    ensureWorkspaceDir(ws);
    const r = resolveWithinWorkspace('Data/workspaces/sess-dup/src/a.ts', ws);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(join(ws, 'src', 'a.ts'));
  });

  it('反斜杠写法同样被归一化', () => {
    const ws = join(root, 'ws-dup-2', 'Data', 'workspaces', 'sess-dup2');
    ensureWorkspaceDir(ws);
    const r = resolveWithinWorkspace('Data\\workspaces\\sess-dup2\\src\\a.ts', ws);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(join(ws, 'src', 'a.ts'));
  });

  it('只带会话目录名（单段）且根内无同名目录 → 归一化', () => {
    const ws = join(root, 'ws-dup-3', 'Data', 'workspaces', 'sess-dup3');
    ensureWorkspaceDir(ws);
    const r = resolveWithinWorkspace('sess-dup3/src/a.ts', ws);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(join(ws, 'src', 'a.ts'));
  });

  it('单段同名目录在根内真实存在 → 不剥离（尊重真实相对路径）', () => {
    const ws = join(root, 'ws-dup-4', 'Data', 'workspaces', 'sess-dup4');
    ensureWorkspaceDir(ws);
    ensureWorkspaceDir(join(ws, 'sess-dup4'));
    const r = resolveWithinWorkspace('sess-dup4/report.txt', ws);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(join(ws, 'sess-dup4', 'report.txt'));
  });

  it('归一化不放松越界约束（`..` 与根外绝对路径仍被拒）', () => {
    const ws = join(root, 'ws-dup-5', 'Data', 'workspaces', 'sess-dup5');
    ensureWorkspaceDir(ws);
    expect(resolveWithinWorkspace('../outside.txt', ws).ok).toBe(false);
    expect(resolveWithinWorkspace('Data/../../outside.txt', ws).ok).toBe(false);
    expect(resolveWithinWorkspace(join(root, 'elsewhere.txt'), ws).ok).toBe(false);
  });

  it('正常相对路径与根内绝对路径不受归一化影响', () => {
    const ws = join(root, 'ws-dup-6', 'Data', 'workspaces', 'sess-dup6');
    ensureWorkspaceDir(ws);
    const rel = resolveWithinWorkspace('src/a.ts', ws);
    expect(rel.ok).toBe(true);
    if (rel.ok) expect(rel.value).toBe(join(ws, 'src', 'a.ts'));
    const abs = resolveWithinWorkspace(join(ws, 'src', 'a.ts'), ws);
    expect(abs.ok).toBe(true);
    if (abs.ok) expect(abs.value).toBe(join(ws, 'src', 'a.ts'));
  });

  it('大小写不敏感匹配（Windows 路径）', () => {
    const ws = join(root, 'ws-dup-7', 'Data', 'workspaces', 'Sess-Dup7');
    ensureWorkspaceDir(ws);
    const r = resolveWithinWorkspace('data/WORKSPACES/sess-dup7/src/a.ts', ws);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(join(ws, 'src', 'a.ts'));
  });
});
