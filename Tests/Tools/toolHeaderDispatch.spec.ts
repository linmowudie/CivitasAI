/**
 * 工具头部冻结 + 追加式工具 + 统一派发（核心机制测试）。
 *
 * 背景（设计依据：MongoTerminalAgent v2.0）：
 *  OpenAI 兼容接口把 `tools` 放在**所有 messages 之前** → 头部集合/顺序一变，
 *  从该点起的前缀缓存全部失效。因此：
 *   ① 头部只放**热工具 + 元工具**（默认 ~10 个），会话内字节恒定；
 *   ② 其余工具靠 `tool.search` **探索**（schema 作为工具结果追加到上下文，不进头部）；
 *   ③ 执行走 `tool.execute` → **统一派发器**按名字执行任意已注册工具。
 *
 * 本测试锁定这四条性质，防止有人"顺手"把全量工具塞回头部。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerBuiltinTools, BUILTIN_TOOLS } from '../../Src/Tools/builtinLoader.js';
import {
  buildToolHeader, listDiscoverableSpecs, searchToolSpecs, DEFAULT_HOT_TOOLS, META_TOOLS,
} from '../../Src/Tools/Registry/toolHeader.js';
import { dispatchToolCall, normalizeToolContent } from '../../Src/Tools/Registry/toolDispatcher.js';
import { getTool } from '../../Src/Tools/Registry/toolRegistry.js';
import type { UserRole } from '../../Src/Infra/types.js';

const ROLE: UserRole = 'prime_director';

beforeEach(() => {
  registerBuiltinTools();
});

describe('工具头部冻结 + 追加式工具', () => {
  it('① 头部只含热工具 + 元工具（不随注册表增长而膨胀）', () => {
    const header = buildToolHeader(ROLE).map(s => s.name);
    // 头部规模受限（当前热工具集 ~10 个），远小于全部内置工具
    expect(header.length).toBeLessThanOrEqual(DEFAULT_HOT_TOOLS.length + META_TOOLS.length);
    expect(header.length).toBeLessThan(BUILTIN_TOOLS.length);
    // 元工具必须在头部（保证"探索→执行"闭环）
    for (const m of META_TOOLS) expect(header).toContain(m);
    // 未在热清单中的工具不应出现在头部
    const discoverable = listDiscoverableSpecs(ROLE).map(s => s.name);
    for (const n of discoverable) expect(header).not.toContain(n);
    // 头部 + 可发现 = 全部（角色可见范围内无遗漏）
    const visibleAll = BUILTIN_TOOLS
      .map(t => t.spec)
      .filter(s => s.requiredRoles.includes(ROLE))
      .map(s => s.name);
    expect([...header, ...discoverable].sort()).toEqual(visibleAll.sort());
  });

  it('② 头部字节稳定：与调用次数、注册顺序无关（前缀缓存前提）', () => {
    const a = buildToolHeader(ROLE).map(s => s.name);
    const b = buildToolHeader(ROLE).map(s => s.name);
    expect(a).toEqual(b);
    // 排序确定（升序）
    expect(a).toEqual([...a].sort((x, y) => x.localeCompare(y)));
  });

  it('③ 探索：按名称/类别/描述检索，返回参数结构且标记是否已在头部', () => {
    const byName = searchToolSpecs('file.write', ROLE);
    expect(byName[0]?.name).toBe('file.write');
    expect(byName[0]?.inHeader).toBe(true); // file.write 是热工具
    expect(byName[0]?.parameters).toBeTruthy();

    const byCategory = searchToolSpecs('file', ROLE);
    expect(byCategory.some(t => t.name.startsWith('file.'))).toBe(true);

    // 非热工具应被标记为 inHeader=false（需经 tool.execute 执行）
    const discoverable = listDiscoverableSpecs(ROLE);
    if (discoverable.length > 0) {
      const target = discoverable[0]!.name;
      const found = searchToolSpecs(target, ROLE).find(t => t.name === target);
      expect(found?.inHeader).toBe(false);
    }
  });

  it('④ 统一派发器：可执行**不在头部**的工具（"探索到即可用"）', async () => {
    const discoverable = listDiscoverableSpecs(ROLE);
    expect(discoverable.length).toBeGreaterThan(0);
    // 选一个 SAFE/CONTROLLED 的可发现工具做实测
    const target = discoverable.find(s => s.dangerLevel === 'SAFE') ?? discoverable[0]!;
    expect(target).toBeTruthy();
    expect(buildToolHeader(ROLE).some(s => s.name === target.name)).toBe(false);

    // 经派发器直接执行（模拟 tool.execute 内部调用）
    const outcome = await dispatchToolCall({
      toolName: target.name,
      arguments: target.name === 'dir.list' ? { path: '.' } : {},
      context: {
        operationId: 'op-dispatch-test',
        agentId: 'agent-test',
        agentRole: ROLE,
      } as never,
    });
    // 无论成功或参数错误，都必须是"被派发到了"（而不是 TOOL_NOT_FOUND / 未注册）
    expect(outcome.result.error?.code).not.toBe('TOOL_NOT_FOUND');
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof normalizeToolContent(outcome.result.content)).toBe('string');
  });

  it('⑤ 安全边界：DANGEROUS 工具不得经 tool.execute 借壳执行', async () => {
    const executor = getTool('tool.execute');
    expect(executor).toBeTruthy();
    const dangerous = BUILTIN_TOOLS
      .map(t => t.spec)
      .find(s => s.dangerLevel === 'DANGEROUS' && s.name !== 'tool.execute');
    expect(dangerous).toBeTruthy();

    const res = await executor!.execute(
      { name: dangerous!.name, arguments: {} },
      { operationId: 'op-x', agentId: 'a', agentRole: ROLE } as never,
    );
    expect(res.status).toBe('error');
    expect(res.error?.code).toBe('ROLE_FORBIDDEN');
    expect(res.error?.message).toContain('DANGEROUS');
  });

  it('⑥ tool.execute 拒绝递归调用自身', async () => {
    const executor = getTool('tool.execute')!;
    const res = await executor.execute(
      { name: 'tool.execute', arguments: {} },
      { operationId: 'op-y', agentId: 'a', agentRole: ROLE } as never,
    );
    expect(res.status).toBe('error');
    expect(res.error?.message).toContain('递归');
  });

  it('⑦ 派发器错误分类：未注册/角色禁止/执行失败可区分', async () => {
    const notFound = await dispatchToolCall({
      toolName: 'no.such.tool', arguments: {},
      context: { operationId: 'op-1', agentId: 'a', agentRole: ROLE } as never,
    });
    expect(notFound.result.error?.code).toBe('TOOL_NOT_FOUND');
    expect(notFound.errorClass).toBe('DISPATCH_REJECTED');

    const forbidden = await dispatchToolCall({
      toolName: 'shell.exec', arguments: { command: 'echo x' },
      context: { operationId: 'op-2', agentId: 'a', agentRole: 'reviewer' } as never,
    });
    // reviewer 是否可见 shell.exec 取决于角色矩阵；若可见则不是这条断言的目标
    if (forbidden.result.status === 'error') {
      expect(['ROLE_FORBIDDEN', 'INVALID_INPUT', 'PATH_DENIED', 'INTERNAL']).toContain(forbidden.result.error?.code);
      expect(forbidden.errorClass).toBeTruthy();
    }
  });

  it('⑧ 结果归一：对象 → JSON、null/undefined → 空串', () => {
    expect(normalizeToolContent({ a: 1 })).toBe('{"a":1}');
    expect(normalizeToolContent('x')).toBe('x');
    expect(normalizeToolContent(null)).toBe('');
    expect(normalizeToolContent(undefined)).toBe('');
  });
});
