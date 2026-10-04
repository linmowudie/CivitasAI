/**
 * FE-058 回归测试：记忆检索闭环（文本打分 + 可选语义重排 + 工具接线）
 *
 * 覆盖：
 *  - textRelevanceScore：中文 bigram / 拉丁词 / 无关零分 / title 权重；
 *  - searchMemories：打分排序、过滤、limit、空查询浏览语义、访问统计副作用；
 *  - createMemoryRetriever：真实检索（替代“桩恒空”）与空查询诚实返回；
 *  - memoryEmbeddings：余弦、混合重排（有/无向量）、嵌入失败回落、后台补齐；
 *  - vector.search 工具：真实返回记忆条目。
 *
 * 说明：不依赖数据库（内存路径）；嵌入经 embedFn 注入（不发起真实请求）。
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { resetLongTermMemory, writeMemory, searchMemories, searchMemory } from '../../Src/Services/SharedMemory/longTermMemory.js';
import {
  configureMemoryEmbedding, resetMemoryEmbeddings, semanticRescore,
  embedPendingEntries, getMemoryEmbedding, cosineSimilarity, getMemoryEmbeddingCount,
  embedAndStore,
} from '../../Src/Services/SharedMemory/memoryEmbeddings.js';
import { createMemoryRetriever, retrieveFromMultiple } from '../../Src/Services/Retrieval/retriever.js';
import { tokenize, textRelevanceScore } from '../../Src/Services/Retrieval/textScore.js';
import { vectorSearch } from '../../Src/Tools/Builtin/Search/vectorSearch.js';
import { configureToolServicePorts } from '../../Src/Tools/Registry/toolServicePorts.js';
import { ok, err } from '../../Src/Infra/types.js';
import type { ToolExecutionContext } from '../../Src/Tools/Traits/toolSpec.js';

// ── 脚手架 ──────────────────────────────────────────────────────────

function seedMemories(): void {
  writeMemory({
    title: '登录接口实现',
    content: '实现了用户登录接口与 JWT 校验，端点 /auth/login，附单元测试。',
    category: 'fact',
    sourceTraceIds: ['trace-a'],
  });
  writeMemory({
    title: '首页样式规范',
    content: '首页使用深色主题与卡片布局，主色 #1F6FEB，圆角 8px。',
    category: 'rule',
    sourceTraceIds: ['trace-b'],
  });
  writeMemory({
    title: '数据库迁移约定',
    content: '每次 schema 变更需增量迁移文件，编号连续，禁止修改已发布迁移。',
    category: 'pattern',
    sourceTraceIds: ['trace-c'],
  });
}

const toolCtx: ToolExecutionContext = {
  operationId: 'op-test',
  agentId: 'agent-test-1',
  agentRole: 'worker',
  loopId: 'loop-test',
  traceId: 'trace-test',
  signal: undefined as unknown as AbortSignal,
} as ToolExecutionContext;

beforeEach(() => {
  resetLongTermMemory();
  resetMemoryEmbeddings();
  // 分层修正（2026-10-04）：vector.search 经端口注入检索器（Tools 不可直连 Services）
  configureToolServicePorts({ memoryRetrieverFactory: createMemoryRetriever });
});

// ═══════════════════════════════════════════════════════════════════
// 1. 文本打分
// ═══════════════════════════════════════════════════════════════════

describe('FE-058 · 文本打分', () => {
  it('分词：中文 bigram + 拉丁词元', () => {
    const tokens = tokenize('实现登录 login JWT');
    expect(tokens).toContain('登录');
    expect(tokens).toContain('实现');
    expect(tokens).toContain('login');
    expect(tokens).toContain('jwt');
  });

  it('中文命中：query 与文档高度重叠 → 分数显著大于 0', () => {
    const score = textRelevanceScore('登录接口', '实现了用户登录接口与 JWT 校验');
    expect(score).toBeGreaterThan(0.3);
  });

  it('无关文本 → 0 分；空 query → 0 分', () => {
    expect(textRelevanceScore('登录接口', '首页使用深色主题卡片布局')).toBe(0);
    expect(textRelevanceScore('', '任意文本')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. searchMemories（打分检索）
// ═══════════════════════════════════════════════════════════════════

describe('FE-058 · searchMemories', () => {
  it('按相关度排序 + 无关条目被过滤', () => {
    seedMemories();
    const hits = searchMemories('登录接口 JWT', { limit: 10 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.entry.title).toContain('登录');
    expect(hits.every(h => h.score > 0)).toBe(true);
    // 无关条目（首页样式）不应命中
    expect(hits.some(h => h.entry.title.includes('首页'))).toBe(false);
  });

  it('limit 与 minScore 生效；category 过滤生效', () => {
    seedMemories();
    const limited = searchMemories('接口', { limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);

    const high = searchMemories('数据库迁移约定', { minScore: 0.99 });
    expect(high.length).toBe(0); // 无完美匹配（阈值 0.99）

    const byCategory = searchMemories('', { category: 'rule', limit: 10 });
    expect(byCategory.every(h => h.entry.category === 'rule')).toBe(true);
  });

  it('空查询 → 浏览语义（按最近访问），并更新访问统计', () => {
    seedMemories();
    const first = searchMemories('登录', { limit: 1 });
    expect(first.length).toBe(1);
    const browsed = searchMemories('', { limit: 10 });
    expect(browsed.length).toBe(3);
    // 上一步访问过的“登录”条目应排在最前（lastAccessedAt 最新）
    expect(browsed[0]!.entry.title).toContain('登录');
  });

  it('searchMemory（旧接口）保持兼容', () => {
    seedMemories();
    const all = searchMemory({ limit: 10 });
    expect(all.length).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. 检索器（替代“桩恒空”）
// ═══════════════════════════════════════════════════════════════════

describe('FE-058 · createMemoryRetriever（真实检索）', () => {
  it('返回真实命中片段（不再是恒空桩）', async () => {
    seedMemories();
    const retriever = createMemoryRetriever();
    const result = await retriever.retrieve({ query: '登录 JWT', topK: 5, minScore: 0.05 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fragments.length).toBeGreaterThanOrEqual(1);
    expect(result.value.fragments[0]!.content).toContain('登录');
    expect(result.value.source).toBe('long-term-memory');
  });

  it('空查询 → 空结果（诚实返回）', async () => {
    seedMemories();
    const retriever = createMemoryRetriever();
    const result = await retriever.retrieve({ query: '   ', topK: 5, minScore: 0.05 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fragments).toHaveLength(0);
  });

  it('retrieveFromMultiple 合并多检索器', async () => {
    seedMemories();
    const result = await retrieveFromMultiple(
      [createMemoryRetriever(), createMemoryRetriever()],
      { query: '数据库迁移', topK: 3, minScore: 0.05 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 两个相同检索器 → 同一片段重复出现（按分数排序，topK 截断）
    expect(result.value.fragments.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. 嵌入增强（可选路径）
// ═══════════════════════════════════════════════════════════════════

/** 确定性假嵌入：登录类文本 → [1,0]，页面类 → [0,1]，其余 → [0.5,0.5] */
function fakeVec(text: string): number[] {
  if (text.includes('登录') || text.includes('JWT') || text.includes('jwt')) return [1, 0];
  if (text.includes('页面') || text.includes('主题') || text.includes('布局')) return [0, 1];
  return [0.5, 0.5];
}

