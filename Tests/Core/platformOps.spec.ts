/**
 * FE-069 回归测试：平台运维接线（提示词资产 / 热加载扫描 / trace 索引）
 *
 * 覆盖：
 *  - `loadSystemAssets`：mainLoop/taskTemplate 装载 + manifest 存在性校验（真实 Prompts/）；
 *  - `buildStableSystemPrompt`：系统资产段注入 + 未装载退化（向后兼容）；
 *  - `configWatcher`：真实文件扫描（modified/added/deleted 事件）；
 *  - `traceIndex`：事件流按 trace 聚合 + 索引文件落盘。
 *
 * 说明：不依赖数据库与网络。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  loadSystemAssets, getSystemMainLoop, getTaskTemplate, resetSystemAssets,
} from '../../Src/Services/Prompts/promptRegistry.js';
import { buildStableSystemPrompt, resetSystemPromptCache } from '../../Src/Core/Loop/runIteration.js';
import {
  initConfigWatcher, onConfigChange, startWatching, stopWatching, resetConfigWatcher,
} from '../../Src/Infra/Watcher/configWatcher.js';
import {
  buildTraceIndex, writeTraceIndex,
} from '../../Src/Interface/EventStore/traceIndex.js';
import { resetEventBus, initEventBus, publish, createEvent } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════
// 1. 提示词资产装载与注入
// ═══════════════════════════════════════════════════════════════════

describe('FE-069 · 系统提示资产', () => {
  afterEach(() => {
    resetSystemAssets();
    resetSystemPromptCache();
  });

  it('loadSystemAssets：真实 Prompts/ 装载（manifest 校验无缺失）', () => {
    const check = loadSystemAssets();
    expect(check.version).toBe('1.0.0');
    expect(check.missingFiles).toEqual([]);
    expect(check.fileCount).toBeGreaterThanOrEqual(10);

    // mainLoop 装载且剥离了文档元注释（> 引用行 / 一级标题）
    const mainLoop = getSystemMainLoop();
    expect(mainLoop).not.toBeNull();
    expect(mainLoop!).not.toMatch(/^\s*>/m);
    expect(mainLoop!).not.toMatch(/^# /);
    expect(mainLoop!).toContain('Civitas-AI');

    // 任务模板装载（含占位符）
    const template = getTaskTemplate();
    expect(template).not.toBeNull();
    expect(template!).toContain('{{taskDescription}}');
  });

  it('buildStableSystemPrompt：资产段注入（静态段之后、工具目录之前）；未装载退化', () => {
    // 未装载：无资产段
    resetSystemAssets();
    const bare = buildStableSystemPrompt(['file.read'], undefined, false);
    expect(bare).toContain('You are Civitas-AI');
    expect(bare).not.toContain('Reasoning Sandwich');

    // 装载后：资产段出现（在工具目录之前）
    loadSystemAssets();
    const withAsset = buildStableSystemPrompt(['file.read'], undefined, false);
    expect(withAsset).toContain('You are Civitas-AI');
    const catalogIdx = withAsset.indexOf('## Available tools');
    const assetIdx = withAsset.indexOf('Reasoning Sandwich');
    // mainLoop.md 含“推理引导（Reasoning Sandwich”章节
    expect(assetIdx).toBeGreaterThan(-1);
    expect(assetIdx).toBeLessThan(catalogIdx);

    // 缓存键含资产段：装载前后不串缓存（cache=true 路径）
    resetSystemPromptCache();
    resetSystemAssets();
    const cachedBare = buildStableSystemPrompt(['file.read'], undefined, true);
    loadSystemAssets();
    const cachedAsset = buildStableSystemPrompt(['file.read'], undefined, true);
    expect(cachedBare).not.toBe(cachedAsset);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. configWatcher 真实扫描
// ═══════════════════════════════════════════════════════════════════

describe('FE-069 · configWatcher 真实文件扫描', () => {
  const DIR = resolve(import.meta.dirname, '../../.tmp/test-watcher-fe069');
  const events: Array<{ file: string; type: string }> = [];

  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(join(DIR, 'sub'), { recursive: true });
    writeFileSync(join(DIR, 'a.json'), '{"v":1}');
    events.length = 0;
    initConfigWatcher({ watchDir: DIR, pollIntervalMs: 50 });
    onConfigChange((file, type) => events.push({ file, type }));
  });

  afterEach(() => {
    stopWatching();
    resetConfigWatcher();
    rmSync(DIR, { recursive: true, force: true });
  });

  it('modified / added / deleted 均被检出', async () => {
    const started = startWatching();
    expect(started.ok).toBe(true);
    expect(events).toHaveLength(0); // 首扫仅建基线

    // 修改：写内容 + 强制推高 mtime（避免同 tick 内 mtime 未变的竞态）
    const target = join(DIR, 'a.json');
    writeFileSync(target, '{"v":2}');
    utimesSync(target, new Date(), new Date(Date.now() + 5000));
    await sleep(140);
    expect(events.some(e => e.type === 'modified' && e.file.includes('a.json'))).toBe(true);

    // 新增（子目录中）
    const added = join(DIR, 'sub', 'b.md');
    writeFileSync(added, '# new');
    await sleep(140);
    expect(events.some(e => e.type === 'added' && e.file.includes('b.md'))).toBe(true);

    // 删除
    rmSync(added, { force: true });
    await sleep(140);
    expect(events.some(e => e.type === 'deleted' && e.file.includes('b.md'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. trace 索引
// ═══════════════════════════════════════════════════════════════════

describe('FE-069 · trace 索引', () => {
  const DIR = resolve(import.meta.dirname, '../../.tmp/test-trace-index');

  beforeEach(() => {
    resetEventBus();
    initEventBus();
    rmSync(DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('buildTraceIndex：按 trace 聚合（事件数/起止/来源）', () => {
    publish(createEvent({ eventType: EventType.TASK_RECEIVED, source: 'src-a', traceId: 'trace-x' }));
    publish(createEvent({ eventType: EventType.TASK_ASSIGNED, source: 'src-a', traceId: 'trace-x' }));
    publish(createEvent({ eventType: EventType.TASK_COMPLETED, source: 'src-b', traceId: 'trace-y' }));

    const index = buildTraceIndex();
    expect(index).toHaveLength(2);
    const x = index.find(e => e.traceId === 'trace-x')!;
    expect(x.eventCount).toBe(2);
    expect(x.sources).toContain('src-a');
    expect(x.lastEventAt).toBeGreaterThanOrEqual(x.firstEventAt);
  });

  it('writeTraceIndex：索引文件落盘且内容可解析', () => {
    publish(createEvent({ eventType: EventType.TASK_RECEIVED, source: 'src-a', traceId: 'trace-z' }));

    const result = writeTraceIndex(DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(existsSync(result.value)).toBe(true);
    const parsed = JSON.parse(readFileSync(result.value, 'utf-8')) as {
      traceCount: number;
      eventCount: number;
      traces: Array<{ traceId: string }>;
    };
    expect(parsed.traceCount).toBeGreaterThanOrEqual(1);
    expect(parsed.traces.some(t => t.traceId === 'trace-z')).toBe(true);
  });
});
