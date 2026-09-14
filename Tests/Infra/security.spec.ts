/**
 * S1-④ Infra/Security 模块测试
 *
 * 覆盖：trustLevels / keyStore / whitelist / pathGuard
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';

import {
  initTrustLevels, getTrustLevel, hasTrustLevel, getTrustLevelInfo,
  isToolAllowed, isValidDangerLevel, isTrustLevelsInitialized,
  getAllRoleTrustLevels,
} from '../../Src/Infra/Security/trustLevels.js';

import {
  registerKey, resolveKey, isKeyAvailable, getMaskedKey,
  resolveSingleRef, isKeyRef, clearKeyStore, scanAndRegisterRefs,
  getRegisteredKeyNames,
} from '../../Src/Infra/Security/keyStore.js';

import {
  initWhitelist, registerTool, isToolRegistered, isToolAllowedForRole,
  isPathForbidden, isCommandForbidden, isNetworkAllowed,
  getRegisteredToolNames, getToolsByDangerLevel, clearWhitelist,
} from '../../Src/Infra/Security/whitelist.js';

import {
  initPathGuard, checkPath, safeResolve, resetPathGuard,
  addForbiddenPath, getProjectRoot, onPathAccess,
} from '../../Src/Infra/Security/pathGuard.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('S1-④ Security 模块', () => {
  // ===== trustLevels =====
  describe('trustLevels', () => {
    beforeEach(() => {
      initTrustLevels({
        systemRoles: ['prime_director', 'arbitrator', 'regulator', 'auditor'],
        userRoles: ['partner', 'worker', 'assembly_node', 'reviewer'],
      });
    });

    it('系统角色为 L0', () => {
      expect(getTrustLevel('prime_director')).toBe('L0');
      expect(getTrustLevel('arbitrator')).toBe('L0');
      expect(getTrustLevel('regulator')).toBe('L0');
      expect(getTrustLevel('auditor')).toBe('L0');
    });

    it('用户角色为 L1', () => {
      expect(getTrustLevel('partner')).toBe('L1');
      expect(getTrustLevel('worker')).toBe('L1');
      expect(getTrustLevel('assembly_node')).toBe('L1');
      expect(getTrustLevel('reviewer')).toBe('L1');
    });

    it('未知角色默认 L2', () => {
      expect(getTrustLevel('unknown')).toBe('L2');
      expect(getTrustLevel('external_input')).toBe('L2');
    });

    it('hasTrustLevel 层级判定', () => {
      expect(hasTrustLevel('prime_director', 'L0')).toBe(true);
      expect(hasTrustLevel('prime_director', 'L1')).toBe(true); // L0 >= L1
      expect(hasTrustLevel('worker', 'L1')).toBe(true);
      expect(hasTrustLevel('worker', 'L0')).toBe(false); // L1 < L0
      expect(hasTrustLevel('unknown', 'L2')).toBe(true);
      expect(hasTrustLevel('unknown', 'L1')).toBe(false); // L2 < L1
    });

    it('getTrustLevelInfo 返回详细信息', () => {
      const info = getTrustLevelInfo('L0');
      expect(info.canModifyConfig).toBe(true);
      expect(info.canManageAgents).toBe(true);
    });

    it('isToolAllowed 信任级别与工具危险级别交叉判定', () => {
      expect(isToolAllowed('SAFE', 'L2')).toBe(true);
      expect(isToolAllowed('CONTROLLED', 'L2')).toBe(false);
      expect(isToolAllowed('CONTROLLED', 'L1')).toBe(true);
      expect(isToolAllowed('DANGEROUS', 'L1')).toBe(false);
      expect(isToolAllowed('DANGEROUS', 'L0')).toBe(true);
      expect(isToolAllowed('FORBIDDEN', 'L0')).toBe(false); // FORBIDDEN 永远不允许
    });

    it('isValidDangerLevel 验证', () => {
      expect(isValidDangerLevel('SAFE')).toBe(true);
      expect(isValidDangerLevel('DANGEROUS')).toBe(true);
      expect(isValidDangerLevel('INVALID')).toBe(false);
    });

    it('getAllRoleTrustLevels 返回所有角色', () => {
      const all = getAllRoleTrustLevels();
      expect(all.size).toBe(8);
    });
  });

  // ===== keyStore =====
  describe('keyStore', () => {
    beforeEach(() => {
      clearKeyStore();
    });

    it('注册并解析 env: 引用', () => {
      process.env['TEST_API_KEY'] = 'test-key-12345';
      registerKey('test_key', ['env:TEST_API_KEY']);

      const result = resolveKey('test_key');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.keyValue).toBe('test-key-12345');
        expect(result.value.source).toBe('TEST_API_KEY');
        expect(result.value.isFallback).toBe(false);
      }

      delete process.env['TEST_API_KEY'];
    });

    it('密钥轮换：主键不可用时使用 fallback', () => {
      process.env['FALLBACK_KEY'] = 'fallback-value';
      registerKey('rotated_key', ['env:MISSING_KEY', 'env:FALLBACK_KEY']);

      const result = resolveKey('rotated_key');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.keyValue).toBe('fallback-value');
        expect(result.value.isFallback).toBe(true);
      }

      delete process.env['FALLBACK_KEY'];
    });

    it('所有密钥都不可用时返回错误', () => {
      registerKey('missing_key', ['env:NONEXISTENT']);
      const result = resolveKey('missing_key');
      expect(result.ok).toBe(false);
    });

    it('未注册的密钥返回错误', () => {
      const result = resolveKey('not_registered');
      expect(result.ok).toBe(false);
    });

    it('getMaskedKey 脱敏', () => {
      process.env['MASK_TEST'] = 'sk-abcdefgh1234';
      registerKey('mask_key', ['env:MASK_TEST']);
      expect(getMaskedKey('mask_key')).toBe('sk-****1234');
      delete process.env['MASK_TEST'];
    });

    it('isKeyRef 检测', () => {
      expect(isKeyRef('env:OPENAI_API_KEY')).toBe(true);
      expect(isKeyRef('plain_text')).toBe(false);
    });

    it('resolveSingleRef 格式验证', () => {
      const result = resolveSingleRef('invalid_format');
      expect(result.ok).toBe(false);
    });

    it('scanAndRegisterRefs 自动扫描', () => {
      process.env['SCANNED_KEY'] = 'scanned-value';
      scanAndRegisterRefs({
        providers: [{ api_key_ref: 'env:SCANNED_KEY' }],
      });

      const names = getRegisteredKeyNames();
      expect(names.length).toBeGreaterThan(0);

      delete process.env['SCANNED_KEY'];
    });
  });

  // ===== whitelist =====
  describe('whitelist', () => {
    beforeEach(() => {
      clearWhitelist();
      initWhitelist({
        forbiddenPaths: ['Data/Auth/', '~/.ssh/'],
        forbiddenCommands: ['rm -rf /'],
        networkWhitelist: ['api.openai.com'],
      });
    });

    it('注册工具（FORBIDDEN 拒绝注册）', () => {
      expect(registerTool({ name: 'read_file', dangerLevel: 'SAFE', idempotent: true, reversible: true })).toBe(true);
      expect(registerTool({ name: 'delete_system', dangerLevel: 'FORBIDDEN', idempotent: false, reversible: false })).toBe(false);
      expect(isToolRegistered('read_file')).toBe(true);
      expect(isToolRegistered('delete_system')).toBe(false);
    });

    it('isToolAllowedForRole 最小权限', () => {
      expect(isToolAllowedForRole('read_file', ['read_file', 'write_file'])).toBe(true);
      expect(isToolAllowedForRole('execute', ['read_file'])).toBe(false);
    });

    it('isPathForbidden 禁止路径', () => {
      expect(isPathForbidden('Data/Auth/secret')).toBe(true);
      expect(isPathForbidden('Data/Sessions/test')).toBe(false);
    });

    it('isCommandForbidden 禁止命令', () => {
      expect(isCommandForbidden('rm -rf / --no-preserve-root')).toBe(true);
      expect(isCommandForbidden('ls -la')).toBe(false);
    });

    it('isNetworkAllowed 网络白名单', () => {
      expect(isNetworkAllowed('api.openai.com')).toBe(true);
      expect(isNetworkAllowed('evil.com')).toBe(false);
    });

    it('空白名单 = 全部禁止', () => {
      clearWhitelist();
      initWhitelist({ networkWhitelist: [] });
      expect(isNetworkAllowed('any.com')).toBe(false);
    });

    it('getToolsByDangerLevel 按级别过滤', () => {
      registerTool({ name: 'safe_tool', dangerLevel: 'SAFE', idempotent: true, reversible: true });
      registerTool({ name: 'danger_tool', dangerLevel: 'DANGEROUS', idempotent: false, reversible: false });

      expect(getToolsByDangerLevel('SAFE').length).toBe(1);
      expect(getToolsByDangerLevel('DANGEROUS').length).toBe(1);
    });
  });

  // ===== pathGuard =====
  describe('pathGuard', () => {
    beforeEach(() => {
      resetPathGuard();
      initPathGuard({
        projectRoot: ROOT,
        forbiddenPaths: ['Data/Auth/', 'Secrets/'],
      });
    });

    afterEach(() => {
      resetPathGuard();
    });

    it('正常路径允许访问', () => {
      const result = checkPath('Data/Sessions/test');
      expect(result.allowed).toBe(true);
      expect(result.resolvedPath).toBeTruthy();
    });

    it('禁止路径被拒绝', () => {
      const result = checkPath('Data/Auth/secret');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('禁止路径');
    });

    it('safeResolve 返回绝对路径或错误', () => {
      const okResult = safeResolve('Data/Sessions/test');
      expect(okResult.ok).toBe(true);

      const errResult = safeResolve('Data/Auth/secret');
      expect(errResult.ok).toBe(false);
    });

    it('动态添加禁止路径', () => {
      addForbiddenPath('Data/Temp/');
      const result = checkPath('Data/Temp/file');
      expect(result.allowed).toBe(false);
    });

    it('getProjectRoot 返回根目录', () => {
      expect(getProjectRoot()).toBe(ROOT);
    });

    it('路径访问回调被触发', () => {
      const events: Array<{ path: string; allowed: boolean }> = [];
      // resetPathGuard 会清除回调，需要重新初始化
      resetPathGuard();
      initPathGuard({
        projectRoot: ROOT,
        forbiddenPaths: ['Data/Auth/'],
      });

      onPathAccess((e: { path: string; allowed: boolean }) => events.push(e));

      checkPath('Data/Auth/secret');
      expect(events.length).toBe(1);
      expect(events[0].allowed).toBe(false);
    });
  });
});
