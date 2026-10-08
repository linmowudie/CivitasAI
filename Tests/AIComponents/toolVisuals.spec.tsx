/**
 * @vitest-environment jsdom
 *
 * 工具展示动画（Harness 视觉语言）测试。
 *
 * 测试范围：
 * - `toolVisuals`：语义分类 `classifyToolVisual` / 子分组 `inferSubgroup` / 探索型判定
 *   / 人读描述 `describeToolCall` / 组汇总 `summarizeToolGroup` + `formatCounts`
 * - `ToolGlyph`：使用中播放语义动画、生成参数期降速（preparing）、出结果回落静态
 * - `ToolGroup`：`+工具+描述` 行渲染、组头状态词与语义计数、**探索态小眼睛持续到探索完成**
 */
import { describe, it, expect } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

import {
  classifyToolVisual,
  describeToolCall,
  formatCounts,
  inferSubgroup,
  isExploratoryTool,
  subgroupOfVisual,
  summarizeToolGroup,
} from '../../Client/src/ai-components/harness/toolVisuals';
import { ToolGlyph } from '../../Client/src/ai-components/harness/ToolGlyph';
import { ToolGroup } from '../../Client/src/ai-components/harness/ToolGroup';
import type { ToolCallEntry } from '../../Client/src/stores/chatStore';

// ── classifyToolVisual ──────────────────────────────────────────────

describe('classifyToolVisual', () => {
  it('读/查/列/搜 → gaze（小眼睛）', () => {
    expect(classifyToolVisual('file.read')).toBe('gaze');
    expect(classifyToolVisual('file.grep')).toBe('gaze');
    expect(classifyToolVisual('dir.list')).toBe('gaze');
    expect(classifyToolVisual('web.search')).toBe('gaze');
    expect(classifyToolVisual('vector.search')).toBe('gaze');
    expect(classifyToolVisual('tool.search')).toBe('gaze');
  });

  it('写/编辑/创建/更新 → flow（光流）', () => {
    expect(classifyToolVisual('file.write')).toBe('flow');
    expect(classifyToolVisual('file.edit')).toBe('flow');
    expect(classifyToolVisual('todo.write')).toBe('flow');
    expect(classifyToolVisual('create_record')).toBe('flow');
    expect(classifyToolVisual('update_config')).toBe('flow');
  });

  it('删除/清空/移除 → erase（方块阵列沉浮）', () => {
    expect(classifyToolVisual('file.delete')).toBe('erase');
    expect(classifyToolVisual('delete_file')).toBe('erase');
    expect(classifyToolVisual('remove_item')).toBe('erase');
    expect(classifyToolVisual('cache.clear')).toBe('erase');
  });

  it('执行命令/跑代码 → pulse（终端扫描）', () => {
    expect(classifyToolVisual('shell.exec')).toBe('pulse');
    expect(classifyToolVisual('code.eval')).toBe('pulse');
    expect(classifyToolVisual('run_script')).toBe('pulse');
    expect(classifyToolVisual('execute_query')).toBe('pulse');
  });

  it('系统类与工具派发 → gear（轨道环）', () => {
    expect(classifyToolVisual('tool.execute')).toBe('gear');
    expect(classifyToolVisual('agent.recruit')).toBe('gear');
    expect(classifyToolVisual('agent.submit_review')).toBe('gear');
    expect(classifyToolVisual('log_event')).toBe('gear');
    expect(classifyToolVisual('')).toBe('gear');
  });

  it('驼峰命名按切分识别（readFile / writeFile）', () => {
    expect(classifyToolVisual('readFile')).toBe('gaze');
    expect(classifyToolVisual('writeFile')).toBe('flow');
  });

  it('大小写敏感：Read_file 不识别为 read', () => {
    expect(classifyToolVisual('Read_file')).toBe('gear');
  });

  it('删除优先于写入（delete_and_write 走 erase）', () => {
    expect(classifyToolVisual('delete_and_write')).toBe('erase');
  });
});

// ── inferSubgroup / subgroupOfVisual / isExploratoryTool ────────────

