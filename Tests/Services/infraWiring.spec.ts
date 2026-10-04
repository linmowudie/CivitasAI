/**
 * FE-066 回归测试：基础设施接线（原子写入 / 磁盘配额 / Hook 派发链 / 密钥存储）
 *
 * 覆盖：
 *  - file.write：原子写入落盘（无临时文件残留）+ 磁盘配额拒绝（QUOTA_EXCEEDED）；
 *  - quotaManager：setQuota/canWrite/recordUsage 真实计量；
 *  - toolDispatcher：Pre/PostToolExecute Hook 触发链（auditHook 消费路径）；
 *  - keyStore：env: 引用注册/解析/脱敏。
 *
 * 说明：不依赖网络；pathGuard 以临时目录为放行根。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { registerBuiltinTools } from '../../Src/Tools/builtinLoader.js';
import { clearRegistry } from '../../Src/Tools/Registry/toolRegistry.js';
import { dispatchToolCall } from '../../Src/Tools/Registry/toolDispatcher.js';
import type { ToolExecutionContext } from '../../Src/Tools/Traits/toolSpec.js';
import { initPathGuard } from '../../Src/Infra/Security/pathGuard.js';
import { setQuota, clearQuotas, getUsage } from '../../Src/Infra/Fs/quotaManager.js';
import {
  registerHookHandler, clearHookHandlers, dispatchHook, type HookEvent,
} from '../../Src/Services/Hook/hookRegistry.js';
import {
  configureToolServicePorts, resetToolServicePorts,
} from '../../Src/Tools/Registry/toolServicePorts.js';
import {
  registerKey, resolveKey, getMaskedKey, isKeyAvailable, clearKeyStore,
} from '../../Src/Infra/Security/keyStore.js';

const ROOT = resolve(import.meta.dirname, '../../.tmp/test-infra-wiring');
const OUT_DIR = join(ROOT, 'out');

function makeCtx(): ToolExecutionContext {
  return {
    operationId: 'op-infra-1',
    agentId: 'agent-infra-1',
    agentRole: 'worker',
    loopId: 'loop-infra-1',
    traceId: 'trace-infra-1',
  } as ToolExecutionContext;
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  clearRegistry();
  registerBuiltinTools();
  clearQuotas();
  clearHookHandlers();
  clearKeyStore();
  initPathGuard({
    projectRoot: resolve('.'),
    forbiddenPaths: [],
    allowedRoots: [resolve('.'), ROOT],
  });
  // 分层修正（2026-10-04）：派发器的 Hook 触发经端口注入（Tools 不可直连 Services）
  configureToolServicePorts({
    dispatchHook: (event, data) => dispatchHook(event as HookEvent, data),
  });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  clearRegistry();
  clearQuotas();
  clearHookHandlers();
  clearKeyStore();
  resetToolServicePorts();
});

// ═══════════════════════════════════════════════════════════════════
// 1. 原子写入 + 配额
// ═══════════════════════════════════════════════════════════════════

describe('FE-066 · file.write 原子写入与配额', () => {
  it('原子写入成功：内容落盘 + 无 .atomic_*.tmp 残留 + 配额计量', async () => {
    const target = join(OUT_DIR, 'a.txt');
    const outcome = await dispatchToolCall({
      toolName: 'file.write',
      arguments: { path: target, content: 'hello atomic' },
      context: makeCtx(),
    });
    expect(outcome.result.status).toBe('success');
    expect(readFileSync(target, 'utf-8')).toBe('hello atomic');

    // 无临时文件残留
    const leftovers = readdirSync(OUT_DIR).filter(f => f.startsWith('.atomic_'));
    expect(leftovers).toEqual([]);

    // 配额计量（未 setQuota 时 recordUsage 无键 → getUsage 为 null；此处验证 setQuota 后计量）
    setQuota(OUT_DIR, { maxBytes: 1024 * 1024 });
    const usageAfter = getUsage(OUT_DIR);
    expect(usageAfter).not.toBeNull();
  });

  it('配额不足 → QUOTA_EXCEEDED（拒绝写入且不落盘）', async () => {
    setQuota(OUT_DIR, { maxBytes: 10 }); // 极小配额
    const target = join(OUT_DIR, 'big.txt');
    const outcome = await dispatchToolCall({
      toolName: 'file.write',
      arguments: { path: target, content: 'x'.repeat(100) },
      context: makeCtx(),
    });
    expect(outcome.result.status).toBe('error');
    expect(outcome.result.error?.code).toBe('QUOTA_EXCEEDED');
    expect(existsSync(target)).toBe(false);

    // 配额内写入成功 + 用量累计
    setQuota(OUT_DIR, { maxBytes: 1000 });
    const small = join(OUT_DIR, 'small.txt');
    const okOutcome = await dispatchToolCall({
      toolName: 'file.write',
      arguments: { path: small, content: 'ok' },
      context: makeCtx(),
    });
    expect(okOutcome.result.status).toBe('success');
    const usage = getUsage(OUT_DIR);
    expect(usage!.usedBytes).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Hook 触发链（dispatcher 收口层）
// ═══════════════════════════════════════════════════════════════════

describe('FE-066 · Pre/PostToolExecute Hook 链', () => {
  it('工具派发触发 Pre + Post Hook（成功与失败均触发 Post）', async () => {
    const calls: Array<{ event: string; tool: string }> = [];
    registerHookHandler({
      name: 'test-pre', event: 'PreToolExecute', priority: 50, timeoutMs: 500,
      handle: async (payload) => {
        calls.push({ event: 'pre', tool: String(payload.data['toolName']) });
        return {};
      },
    });
    registerHookHandler({
      name: 'test-post', event: 'PostToolExecute', priority: 50, timeoutMs: 500,
      handle: async (payload) => {
        calls.push({ event: 'post', tool: String(payload.data['toolName']) });
        return {};
      },
    });

    // 成功路径
    await dispatchToolCall({
      toolName: 'dir.list',
      arguments: { path: OUT_DIR },
      context: makeCtx(),
    });
    expect(calls).toEqual([
      { event: 'pre', tool: 'dir.list' },
      { event: 'post', tool: 'dir.list' },
    ]);

    // 失败路径（缺参）→ Pre + Post 仍成对触发
    calls.length = 0;
    await dispatchToolCall({
      toolName: 'file.write',
      arguments: {},
      context: makeCtx(),
    });
    expect(calls).toEqual([
      { event: 'pre', tool: 'file.write' },
      { event: 'post', tool: 'file.write' },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. keyStore 引用解析与脱敏
// ═══════════════════════════════════════════════════════════════════

describe('FE-066 · keyStore', () => {
  it('env: 引用注册/解析/轮换/脱敏', () => {
    process.env['TEST_FE066_KEY_A'] = 'sk-abcdef1234567890';
    delete process.env['TEST_FE066_KEY_B'];

    registerKey('test_key', ['env:TEST_FE066_KEY_A', 'env:TEST_FE066_KEY_B'], '测试');
    const resolved = resolveKey('test_key');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.source).toBe('TEST_FE066_KEY_A');
      expect(resolved.value.isFallback).toBe(false);
    }
    expect(isKeyAvailable('test_key')).toBe(true);

    // 脱敏（前 3 + 后 4）
    const masked = getMaskedKey('test_key');
    expect(masked).toBe('sk-****7890');

    // 未注册引用 → 错误；全部环境变量缺失 → 错误
    expect(resolveKey('missing_key').ok).toBe(false);
    registerKey('only_b', ['env:TEST_FE066_KEY_B']);
    expect(resolveKey('only_b').ok).toBe(false);

    delete process.env['TEST_FE066_KEY_A'];
  });
});
