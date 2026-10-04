/**
 * FE-052：角色提示词注册表测试。
 *
 * 覆盖：真实 Prompts/roles 目录装载（8 角色）、按角色查询、未知角色降级、
 *       临时目录装载规则（仅 .md / 空文件跳过 / 重复装载幂等）、目录缺失降级、reset。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadRolePrompts, getRolePrompt, getLoadedRoles, resetRolePrompts,
} from '../../Src/Services/Prompts/promptRegistry.js';

describe('FE-052 · 角色提示词注册表', () => {
  beforeEach(() => resetRolePrompts());
  afterEach(() => resetRolePrompts());

  it('真实 Prompts/roles 装载：8 个角色全部就绪', () => {
    const count = loadRolePrompts();
    expect(count).toBe(8);
    expect(getLoadedRoles().sort()).toEqual([
      'arbitrator', 'assembly_node', 'auditor', 'partner',
      'prime_director', 'regulator', 'reviewer', 'worker',
    ]);
  });

  it('按角色查询：worker 提示词含身份约束（submitForReview / 审批门）', () => {
    loadRolePrompts();
    const worker = getRolePrompt('worker');
    expect(worker).toBeTruthy();
    expect(worker).toContain('Worker');
    expect(worker).toContain('submitForReview');
  });

  it('未知角色 → undefined；未装载时查询 → undefined（降级，不抛出）', () => {
    expect(getRolePrompt('worker')).toBeUndefined(); // 未装载
    loadRolePrompts();
    expect(getRolePrompt('nonexistent')).toBeUndefined();
  });

  it('临时目录：仅装载 .md、空文件跳过、重复装载幂等（覆盖旧值）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompts-'));
    try {
      mkdirSync(join(dir, 'roles'));
      writeFileSync(join(dir, 'roles', 'worker.md'), '# Worker\n内容A', 'utf-8');
      writeFileSync(join(dir, 'roles', 'empty.md'), '   ', 'utf-8');
      writeFileSync(join(dir, 'roles', 'notes.txt'), '非 md 文件', 'utf-8');

      expect(loadRolePrompts(dir)).toBe(1); // 只有 worker.md 有效
      expect(getRolePrompt('worker')).toContain('内容A');
      expect(getRolePrompt('empty')).toBeUndefined();

      // 幂等：再次装载覆盖旧值
      writeFileSync(join(dir, 'roles', 'worker.md'), '# Worker\n内容B', 'utf-8');
      expect(loadRolePrompts(dir)).toBe(1);
      expect(getRolePrompt('worker')).toContain('内容B');
      expect(getRolePrompt('worker')).not.toContain('内容A');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目录缺失 → 返回 0（降级，不抛）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompts-none-'));
    try {
      expect(loadRolePrompts(dir)).toBe(0); // 无 roles 子目录
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reset 清空注册表', () => {
    loadRolePrompts();
    expect(getLoadedRoles().length).toBe(8);
    resetRolePrompts();
    expect(getLoadedRoles().length).toBe(0);
  });
});
