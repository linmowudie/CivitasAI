/**
 * S1-⑦ Infra/Workspace 模块测试
 *
 * 覆盖：sessionKeyGenerator / workspaceManager
 * Gate G1 要求：session_key 碰撞时自动加后缀再试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

import { generateSessionKey, isValidSessionKey } from '../../Src/Infra/Workspace/sessionKeyGenerator.js';
import { initWorkspace, createSessionWorkspace, archiveSessionWorkspace, removeSessionWorkspace, sessionWorkspaceExists, getSessionPaths, resetWorkspace } from '../../Src/Infra/Workspace/workspaceManager.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TEST_DATA_DIR = join(ROOT, 'Data', '_test_workspace');

function cleanup(): void {
  resetWorkspace();
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

describe('S1-⑦ Workspace 模块', () => {
  afterEach(() => {
    cleanup();
  });

  // ===== sessionKeyGenerator =====
  describe('sessionKeyGenerator', () => {
    it('生成 16 位十六进制 session_key', () => {
      const result = generateSessionKey();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(16);
        expect(/^[0-9a-f]{16}$/i.test(result.value)).toBe(true);
      }
    });

    it('支持自定义长度', () => {
      const result = generateSessionKey({ hexLength: 24 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(24);
      }
    });

    it('hexLength 过小返回错误', () => {
      const result = generateSessionKey({ hexLength: 4 });
      expect(result.ok).toBe(false);
    });

    it('hexLength 过大返回错误', () => {
      const result = generateSessionKey({ hexLength: 100 });
      expect(result.ok).toBe(false);
    });

    it('两次生成不同的 key', () => {
      const r1 = generateSessionKey();
      const r2 = generateSessionKey();
      expect(r1.ok && r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.value).not.toBe(r2.value);
      }
    });

    it('碰撞时自动重试（Gate G1）', () => {
      const existingKeys = new Set(['aaaaaaaaaaaaaaaa']);
      let callCount = 0;

      // 模拟第一次碰撞后成功
      const existsFn = (key: string): boolean => {
        callCount++;
        if (callCount === 1) return true; // 第一次碰撞
        return existingKeys.has(key);
      };

      const result = generateSessionKey({ existsFn });
      expect(result.ok).toBe(true);
      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it('超过最大重试次数返回错误', () => {
      // 总是返回碰撞
      const existsFn = (): boolean => true;

      const result = generateSessionKey({ existsFn, maxRetries: 3 });
      expect(result.ok).toBe(false);
    });

    it('isValidSessionKey 验证格式', () => {
      expect(isValidSessionKey('abcdef0123456789')).toBe(true);
      expect(isValidSessionKey('ABCDEF0123456789')).toBe(true);
      expect(isValidSessionKey('too-short')).toBe(false);
      expect(isValidSessionKey('zzzzzzzzzzzzzzzz')).toBe(false); // 非十六进制
      expect(isValidSessionKey('abcdef01234567890')).toBe(false); // 长度不对
    });
  });

  // ===== workspaceManager =====
  describe('workspaceManager', () => {
    beforeEach(() => {
      cleanup();
      mkdirSync(TEST_DATA_DIR, { recursive: true });
      const result = initWorkspace({ dataRoot: TEST_DATA_DIR });
      expect(result.ok).toBe(true);
    });

    it('initWorkspace 初始化成功', () => {
      const config = getSessionPaths('test');
      expect(config.ok).toBe(true);
    });

    it('getSessionPaths 返回正确路径', () => {
      const result = getSessionPaths('abc123');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessionDir).toContain('abc123');
        expect(result.value.workspaceDir).toContain('abc123');
        expect(result.value.loopsDir).toContain('abc123');
        // 验证目录结构包含 Sessions/Workspace/Loops
        expect(result.value.sessionDir).toMatch(/Sessions[/\\]abc123/);
        expect(result.value.workspaceDir).toMatch(/Workspace[/\\]abc123/);
        expect(result.value.loopsDir).toMatch(/Loops[/\\]abc123/);
      }
    });

    it('createSessionWorkspace 创建完整目录结构', () => {
      const result = createSessionWorkspace('test-session-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(existsSync(result.value.sessionDir)).toBe(true);
        expect(existsSync(result.value.workspaceDir)).toBe(true);
        expect(existsSync(result.value.loopsDir)).toBe(true);
      }
    });

    it('createSessionWorkspace 写入 meta.json', () => {
      createSessionWorkspace('test-session-2');
      const paths = getSessionPaths('test-session-2');
      if (paths.ok) {
        const metaPath = join(paths.value.sessionDir, 'meta.json');
        expect(existsSync(metaPath)).toBe(true);
      }
    });

    it('sessionWorkspaceExists 检测存在', () => {
      expect(sessionWorkspaceExists('nonexistent')).toBe(false);
      createSessionWorkspace('existing-session');
      expect(sessionWorkspaceExists('existing-session')).toBe(true);
    });

    it('archiveSessionWorkspace 标记归档', () => {
      createSessionWorkspace('archive-test');
      const result = archiveSessionWorkspace('archive-test');
      expect(result.ok).toBe(true);
      // 目录仍然存在
      expect(sessionWorkspaceExists('archive-test')).toBe(true);
    });

    it('removeSessionWorkspace 删除目录', () => {
      createSessionWorkspace('remove-test');
      expect(sessionWorkspaceExists('remove-test')).toBe(true);

      const result = removeSessionWorkspace('remove-test');
      expect(result.ok).toBe(true);
      expect(sessionWorkspaceExists('remove-test')).toBe(false);
    });

    it('未初始化时返回错误', () => {
      resetWorkspace();
      const result = getSessionPaths('test');
      // getSessionPaths 在未初始化时应返回错误
      expect(result.ok).toBe(false);
    });
  });
});