describe('inferSubgroup（兼容旧口径 + 点号命名）', () => {
  it('点号命名的内置工具归属正确子分组', () => {
    expect(inferSubgroup('file.read')).toBe('read');
    expect(inferSubgroup('file.grep')).toBe('read');
    expect(inferSubgroup('dir.list')).toBe('read');
    expect(inferSubgroup('file.write')).toBe('write');
    expect(inferSubgroup('file.edit')).toBe('write');
    expect(inferSubgroup('shell.exec')).toBe('exec');
    expect(inferSubgroup('code.eval')).toBe('exec');
    expect(inferSubgroup('tool.execute')).toBe('system');
  });

  it('旧前缀口径保持：read_/search_/list_ → read', () => {
    expect(inferSubgroup('read_file')).toBe('read');
    expect(inferSubgroup('search_db')).toBe('read');
    expect(inferSubgroup('list_items')).toBe('read');
  });

  it('旧前缀口径保持：大小写敏感、未知 → system', () => {
    expect(inferSubgroup('Read_file')).toBe('system');
    expect(inferSubgroup('notify_user')).toBe('system');
    expect(inferSubgroup('')).toBe('system');
  });

  it('subgroupOfVisual 映射五语义 → 四子分组', () => {
    expect(subgroupOfVisual('gaze')).toBe('read');
    expect(subgroupOfVisual('flow')).toBe('write');
    expect(subgroupOfVisual('erase')).toBe('write');
    expect(subgroupOfVisual('pulse')).toBe('exec');
    expect(subgroupOfVisual('gear')).toBe('system');
  });
});

describe('isExploratoryTool（探索型 = gaze）', () => {
  it('读/查/搜为探索型', () => {
    expect(isExploratoryTool('file.read')).toBe(true);
    expect(isExploratoryTool('dir.list')).toBe(true);
    expect(isExploratoryTool('tool.search')).toBe(true);
  });

  it('写入/删除/执行/系统不是探索型', () => {
    expect(isExploratoryTool('file.write')).toBe(false);
    expect(isExploratoryTool('file.delete')).toBe(false);
    expect(isExploratoryTool('shell.exec')).toBe(false);
    expect(isExploratoryTool('agent.recruit')).toBe(false);
  });
});

// ── describeToolCall ────────────────────────────────────────────────