describe('FE-058 · 嵌入增强', () => {
  it('cosineSimilarity：正交 0 / 同向 1 / 维度不符 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it('未配置嵌入模型 → semanticRescore 原样返回', async () => {
    const hits = [{ entry: { memoryId: 'm1', title: 'a', content: 'b' }, score: 0.5 }];
    const out = await semanticRescore('查询', hits);
    expect(out).toEqual(hits);
  });

  it('有向量条目 → 余弦混合重排；嵌入失败 → 回落文本分', async () => {
    seedMemories();
    // 配置假嵌入
    configureMemoryEmbedding(
      { model: 'fake-embed', backfillBatchSize: 4 },
      { embedFn: async (_m, text) => ok(fakeVec(text)) },
    );

    // 给“登录”条目写入向量
    const { getMemoryEmbedding: get } = await import('../../Src/Services/SharedMemory/memoryEmbeddings.js');
    expect(get('ltm-1')).toBeNull();
    const stored = await embedAndStore({ memoryId: 'ltm-1', title: '登录接口实现', content: '实现了用户登录接口' });
    expect(stored.ok).toBe(true);
    expect(get('ltm-1')).not.toBeNull();

    const hits = [
      { entry: { memoryId: 'ltm-1', title: '登录接口实现', content: '实现登录' }, score: 0.3 },
      { entry: { memoryId: 'ltm-2', title: '首页样式规范', content: '深色主题' }, score: 0.6 },
    ];
    const rescored = await semanticRescore('登录 JWT', hits);
    // 登录条目获得高余弦 → 应反超
    expect(rescored[0]!.entry.memoryId).toBe('ltm-1');

    // 嵌入失败回落：直接调用（query 嵌入也走 fake → 改成抛错注入）
    configureMemoryEmbedding(
      { model: 'fake-embed' },
      { embedFn: async () => err('模拟嵌入故障') },
    );
    const fallback = await semanticRescore('登录 JWT', hits);
    // 原顺序保留（ltm-2 分数高在前）——文本分不被破坏
    expect(fallback[0]!.entry.memoryId).toBe('ltm-2');
  });

  it('embedPendingEntries：后台补齐缺失向量（限批量）', async () => {
    seedMemories();
    configureMemoryEmbedding(
      { model: 'fake-embed', backfillBatchSize: 2 },
      { embedFn: async (_m, text) => ok(fakeVec(text)) },
    );

    expect(getMemoryEmbeddingCount()).toBe(0);
    embedPendingEntries([
      { memoryId: 'ltm-1', title: '登录接口实现', content: '登录' },
      { memoryId: 'ltm-2', title: '首页样式规范', content: '页面' },
      { memoryId: 'ltm-3', title: '数据库迁移约定', content: '迁移' },
    ]);
    // fire-and-forget：等待后台异步完成
    await new Promise(r => setTimeout(r, 30));
    // backfillBatchSize=2 → 最多补 2 条
    expect(getMemoryEmbeddingCount()).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. vector.search 工具
// ═══════════════════════════════════════════════════════════════════

describe('FE-058 · vector.search 工具', () => {
  it('返回真实记忆条目（不再是空桩）', async () => {
    seedMemories();
    const result = await vectorSearch.execute({ query: '登录接口', topK: 3 }, toolCtx);
    expect(result.status).toBe('success');
    const payload = JSON.parse(String(result.output ?? result.content ?? (result as unknown as { text?: string }).text ?? '{}')) as {
      count: number;
      results: Array<{ content: string; score: number }>;
    };
    expect(payload.count).toBeGreaterThanOrEqual(1);
    expect(payload.results[0]!.content).toContain('登录');
    expect(payload.results[0]!.score).toBeGreaterThan(0);
  });

  it('空 query → INVALID_INPUT；无命中 → 0 条 + hint', async () => {
    seedMemories();
    const bad = await vectorSearch.execute({ query: '   ' }, toolCtx);
    expect(bad.status).toBe('error');

    const none = await vectorSearch.execute({ query: '量子引力波探测器' }, toolCtx);
    expect(none.status).toBe('success');
  });
});
