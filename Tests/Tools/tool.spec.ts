/**
 * S4 Tools 层测试
 *
 * 覆盖：Traits / Registry / Factory / Builtin Tools / Gate G4
 *
 * Gate G4：
 * - DANGEROUS + IRREVERSIBLE 工具未声明 L4 HumanGate → CI 拒收
 * - idempotency='NO' 工具未先写 INTENT → 运行期拒绝执行
 * - 所有工具通过 Schema 严格校验（additionalProperties:false）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { validateToolSpec, validateInput } from '../../Src/Tools/Traits/specValidator.js';
import type { ToolSpec, ToolDefinition } from '../../Src/Tools/Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Src/Tools/Traits/toolSpec.js';
import {
  registerTool, registerTools, getTool, executeTool,
  getRegisteredToolNames, getAllToolSpecs, getToolCount, clearRegistry,
} from '../../Src/Tools/Registry/toolRegistry.js';
import { getVisibleTools, getVisibleToolNames } from '../../Src/Tools/Factory/toolFactory.js';
import { registerBuiltinTools, BUILTIN_TOOLS } from '../../Src/Tools/builtinLoader.js';
import { initTrustLevels } from '../../Src/Infra/Security/trustLevels.js';
import { initWhitelist } from '../../Src/Infra/Security/whitelist.js';
import { initPathGuard } from '../../Src/Infra/Security/pathGuard.js';
import { resolve } from 'node:path';

// ===== 测试用工具定义 =====

const VALID_TOOL: ToolDefinition = {
  spec: {
    name: 'test.valid',
    version: '0.1.0',
    description: '测试工具',
    inputSchema: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        recoverable: { type: 'boolean' },
        content: { type: 'object' },
      },
      required: ['status', 'recoverable'],
      additionalProperties: true,
    },
    dangerLevel: 'SAFE',
    idempotency: 'YES',
    idempotencyKeyFields: ['input'],
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'none',
    requiredRoles: ['worker'],
    sandboxMode: 'none',
    timeoutMs: 5000,
  },
  execute: async (input, ctx) => toolSuccess(ctx.operationId, { echo: input['input'] }),
};

const INVALID_TOOL_MISSING_FIELDS = {
  spec: {
    name: 'test.invalid',
    // 缺少 version, description 等
    dangerLevel: 'SAFE',
    idempotency: 'NO',
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'none',
    requiredRoles: [],
    sandboxMode: 'none',
    timeoutMs: -1,
  },
  execute: async () => toolSuccess('op1', {}),
} as unknown as ToolDefinition;

const ADDITIONAL_PROPS_TRUE_TOOL: ToolDefinition = {
  spec: {
    ...VALID_TOOL.spec,
    name: 'test.additionalProps',
    inputSchema: {
      type: 'object',
      properties: { input: { type: 'string' } },
      additionalProperties: true,
    },
  },
  execute: async (input, ctx) => toolSuccess(ctx.operationId, {}),
};

const OUTPUT_MISSING_STATUS_TOOL: ToolDefinition = {
  spec: {
    ...VALID_TOOL.spec,
    name: 'test.noStatus',
    outputSchema: {
      type: 'object',
      properties: { recoverable: { type: 'boolean' } },
      required: ['recoverable'],
    },
  },
  execute: async (input, ctx) => toolSuccess(ctx.operationId, {}),
};

const IDEMPOTENCY_NO_NOKEYS_TOOL: ToolDefinition = {
  spec: {
    ...VALID_TOOL.spec,
    name: 'test.idemNoKeys',
    idempotency: 'CONDITIONAL',
    idempotencyKeyFields: undefined, // 显式清除继承的 keyFields
  },
  execute: async (input, ctx) => toolSuccess(ctx.operationId, {}),
};

describe('S4 Tools 层', () => {
  beforeEach(() => {
    clearRegistry();
    initTrustLevels({});
    initWhitelist({ forbiddenPaths: ['Data/Auth/'], forbiddenCommands: ['rm -rf'] });
    initPathGuard({ projectRoot: resolve('.'), forbiddenPaths: ['Data/Auth/'] });
  });

  // ===== specValidator =====
  describe('specValidator', () => {
    it('合法 ToolSpec 通过验证', () => {
      const result = validateToolSpec(VALID_TOOL.spec);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('缺少必填字段时验证失败', () => {
      const result = validateToolSpec(INVALID_TOOL_MISSING_FIELDS.spec);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('additionalProperties:true 被拒', () => {
      const result = validateToolSpec(ADDITIONAL_PROPS_TRUE_TOOL.spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('additionalProperties'))).toBe(true);
    });

    it('outputSchema 缺 status 被拒', () => {
      const result = validateToolSpec(OUTPUT_MISSING_STATUS_TOOL.spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('status'))).toBe(true);
    });

    it('idempotency!=NO 但缺 idempotencyKeyFields 被拒', () => {
      const result = validateToolSpec(IDEMPOTENCY_NO_NOKEYS_TOOL.spec);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('idempotencyKeyFields'))).toBe(true);
    });

    it('FORBIDDEN 级别不允许注册', () => {
      const forbiddenSpec: ToolSpec = {
        ...VALID_TOOL.spec,
        name: 'test.forbidden',
        dangerLevel: 'FORBIDDEN',
      };
      const result = validateToolSpec(forbiddenSpec);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('FORBIDDEN'))).toBe(true);
    });

    it('validateInput 检查必填参数', () => {
      const result = validateInput(
        {},
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('name'))).toBe(true);
    });

    it('validateInput 拒绝额外参数', () => {
      const result = validateInput(
        { name: 'test', extra: 'bad' },
        { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('extra'))).toBe(true);
    });
  });

  // ===== Registry =====
  describe('Registry', () => {
    it('注册合法工具成功', () => {
      const result = registerTool(VALID_TOOL);
      expect(result.ok).toBe(true);
      expect(getToolCount()).toBe(1);
    });

    it('注册非法工具失败', () => {
      const result = registerTool(INVALID_TOOL_MISSING_FIELDS);
      expect(result.ok).toBe(false);
    });

    it('重复注册被拒', () => {
      registerTool(VALID_TOOL);
      const result = registerTool(VALID_TOOL);
      expect(result.ok).toBe(false);
    });

    it('批量注册返回成功数量', () => {
      const result = registerTools([VALID_TOOL, INVALID_TOOL_MISSING_FIELDS]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1); // 只有 VALID_TOOL 成功
      }
    });

    it('getRegisteredToolNames 返回已注册工具名', () => {
      registerTool(VALID_TOOL);
      const names = getRegisteredToolNames();
      expect(names).toContain('test.valid');
    });
  });

  // ===== Builtin Tools =====
  describe('Builtin Tools', () => {
    it('所有内置工具通过 Schema 验证', () => {
      for (const tool of BUILTIN_TOOLS) {
        const result = validateToolSpec(tool.spec);
        expect(result.valid, `${tool.spec.name}: ${result.errors.join(', ')}`).toBe(true);
      }
    });

    it('registerBuiltinTools 注册 11 个工具', () => {
      const result = registerBuiltinTools();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(11);
      }
    });

    it('所有内置工具 inputSchema 的 additionalProperties 为 false', () => {
      for (const tool of BUILTIN_TOOLS) {
        expect(tool.spec.inputSchema.additionalProperties, `${tool.spec.name} 允许额外属性`).toBe(false);
      }
    });

    it('所有内置工具 outputSchema 包含 status + recoverable', () => {
      for (const tool of BUILTIN_TOOLS) {
        const props = tool.spec.outputSchema.properties ?? {};
        expect(props, `${tool.spec.name} 缺 status`).toHaveProperty('status');
        expect(props, `${tool.spec.name} 缺 recoverable`).toHaveProperty('recoverable');
      }
    });

    it('DANGEROUS + IRREVERSIBLE 工具存在（shell.exec, code.eval, agent.recruit）', () => {
      const dangerousIrreversible = BUILTIN_TOOLS.filter(
        t => t.spec.dangerLevel === 'DANGEROUS' && t.spec.reversibility === 'IRREVERSIBLE',
      );
      expect(dangerousIrreversible.length).toBeGreaterThanOrEqual(2);
      const names = dangerousIrreversible.map(t => t.spec.name);
      expect(names).toContain('shell.exec');
    });

    it('idempotency=NO 的工具没有 idempotencyKeyFields', () => {
      const noIdem = BUILTIN_TOOLS.filter(t => t.spec.idempotency === 'NO');
      for (const tool of noIdem) {
        expect(tool.spec.idempotencyKeyFields).toBeUndefined();
      }
    });
  });

  // ===== Factory =====
  describe('Factory', () => {
    beforeEach(() => { registerBuiltinTools(); });

    it('L0 角色（prime_director）可见所有非 FORBIDDEN 工具', () => {
      const visible = getVisibleToolNames({ role: 'prime_director' });
      expect(visible.length).toBe(11); // 全部可见
    });

    it('L1 角色（worker）可见 SAFE + CONTROLLED', () => {
      const visible = getVisibleToolNames({ role: 'worker' });
      expect(visible).toContain('file.read');   // SAFE
      expect(visible).toContain('file.write');  // CONTROLLED
      expect(visible).not.toContain('shell.exec'); // DANGEROUS
    });

    it('excludedTools 强制排除', () => {
      const visible = getVisibleToolNames({ role: 'prime_director', excludedTools: ['shell.exec'] });
      expect(visible).not.toContain('shell.exec');
    });
  });

  // ===== 工具执行 =====
  describe('工具执行', () => {
    it('file.read 读取存在的文件', async () => {
      registerBuiltinTools();
      const testFile = join('Data', '_test_read.txt');
      writeFileSync(testFile, 'hello world');

      try {
        const result = await executeTool('file.read', { path: testFile }, {
          operationId: 'op1', agentId: 'agent1', agentRole: 'worker',
        });
        expect(result.status).toBe('success');
        if (result.status === 'success') {
          expect((result.content as { content: string }).content).toBe('hello world');
        }
      } finally {
        rmSync(testFile, { force: true });
      }
    });

    it('file.write 写入文件并返回产物', async () => {
      registerBuiltinTools();
      const testFile = join('Data', '_test_write.txt');

      try {
        const result = await executeTool('file.write', { path: testFile, content: 'test content' }, {
          operationId: 'op2', agentId: 'agent1', agentRole: 'worker',
        });
        expect(result.status).toBe('success');
        expect(result.effects).toContain(`file.write:${testFile}`);
        expect(existsSync(testFile)).toBe(true);
      } finally {
        rmSync(testFile, { force: true });
      }
    });

    it('code.eval 执行简单代码', async () => {
      registerBuiltinTools();
      const result = await executeTool('code.eval', { code: '1 + 2' }, {
        operationId: 'op3', agentId: 'agent1', agentRole: 'worker',
      });
      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect((result.content as { result: string }).result).toBe('3');
      }
    });

    it('未注册工具返回 TOOL_NOT_FOUND', async () => {
      const result = await executeTool('nonexistent.tool', {}, {
        operationId: 'op4', agentId: 'agent1', agentRole: 'worker',
      });
      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('TOOL_NOT_FOUND');
    });

    it('shell.exec 执行禁止命令被拒', async () => {
      registerBuiltinTools();
      const result = await executeTool('shell.exec', { command: 'rm -rf /' }, {
        operationId: 'op5', agentId: 'agent1', agentRole: 'worker',
      });
      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('COMMAND_FORBIDDEN');
    });
  });

  // ===== Gate G4 =====
  describe('Gate G4', () => {
    it('所有工具通过 Schema 严格校验', () => {
      registerBuiltinTools();
      const specs = getAllToolSpecs();
      expect(specs.length).toBe(11);

      for (const spec of specs) {
        const validation = validateToolSpec(spec);
        expect(validation.valid, `${spec.name}: ${validation.errors.join(', ')}`).toBe(true);
      }
    });

    it('DANGEROUS + IRREVERSIBLE 工具标记正确', () => {
      for (const tool of BUILTIN_TOOLS) {
        if (tool.spec.dangerLevel === 'DANGEROUS' && tool.spec.reversibility === 'IRREVERSIBLE') {
          // 这些工具在 S6 必须挂 L4 HumanGate
          expect(['shell.exec', 'code.eval', 'agent.recruit']).toContain(tool.spec.name);
        }
      }
    });

    it('idempotency=NO 的工具 sideEffectScope != none', () => {
      for (const tool of BUILTIN_TOOLS) {
        if (tool.spec.idempotency === 'NO') {
          expect(tool.spec.sideEffectScope).not.toBe('none');
        }
      }
    });
  });
});