describe('describeToolCall（+工具+描述 的"描述"）', () => {
  it('读取文件：动作 + 路径', () => {
    expect(describeToolCall('file.read', { path: 'Src/main.ts' }).text)
      .toBe('读取文件 · Src/main.ts');
  });

  it('写入文件：动作 + 路径 + 内容体量', () => {
    const d = describeToolCall('file.write', { path: 'a.ts', content: 'x'.repeat(2048) });
    expect(d.text).toBe('写入文件 · a.ts · 写入 2.0 KB');
  });

  it('修改文件：动作 + 路径 + 查找替换', () => {
    expect(describeToolCall('file.edit', { path: 'a.ts', search: 'foo', replace: 'bar' }).text)
      .toBe('修改文件 · a.ts · 查找替换');
  });

  it('搜索文件内容：动作 + 根目录 + 模式', () => {
    expect(describeToolCall('file.grep', { path: 'src', pattern: 'TODO' }).text)
      .toBe('搜索文件内容 · src · 「TODO」');
  });

  it('执行命令：动作 + 命令原文', () => {
    expect(describeToolCall('shell.exec', { command: 'npm test' }).text)
      .toBe('执行命令 · npm test');
  });

  it('执行代码：动作 + 行数（不展开代码正文）', () => {
    const d = describeToolCall('code.eval', { code: 'const a = 1;\nconst b = 2;\nconsole.log(a + b);' });
    expect(d.text).toBe('执行代码 · 3 行');
  });

  it('删除文件：动作 + 路径', () => {
    expect(describeToolCall('file.delete', { path: 'old.ts' }).text).toBe('删除文件 · old.ts');
  });

  it('工具派发：动作 + 被调用的工具名', () => {
    expect(describeToolCall('tool.execute', { name: 'file.write', arguments: {} }).text)
      .toBe('调用工具 · file.write');
  });

  it('更新待办：动作 + 条数', () => {
    const d = describeToolCall('todo.write', { todos: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(d.text).toBe('更新待办 · 3 项');
  });

  it('旧式下划线命名有中文动作词', () => {
    expect(describeToolCall('read_file', { path: '/test.txt' }).text).toBe('读取文件 · /test.txt');
  });

  it('未知工具回落为语义动作词，无参数时只有动作', () => {
    expect(describeToolCall('log_event', {}).text).toBe('调用');
  });

  it('超长路径截断为尾部保留（省略号开头）', () => {
    const long = `${'very-long-dir/'.repeat(10)}tail.ts`;
    const { target } = describeToolCall('file.read', { path: long });
    expect(target?.startsWith('…')).toBe(true);
    expect(target?.endsWith('tail.ts')).toBe(true);
    expect(target!.length).toBeLessThanOrEqual(46);
  });

  it('返回结构化字段（label / target / detail）', () => {
    const d = describeToolCall('file.grep', { path: 'src', pattern: 'TODO' });
    expect(d.label).toBe('搜索文件内容');
    expect(d.target).toBe('src');
    expect(d.detail).toBe('「TODO」');
  });
});

// ── summarizeToolGroup / formatCounts ───────────────────────────────

describe('summarizeToolGroup', () => {
  it('全部完成：done / 已完成 / explored', () => {
    const s = summarizeToolGroup([
      { name: 'file.read', status: 'success' },
      { name: 'file.grep', status: 'success' },
    ]);
    expect(s.state).toBe('done');
    expect(s.label).toBe('已完成');
    expect(s.running).toBe(0);
    expect(s.hasExploratory).toBe(true);
    expect(s.exploring).toBe(false);
    expect(s.explored).toBe(true);
    expect(s.visual).toBe('gaze');
  });

  it('探索型仍在跑：exploring / 探索中…（组头持续小眼睛）', () => {
    const s = summarizeToolGroup([
      { name: 'file.read', status: 'success' },
      { name: 'file.grep', status: 'pending' },
    ]);
    expect(s.state).toBe('exploring');
    expect(s.label).toBe('探索中…');
    expect(s.exploring).toBe(true);
    expect(s.visual).toBe('gaze');
  });

  it('探索已完成 + 写入执行中：不再是探索态，视觉切到 flow', () => {
    const s = summarizeToolGroup([
      { name: 'file.read', status: 'success' },
      { name: 'file.write', status: 'pending' },
    ]);
    expect(s.exploring).toBe(false);
    expect(s.explored).toBe(true);
    expect(s.state).toBe('executing');
    expect(s.label).toBe('执行中…');
    expect(s.visual).toBe('flow');
  });

  it('仅参数生成中：generating / 准备中…', () => {
    const s = summarizeToolGroup([{ name: 'file.write', status: 'generating' }]);
    expect(s.state).toBe('generating');
    expect(s.label).toBe('准备中…');
  });

  it('有失败：failed / N 项失败', () => {
    const s = summarizeToolGroup([
      { name: 'shell.exec', status: 'error' },
      { name: 'file.read', status: 'success' },
    ]);
    expect(s.state).toBe('failed');
    expect(s.label).toBe('1 项失败');
    expect(s.failed).toBe(1);
    expect(s.settled).toBe(2);
  });

  it('计数按语义归类', () => {
    const s = summarizeToolGroup([
      { name: 'file.read', status: 'success' },
      { name: 'dir.list', status: 'success' },
      { name: 'file.write', status: 'success' },
      { name: 'shell.exec', status: 'success' },
      { name: 'tool.execute', status: 'success' },
    ]);
    expect(s.counts).toEqual({ gaze: 2, flow: 1, erase: 0, pulse: 1, gear: 1 });
    expect(s.total).toBe(5);
    expect(s.visual).toBe('gear');
  });

  it('空列表：done，无计数', () => {
    const s = summarizeToolGroup([]);
    expect(s.state).toBe('done');
    expect(s.total).toBe(0);
    expect(s.explored).toBe(false);
    expect(formatCounts(s.counts)).toBe('');
  });
});

describe('formatCounts', () => {
  it('只显示非零语义，按 读→写→删→执行→系统 排序', () => {
    expect(formatCounts({ gaze: 2, flow: 1, erase: 0, pulse: 0, gear: 0 })).toBe('查阅 2 · 写入 1');
    expect(formatCounts({ gaze: 0, flow: 0, erase: 1, pulse: 3, gear: 1 }))
      .toBe('删除 1 · 执行 3 · 调用 1');
  });
});

// ── ToolGlyph 组件 ──────────────────────────────────────────────────

describe('ToolGlyph', () => {
  it('执行中播放语义动画（data-animated）', () => {
    render(<ToolGlyph toolName="file.read" status="pending" />);
    const glyph = screen.getByTestId('tool-glyph');
    expect(glyph.getAttribute('data-visual')).toBe('gaze');
    expect(glyph.getAttribute('data-mode')).toBe('running');
    expect(glyph.getAttribute('data-animated')).toBe('true');
  });

  it('删除类工具走 erase 语义', () => {
    render(<ToolGlyph toolName="file.delete" status="pending" />);
    expect(screen.getByTestId('tool-glyph').getAttribute('data-visual')).toBe('erase');
  });

  it('参数生成中降速（preparing）', () => {
    render(<ToolGlyph toolName="file.write" status="generating" />);
    const glyph = screen.getByTestId('tool-glyph');
    expect(glyph.getAttribute('data-mode')).toBe('preparing');
    expect(glyph.getAttribute('data-visual')).toBe('flow');
  });

  it('出结果回落为静态图标（settled，无动画）', () => {
    render(<ToolGlyph toolName="file.read" status="success" />);
    const glyph = screen.getByTestId('tool-glyph');
    expect(glyph.getAttribute('data-mode')).toBe('settled');
    expect(glyph.getAttribute('data-visual')).toBe('gaze');
    expect(glyph.getAttribute('data-animated')).toBeNull();
  });

  it('出错同样回落静态', () => {
    render(<ToolGlyph toolName="shell.exec" status="error" />);
    expect(screen.getByTestId('tool-glyph').getAttribute('data-mode')).toBe('settled');
  });

  it('可强制指定语义（组头"探索中"用）', () => {
    render(<ToolGlyph toolName="file.write" visual="gaze" status="pending" />);
    expect(screen.getByTestId('tool-glyph').getAttribute('data-visual')).toBe('gaze');
  });

  it('装饰性图形对读屏隐藏', () => {
    render(<ToolGlyph toolName="file.read" status="pending" />);
    expect(screen.getByTestId('tool-glyph').getAttribute('aria-hidden')).toBe('true');
  });
});

// ── ToolGroup 集成 ──────────────────────────────────────────────────

describe('ToolGroup 展示规格（+工具+描述）', () => {
  const writeCall: ToolCallEntry = {
    id: 'w-1',
    name: 'file.write',
    arguments: { path: 'Client/src/index.css', content: 'a'.repeat(2048) },
    status: 'pending',
  };

  it('每行展示工具名 + 人读描述', () => {
    render(<ToolGroup toolCalls={[writeCall]} />);
    expect(screen.getByText('file.write')).toBeTruthy();
    expect(screen.getByText('写入文件 · Client/src/index.css · 写入 2.0 KB')).toBeTruthy();
  });

  it('使用中该行播放对应语义动画', () => {
    render(<ToolGroup toolCalls={[writeCall]} />);
    const glyphs = screen.getAllByTestId('tool-glyph');
    // [0] 组头，[1] 工具行
    expect(glyphs[1].getAttribute('data-visual')).toBe('flow');
    expect(glyphs[1].getAttribute('data-mode')).toBe('running');
  });

  it('出结果后该行动画停止（静态图标）', () => {
    render(<ToolGroup toolCalls={[{ ...writeCall, status: 'success', durationMs: 12 }]} />);
    const glyphs = screen.getAllByTestId('tool-glyph');
    expect(glyphs[1].getAttribute('data-mode')).toBe('settled');
    expect(screen.getByText('12 ms')).toBeTruthy();
  });

  it('行上带 data-visual 便于样式与断言', () => {
    const { container } = render(<ToolGroup toolCalls={[writeCall]} />);
    expect(container.querySelector('[data-status="pending"][data-visual="flow"]')).toBeTruthy();
  });

  it('组头显示状态词与语义计数', () => {
    const calls: ToolCallEntry[] = [
      { id: 'r-1', name: 'file.read', arguments: { path: 'a.ts' }, status: 'success' },
      { id: 'g-1', name: 'file.grep', arguments: { path: 'src', pattern: 'TODO' }, status: 'pending' },
    ];
    render(<ToolGroup toolCalls={calls} />);
    expect(screen.getByText('探索中…')).toBeTruthy();
    expect(screen.getByText('查阅 2')).toBeTruthy();
  });

  it('探索未完成前持续显示小眼睛，探索完成后停止', () => {
    const calls: ToolCallEntry[] = [
      { id: 'r-1', name: 'file.read', arguments: { path: 'a.ts' }, status: 'success' },
      { id: 'g-1', name: 'file.grep', arguments: { path: 'src', pattern: 'TODO' }, status: 'pending' },
    ];
    const { rerender } = render(<ToolGroup toolCalls={calls} />);

    // 探索中：组状态为 exploring，组头动画为小眼睛且仍在播放
    const group = screen.getByTestId('tool-group');
    expect(group.getAttribute('data-state')).toBe('exploring');
    expect(group.getAttribute('data-exploring')).toBe('true');
    const headerGlyph = screen.getAllByTestId('tool-glyph')[0];
    expect(headerGlyph.getAttribute('data-visual')).toBe('gaze');
    expect(headerGlyph.getAttribute('data-animated')).toBe('true');

    // 探索完成（同组全部落定）：不再是探索态，组头动画停止
    rerender(
      <ToolGroup toolCalls={calls.map((c) => ({ ...c, status: 'success' as const }))} />,
    );
    const doneGroup = screen.getByTestId('tool-group');
    expect(doneGroup.getAttribute('data-state')).toBe('done');
    expect(doneGroup.getAttribute('data-exploring')).toBeNull();
    expect(screen.getAllByTestId('tool-glyph')[0].getAttribute('data-mode')).toBe('settled');
  });

  it('探索完成后仍有写入在跑：视觉从眼睛切到光流', () => {
    const calls: ToolCallEntry[] = [
      { id: 'r-1', name: 'file.read', arguments: { path: 'a.ts' }, status: 'success' },
      { id: 'w-1', name: 'file.write', arguments: { path: 'b.ts' }, status: 'pending' },
    ];
    render(<ToolGroup toolCalls={calls} />);
    const group = screen.getByTestId('tool-group');
    expect(group.getAttribute('data-state')).toBe('executing');
    const headerGlyph = screen.getAllByTestId('tool-glyph')[0];
    expect(headerGlyph.getAttribute('data-visual')).toBe('flow');
    expect(headerGlyph.getAttribute('data-animated')).toBe('true');
  });

  it('全部完成时组头为静态图标（不显示运行状态词）', () => {
    const calls: ToolCallEntry[] = [
      { id: 'r-1', name: 'file.read', arguments: { path: 'a.ts' }, status: 'success' },
    ];
    render(<ToolGroup toolCalls={calls} />);
    expect(screen.getByTestId('tool-group').getAttribute('data-state')).toBe('done');
    expect(screen.queryByText('探索中…')).toBeNull();
    expect(screen.queryByText('已完成')).toBeNull();
    expect(screen.getAllByTestId('tool-glyph')[0].getAttribute('data-mode')).toBe('settled');
  });

  it('失败时组头给出失败计数', () => {
    const calls: ToolCallEntry[] = [
      { id: 'e-1', name: 'shell.exec', arguments: { command: 'npm test' }, status: 'error' },
    ];
    render(<ToolGroup toolCalls={calls} />);
    expect(screen.getByTestId('tool-group').getAttribute('data-state')).toBe('failed');
    expect(screen.getByText('1 项失败')).toBeTruthy();
  });

  it('参数生成中：文案与动画同为"准备"态', () => {
    const calls: ToolCallEntry[] = [
      { id: 'w-1', name: 'file.write', arguments: {}, status: 'generating' },
    ];
    render(<ToolGroup toolCalls={calls} />);
    expect(screen.getByText('准备写入…')).toBeTruthy();
    const glyphs = screen.getAllByTestId('tool-glyph');
    expect(glyphs[1].getAttribute('data-mode')).toBe('preparing');
  });
});
