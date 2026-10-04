/**
 * FE-054：ContextStore 写侧（文件工作集）测试。
 *
 * 覆盖：file.read 成功结果写入（键 = file:<path>）、同文件原位替换（位置稳定）、
 *       同键同内容跳过、非文件工具 / 无 path / 空内容 / 无 store 一律跳过、
 *       超长截断、toAppendMessages 前缀格式。
 */
import { describe, it, expect } from 'vitest';

import {
  ContextStore, recordFileWorkSet, WORK_SET_MAX_CHARS,
} from '../../Src/Services/Context/contextStore.js';

describe('FE-054 · ContextStore 写侧（文件工作集）', () => {
  it('file.read 成功结果写入：键 = file:<path>，内容可读回', () => {
    const store = new ContextStore();
    const changed = recordFileWorkSet(store, 'file.read', { path: 'Src/main.ts' }, 'export {}');
    expect(changed).toBe(true);
    expect(store.keys()).toEqual(['file:Src/main.ts']);
    expect(store.get('file:Src/main.ts')?.content).toBe('export {}');
  });

  it('同一文件二次读取（内容变化）→ 原位替换且位置不变', () => {
    const store = new ContextStore();
    recordFileWorkSet(store, 'file.read', { path: 'a.ts' }, 'v1');
    recordFileWorkSet(store, 'file.read', { path: 'b.ts' }, 'b 的内容');
    const changed = recordFileWorkSet(store, 'file.read', { path: 'a.ts' }, 'v2');
    expect(changed).toBe(true);
    expect(store.keys()).toEqual(['file:a.ts', 'file:b.ts']); // a.ts 仍为第 1（原位替换）
    expect(store.get('file:a.ts')?.content).toBe('v2');
  });

  it('同键同内容 → skip（返回 false，不重复入列）', () => {
    const store = new ContextStore();
    recordFileWorkSet(store, 'file.read', { path: 'a.ts' }, 'same');
    expect(recordFileWorkSet(store, 'file.read', { path: 'a.ts' }, 'same')).toBe(false);
    expect(store.size).toBe(1);
  });

  it('非文件工具 / 无 path / 空内容 / 无 store → 一律跳过', () => {
    const store = new ContextStore();
    expect(recordFileWorkSet(store, 'shell.exec', { cmd: 'ls' }, 'output')).toBe(false);
    expect(recordFileWorkSet(store, 'file.read', {}, 'content')).toBe(false);
    expect(recordFileWorkSet(store, 'file.read', { path: 'a.ts' }, '')).toBe(false);
    expect(recordFileWorkSet(undefined, 'file.read', { path: 'a.ts' }, 'x')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('超长内容截断（上限 WORK_SET_MAX_CHARS + 截断标记）', () => {
    const store = new ContextStore();
    const long = 'x'.repeat(WORK_SET_MAX_CHARS + 500);
    recordFileWorkSet(store, 'file.read', { path: 'big.ts' }, long);
    const content = store.get('file:big.ts')!.content;
    expect(content).toContain('已截断');
    expect(content.length).toBeLessThan(long.length);
  });

  it('写侧接入 toAppendMessages：追加段以 [ctx:file:<path>] 前缀输出（system 角色）', () => {
    const store = new ContextStore();
    recordFileWorkSet(store, 'file.read', { path: 'a.ts' }, '内容');
    const msgs = store.toAppendMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content.startsWith('[ctx:file:a.ts]')).toBe(true);
  });
});
