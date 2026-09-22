/**
 * 集成测试：Agent 权限模型与工具可见性——分裂运行验证
 *
 * 三轮测试：
 * R1: prime_director 入口 → 可见工具集包含 SAFE + CONTROLLED，不含 DANGEROUS
 * R2: worker 尝试调用 agent.recruit → ROLE_FORBIDDEN
 * R3: regulator(L0) 可见全部 vs partner(L1) 仅 SAFE+CONTROLLED
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initTrustLevels, getTrustLevel, isToolAllowed } from '../../Src/Infra/Security/trustLevels.js';
import { registerBuiltinTools } from '../../Src/Tools/builtinLoader.js';
import { getVisibleToolsForRole, getVisibleToolNames } from '../../Src/Tools/Factory/toolFactory.js';
import { executeTool, clearRegistry } from '../../Src/Tools/Registry/toolRegistry.js';
import { initWhitelist } from '../../Src/Infra/Security/whitelist.js';
import { initPathGuard } from '../../Src/Infra/Security/pathGuard.js';
import { resolve } from 'node:path';

describe('Agent 权限分裂运行验证', () => {
  beforeAll(() => {
    // 初始化系统基础设施
    initTrustLevels({
      systemRoles: ['regulator', 'auditor', 'arbitrator'],
      userRoles: ['prime_director', 'partner'],
      externalRoles: ['worker', 'reviewer', 'assembly_node'],
    });
    initWhitelist({ forbiddenPaths: ['Data/Auth/'], forbiddenCommands: [] });
    initPathGuard({ projectRoot: resolve('.'), forbiddenPaths: ['Data/Auth/'] });
    clearRegistry();
    registerBuiltinTools();
  });

  // ━━━ R1: prime_director 入口级工具可见性 ━━━
  describe('R1: prime_director 入口级（L1）', () => {
    it('可见 SAFE + CONTROLLED 工具', () => {
      const visible = getVisibleToolNames({ role: 'prime_director' });

      // SAFE 工具应可见
      expect(visible).toContain('file.read');
      expect(visible).toContain('dir.list');
      expect(visible).toContain('file.grep');

      // CONTROLLED 工具应可见
      expect(visible).toContain('file.write');
      expect(visible).toContain('file.edit');

      // DANGEROUS 工具不可见
      expect(visible).not.toContain('shell.exec');
      expect(visible).not.toContain('code.eval');
    });

    it('partner 与 prime_director 工具集完全一致（同级对等）', () => {
      const pdTools = getVisibleToolNames({ role: 'prime_director' });
      const partnerTools = getVisibleToolNames({ role: 'partner' });
      expect(partnerTools.sort()).toEqual(pdTools.sort());
    });

    it('信任级别为 L1', () => {
      expect(getTrustLevel('prime_director')).toBe('L1');
      expect(getTrustLevel('partner')).toBe('L1');
    });
  });

  // ━━━ R2: worker 角色权限限制 ━━━
  describe('R2: worker 执行子级（L2）', () => {
    it('仅可见 SAFE 工具', () => {
      const visible = getVisibleToolNames({ role: 'worker' });

      // SAFE 可见
      expect(visible).toContain('file.read');
      expect(visible).toContain('dir.list');

      // CONTROLLED 不可见
      expect(visible).not.toContain('file.write');
      expect(visible).not.toContain('file.edit');

      // DANGEROUS 不可见
      expect(visible).not.toContain('shell.exec');
      expect(visible).not.toContain('code.eval');
    });

    it('executeTool 调用 agent.recruit → ROLE_FORBIDDEN', async () => {
      // agent.recruit 的 requiredRoles = ['prime_director', 'partner']
      // worker 不在白名单中，应返回 ROLE_FORBIDDEN
      const result = await executeTool('agent.recruit', { role: 'worker', model: 'test' }, {
        operationId: 'op-test-r2',
        agentId: 'agent-worker-1',
        agentRole: 'worker',
      });

      expect(result.status).toBe('error');
      expect(result.recoverable).toBe(false);
      expect(result.error?.code).toBe('ROLE_FORBIDDEN');
      expect(result.error?.message).toContain('worker');
    });

    it('executeTool 调用 file.read → 成功（worker 在 requiredRoles 中）', async () => {
      // file.read 的 requiredRoles 包含 worker
      const result = await executeTool('file.read', { path: 'package.json' }, {
        operationId: 'op-test-r2-read',
        agentId: 'agent-worker-1',
        agentRole: 'worker',
      });

      // 应该不是 ROLE_FORBIDDEN（可能成功或文件相关错误）
      if (result.status === 'error') {
        expect(result.error?.code).not.toBe('ROLE_FORBIDDEN');
      }
    });

    it('信任级别为 L2', () => {
      expect(getTrustLevel('worker')).toBe('L2');
      expect(getTrustLevel('reviewer')).toBe('L2');
      expect(getTrustLevel('assembly_node')).toBe('L2');
    });
  });

  // ━━━ R3: L0 治理级 vs L1 入口级 对比 ━━━
  describe('R3: 治理级（L0）vs 入口级（L1）', () => {
    it('regulator(L0) 可见所有非 FORBIDDEN 工具', () => {
      const visible = getVisibleToolNames({ role: 'regulator' });
      const allTools = getVisibleToolsForRole('regulator');

      // L0 应看到所有注册工具（无 FORBIDDEN 级别工具）
      expect(allTools.length).toBeGreaterThanOrEqual(11);
      expect(visible).toContain('shell.exec');    // DANGEROUS — L0 可见
      expect(visible).toContain('code.eval');      // DANGEROUS — L0 可见
      expect(visible).toContain('file.write');     // CONTROLLED — L0 可见
      expect(visible).toContain('file.read');      // SAFE — L0 可见
    });

    it('arbitrator(L0) 同样可见全部工具', () => {
      const regTools = getVisibleToolNames({ role: 'regulator' });
      const arbTools = getVisibleToolNames({ role: 'arbitrator' });
      expect(arbTools.sort()).toEqual(regTools.sort());
    });

    it('prime_director(L1) 不可见 DANGEROUS 工具', () => {
      const visible = getVisibleToolNames({ role: 'prime_director' });
      expect(visible).not.toContain('shell.exec');
      expect(visible).not.toContain('code.eval');
    });

    it('L0 可通过 isToolAllowed 使用 DANGEROUS，L1 不可', () => {
      expect(isToolAllowed('DANGEROUS', 'L0')).toBe(true);
      expect(isToolAllowed('DANGEROUS', 'L1')).toBe(false);
      expect(isToolAllowed('CONTROLLED', 'L1')).toBe(true);
      expect(isToolAllowed('CONTROLLED', 'L2')).toBe(false);
    });

    it('信任级别为 L0', () => {
      expect(getTrustLevel('regulator')).toBe('L0');
      expect(getTrustLevel('auditor')).toBe('L0');
      expect(getTrustLevel('arbitrator')).toBe('L0');
    });
  });
});
