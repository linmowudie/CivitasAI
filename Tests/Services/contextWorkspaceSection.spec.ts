/**
 * 会话工作目录注入追加区（BUG-2026-10-08-2 的收口回归）
 *
 * 修复背景：`workDir` 此前只进工具执行上下文（`runIteration` 的 `toolCtx.workDir`），
 * 从未进入模型可见的消息，模型只能猜 `.` / `/` / 其它绝对路径 → PATH_DENIED → 空转或一失败即退。
 * 现把绝对路径写入追加区（消息尾部），既让模型可见，又不破坏系统提示前缀缓存。
 */
import { describe, it, expect } from 'vitest';

import {
  ContextStore,
  buildWorkspaceSection,
  WORKSPACE_SECTION_KEY,
} from '../../Src/Services/Context/contextStore.js';

const DIR = 'F:\\ProjectCode\\CivitasAI\\Data\\workspaces\\sess-1';

describe('buildWorkspaceSection · 会话工作目录分区', () => {
  it('无工作目录时不注入（未绑定会话保持原行为）', () => {
    expect(buildWorkspaceSection(undefined)).toBeNull();
    expect(buildWorkspaceSection(null)).toBeNull();
    expect(buildWorkspaceSection('')).toBeNull();
    expect(buildWorkspaceSection('   ')).toBeNull();
  });

  it('有工作目录时给出绝对路径与"以此为根"的约束', () => {
    const section = buildWorkspaceSection(DIR);
    expect(section).not.toBeNull();
    if (!section) return;
    expect(section.key).toBe(WORKSPACE_SECTION_KEY);
    expect(section.content).toContain(DIR);
    expect(section.content).toContain('以该目录为根');
    expect(section.content).toContain('不要使用');
  });

  it('两端空白被裁剪（避免路径带空格导致工具判定不一致）', () => {
    const section = buildWorkspaceSection(`  ${DIR}  `);
    expect(section?.content).toContain(`工作目录：${DIR}\n`);
  });
});

describe('ContextStore · 工作目录分区的消息化与位置稳定', () => {
  it('写入后出现在追加消息里，且带 [ctx:workspace] 前缀', () => {
    const store = new ContextStore();
    const section = buildWorkspaceSection(DIR);
    if (!section) throw new Error('section 不应为空');
    expect(store.put(section)).toBe(true);

    const messages = store.toAppendMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content.startsWith(`[ctx:${WORKSPACE_SECTION_KEY}] `)).toBe(true);
    expect(messages[0]?.content).toContain(DIR);
  });

  it('同内容重复写入被跳过（每轮迭代调用 put 不会制造重复消息）', () => {
    const store = new ContextStore();
    const first = buildWorkspaceSection(DIR);
    const second = buildWorkspaceSection(DIR);
    if (!first || !second) throw new Error('section 不应为空');

    expect(store.put(first)).toBe(true);
    expect(store.put(second)).toBe(false); // 同键同内容 → 跳过
    expect(store.toAppendMessages()).toHaveLength(1);
  });

  it('工作目录变更时原位替换，位置不变（前缀缓存友好）', () => {
    const store = new ContextStore();
    const fileSection = { key: 'file:a.ts', content: 'aaa', timestamp: 1 };
    const ws1 = buildWorkspaceSection('D:\\ws1');
    const ws2 = buildWorkspaceSection('D:\\ws2');
    if (!ws1 || !ws2) throw new Error('section 不应为空');

    store.put(fileSection);
    store.put(ws1);
    expect(store.keys()).toEqual(['file:a.ts', WORKSPACE_SECTION_KEY]);

    expect(store.put(ws2)).toBe(true);
    expect(store.keys()).toEqual(['file:a.ts', WORKSPACE_SECTION_KEY]); // 位置不变
    const messages = store.toAppendMessages();
    expect(messages[1]?.content).toContain('D:\\ws2');
  });
});
