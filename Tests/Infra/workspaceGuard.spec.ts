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
});
