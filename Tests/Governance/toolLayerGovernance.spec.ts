/**
 * G-08 验收：工具层治理动作核查（2026-10-04）
 *
 * 四条不变量（对齐产品规则"治理层只由 L0 承担，L1/L2 只做事"）：
 *  1. **不存在对 L1/L2 开放的治理类工具**（冻结/处罚/裁决/规则/封禁…）；
 *  2. **治理角色必须能观察**（只读/检索类工具不得把 L0 排除在外）；
 *  3. **无越权借壳**：`tool.execute` 必须用**调用者角色**复核内层工具，且禁止 DANGEROUS 借壳；
 *  4. **注册期校验闭合**（FE-048）：治理名模式工具的 requiredRoles 不得泄漏 L1/L2；
 *     `agent.*` 编排工具 requiredRoles 必须 ⊆ `ORCHESTRATOR_ROLES`。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { registerBuiltinTools, BUILTIN_TOOLS } from '../../Src/Tools/builtinLoader.js';
import { READ_ROLES, TOOL_GOVERNANCE_ROLES, TOOL_EXECUTION_ROLES, GOVERNANCE_TOOL_NAME_PATTERN } from '../../Src/Tools/roles.js';
import { validateToolSpec } from '../../Src/Tools/Traits/specValidator.js';
import { registerTool } from '../../Src/Tools/Registry/toolRegistry.js';
import type { ToolSpec } from '../../Src/Tools/Traits/toolSpec.js';
import type { UserRole } from '../../Src/Infra/types.js';

function specs() {
  registerBuiltinTools();
  return BUILTIN_TOOLS.map(t => (t as { spec: { name: string; requiredRoles: readonly string[]; dangerLevel: string } }).spec);
}

/** FE-048 测试夹具：可注册的最小合法 ToolSpec */
function makeSpec(overrides: Partial<ToolSpec>): ToolSpec {
  return {
    name: 'test.base',
    version: '0.1.0',
    description: '测试用 ToolSpec',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, recoverable: { type: 'boolean' } },
    },
    dangerLevel: 'SAFE',
    idempotency: 'YES',
    idempotencyKeyFields: ['id'],
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'none',
    requiredRoles: ['prime_director'],
    sandboxMode: 'none',
    timeoutMs: 1000,
    ...overrides,
  } as ToolSpec;
}

describe('G-08 工具层治理动作核查', () => {
  beforeEach(() => registerBuiltinTools());

  it('★ 不存在对 L1/L2 开放的治理类工具（冻结/处罚/裁决/规则/封禁）', () => {
    const govTools = specs().filter(s => GOVERNANCE_TOOL_NAME_PATTERN.test(s.name));
    for (const t of govTools) {
      const leaked = t.requiredRoles.filter(r => (TOOL_EXECUTION_ROLES as readonly string[]).includes(r));
      expect(leaked, `治理工具 ${t.name} 对执行层开放了: ${leaked.join(',')}`).toEqual([]);
    }
    // 当前工具集里没有治理类工具（治理动作走 Services，不经工具层）
    expect(govTools.map(t => t.name)).toEqual([]);
  });

  it('★ 治理角色必须能观察：只读/检索类工具不得排除 L0', () => {
    const readTools = ['file.read', 'dir.list', 'file.grep', 'tool.search', 'todo.write', 'web.search', 'vector.search'];
    for (const name of readTools) {
      const spec = specs().find(s => s.name === name);
      expect(spec, `缺少工具 ${name}`).toBeTruthy();
      for (const role of TOOL_GOVERNANCE_ROLES) {
        expect(spec!.requiredRoles, `${name} 未包含治理角色 ${role}`).toContain(role);
      }
    }
  });

  it('★ 治理层不执行危险副作用：DANGEROUS 工具不含 auditor / regulator', () => {
    const dangerous = specs().filter(s => s.dangerLevel === 'DANGEROUS');
    expect(dangerous.length).toBeGreaterThan(0);
    for (const t of dangerous) {
      expect(t.requiredRoles, `${t.name} 不应允许审计/监管直接执行`).not.toContain('auditor');
      expect(t.requiredRoles, `${t.name} 不应允许监管直接执行`).not.toContain('regulator');
    }
  });

  it('只读角色集合与实际工具白名单口径一致（READ_ROLES 含全部治理角色与执行层）', () => {
    for (const role of [...TOOL_GOVERNANCE_ROLES, ...TOOL_EXECUTION_ROLES]) {
      expect(READ_ROLES as readonly string[]).toContain(role);
    }
  });

  it('★ 无越权借壳：tool.execute 的类型契约要求按调用者角色复核', () => {
    // 静态契约：tool.execute 声明为 CONTROLLED，且其实现按 context.agentRole 校验内层工具
    const execSpec = specs().find(s => s.name === 'tool.execute');
    expect(execSpec?.dangerLevel).toBe('CONTROLLED');
    // 行为验证（配合 Tests/Tools/toolHeaderDispatch.spec.ts 的 ROLE_FORBIDDEN 用例）
    expect(execSpec!.requiredRoles as readonly string[]).not.toContain('auditor');
  });

  it('执行域词表校验：工具层角色必须是合法 UserRole', () => {
    const valid: readonly string[] = [
      'prime_director', 'partner', 'regulator', 'auditor', 'arbitrator', 'worker', 'reviewer', 'assembly_node',
    ];
    for (const t of specs()) {
      for (const role of t.requiredRoles) {
        expect(valid, `${t.name} 含非法角色 ${role}`).toContain(role as UserRole);
      }
    }
  });

  // ── FE-048：悬空常量接入注册期校验（GOVERNANCE_TOOL_ROLES / ORCHESTRATOR_ROLES） ──

  it('★ 注册期校验（FE-048）：治理名模式工具的 requiredRoles 泄漏 L1/L2 → 拒注', () => {
    const okGov = makeSpec({ name: 'governance.freeze_agent', requiredRoles: ['regulator'] });
    expect(validateToolSpec(okGov).valid).toBe(true);

    const leaked = makeSpec({ name: 'governance.freeze_agent', requiredRoles: ['regulator', 'worker'] });
    const r = validateToolSpec(leaked);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('非 L0 角色'))).toBe(true);

    // 注册链闭合：registerTool 经同一验证器 → 同样拒绝
    const res = registerTool({
      spec: leaked,
      execute: async () => ({ role: 'tool', tool_call_id: 't', status: 'ok', recoverable: true }),
    });
    expect(res.ok).toBe(false);
  });

  it('★ 注册期校验（FE-048）：agent.* 编排工具 requiredRoles 越出 ORCHESTRATOR_ROLES → 拒注', () => {
    const okAgent = makeSpec({ name: 'agent.delegate_task', requiredRoles: ['prime_director', 'worker'] });
    expect(validateToolSpec(okAgent).valid).toBe(true);

    const bad = makeSpec({ name: 'agent.delegate_task', requiredRoles: ['regulator'] });
    const r = validateToolSpec(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('非编排角色'))).toBe(true);
  });
});
