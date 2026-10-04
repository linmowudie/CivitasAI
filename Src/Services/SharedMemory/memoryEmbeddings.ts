/**
 * @module SharedMemory/memoryEmbeddings
 * @description
 * 记忆向量的存取与语义重排（FE-058——`embeddingClient` 的第一条真实消费路径）。
 *
 * 设计（嵌入**可选增强**，非硬依赖）：
 *  - 未配置嵌入模型（`configs` 的 `routing.embeddingModel` 或 `configureMemoryEmbedding`）时：
 *    检索走确定性文本打分（`Retrieval/textScore`），本模块不参与；
 *  - 配置后：`semanticRescore(query, hits)` 对候选做余弦重排
 *    （混合分 = 0.7 × 余弦 + 0.3 × 文本分）；缺失嵌入的候选保持文本分，
 *    并由 `embedPendingEntries` 后台逐步补齐（单次限量，失败静默）。
 *  - 存储：内存 Map + `long_term_memory.embedding_json` 列（迁移 v30，fail-safe——
 *    无数据库时仅内存；写库失败仅告警）。
 *
 * 错误策略：嵌入调用慢/失败不影响检索主链路（超时由 embeddingClient 控制，失败即回落文本分）。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { logger } from '../../Infra/Logging/logger.js';
import { getDatabases, isDatabaseInitialized } from '../../Infra/Db/database.js';
import { getEmbedding as defaultEmbedFn } from '../../Infra/Embedding/embeddingClient.js';
import { getActiveOwner } from '../AccountScope/activeAccount.js';

// ── 配置与依赖注入 ──────────────────────────────────────────────────

export interface MemoryEmbeddingConfig {
  /** 嵌入模型全限定名（provider/model） */
  model: string;
  /** 后台补齐单次最大条数（缺省 8） */
  backfillBatchSize: number;
}

export type EmbedFn = (model: string, text: string) => Promise<Result<number[]>>;

let _config: MemoryEmbeddingConfig | null = null;
let _embedFn: EmbedFn = defaultEmbedFn;

/** 配置嵌入模型（main.ts 检测到 routing.embeddingModel 时调用；未配置则语义增强关闭） */
export function configureMemoryEmbedding(config: { model: string; backfillBatchSize?: number }, deps?: { embedFn?: EmbedFn }): void {
  if (!config.model) {
    _config = null;
    return;
  }
  _config = {
    model: config.model,
    backfillBatchSize: config.backfillBatchSize ?? 8,
  };
  if (deps?.embedFn) _embedFn = deps.embedFn;
}

export function getMemoryEmbeddingConfig(): MemoryEmbeddingConfig | null {
  return _config ? { ..._config } : null;
}

// ── 向量存取（内存 + DB，fail-safe）──────────────────────────────────

const vectors = new Map<string, number[]>();

function mainDb(): import('better-sqlite3').Database | null {
  if (!isDatabaseInitialized()) return null;
  try {
    return getDatabases().main ?? null;
  } catch {
    return null;
  }
}

/** 写入向量（内存 + 落库；失败仅告警） */
export function setMemoryEmbedding(memoryId: string, vector: number[], owner: string = getActiveOwner()): void {
  if (!Array.isArray(vector) || vector.length === 0) return;
  vectors.set(memoryId, [...vector]);
  const db = mainDb();
  if (!db) return;
  try {
    db.prepare(
      'UPDATE long_term_memory SET embedding_json = ? WHERE owner_user_id = ? AND memory_id = ?',
    ).run(JSON.stringify(vector), owner, memoryId);
  } catch (e) {
    logger.warn('记忆向量落库失败（仅内存可用）', {
      source: 'SharedMemory/memoryEmbeddings',
      memoryId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 读取向量（内存未命中时查库，查询结果回填内存；无则返回 null） */
export function getMemoryEmbedding(memoryId: string, owner: string = getActiveOwner()): number[] | null {
  const cached = vectors.get(memoryId);
  if (cached) return cached;

  const db = mainDb();
  if (!db) return null;
  try {
    const row = db.prepare(
      'SELECT embedding_json FROM long_term_memory WHERE owner_user_id = ? AND memory_id = ?',
    ).get(owner, memoryId) as { embedding_json: string | null } | undefined;
    if (!row?.embedding_json) return null;
    const parsed: unknown = JSON.parse(row.embedding_json);
    if (Array.isArray(parsed) && parsed.every(v => typeof v === 'number')) {
      const vec = parsed as number[];
      vectors.set(memoryId, vec);
      return vec;
    }
    return null;
  } catch {
    return null;
  }
}

export function getMemoryEmbeddingCount(): number {
  return vectors.size;
}

/** 已缓存向量条数（诊断） */
export function listEmbeddedMemoryIds(): string[] {
  return [...vectors.keys()];
}

// ── 语义重排与后台补齐 ──────────────────────────────────────────────

/** 余弦相似度（维度不一致返回 0；零向量返回 0） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length !== a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface ScoredMemoryHit {
  entry: { memoryId: string; title: string; content: string };
  score: number;
}

/** 文本分与余弦的混合权重（有向量时） */
const COSINE_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;

/**
 * 语义重排：对文本检索的候选集合做嵌入余弦混合打分。
 *
 * - 未配置嵌入模型 / query 嵌入失败 → 原样返回（纯文本分）；
 * - 有向量的候选：混合分 = 0.7 × cosine + 0.3 × 文本分；
 * - 无向量的候选：保持文本分，并交给后台补齐（fire-and-forget，限量）。
 *
 * @returns 重排后的集合（按分数降序）
 */
export async function semanticRescore<T extends ScoredMemoryHit>(
  query: string,
  hits: T[],
): Promise<T[]> {
  const sortByScore = (list: T[]): T[] => [...list].sort((a, b) => b.score - a.score);

  const config = _config;
  if (!config || hits.length === 0 || query.trim() === '') return sortByScore(hits);

  const queryVec = await embedText(config.model, query);
  if (!queryVec) return sortByScore(hits); // 嵌入失败 → 回落文本分（检索不损）

  const rescored = hits.map(hit => {
    const vec = getMemoryEmbedding(hit.entry.memoryId);
    if (!vec) return hit; // 无向量 → 保持文本分（后台补齐后下次生效）
    const cos = Math.max(0, cosineSimilarity(queryVec, vec));
    const mixed = Math.min(1, cos * COSINE_WEIGHT + hit.score * TEXT_WEIGHT);
    return { ...hit, score: mixed };
  });

  rescored.sort((a, b) => b.score - a.score);
  return rescored;
}

/**
 * 后台补齐缺失向量（fire-and-forget；单次限量，失败静默）。
 * 调用方无需 await；不影响本次检索结果。
 */
export function embedPendingEntries(
  entries: Array<{ memoryId: string; title: string; content: string }>,
): void {
  const config = _config;
  if (!config) return;

  const missing = entries.filter(e => !getMemoryEmbedding(e.memoryId)).slice(0, config.backfillBatchSize);
  if (missing.length === 0) return;

  void (async () => {
    for (const entry of missing) {
      const text = [entry.title, entry.content].filter(Boolean).join('\n').slice(0, 2000);
      const vec = await embedText(config.model, text);
      if (vec) setMemoryEmbedding(entry.memoryId, vec);
    }
  })();
}

/** 嵌入单条文本（失败返回 null，不抛出） */
async function embedText(model: string, text: string): Promise<number[] | null> {
  try {
    const result = await _embedFn(model, text);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

/** 测试/诊断用：清空向量缓存与配置 */
export function resetMemoryEmbeddings(): void {
  vectors.clear();
  _config = null;
  _embedFn = defaultEmbedFn;
}

// ── 便捷：显式嵌入已有记忆（管理端点/回填用）──────────────────────

/**
 * 显式生成并存储一条记忆的向量（同步等待；失败返回错误）。
 * 供管理端点/回填工具使用；检索主链路用 `embedPendingEntries`（后台版）。
 */
export async function embedAndStore(
  entry: { memoryId: string; title: string; content: string },
): Promise<Result<number>> {
  const config = _config;
  if (!config) return err('未配置嵌入模型（routing.embeddingModel）');
  const text = [entry.title, entry.content].filter(Boolean).join('\n').slice(0, 2000);
  const vec = await embedText(config.model, text);
  if (!vec) return err(`嵌入调用失败（model=${config.model}）`);
  setMemoryEmbedding(entry.memoryId, vec);
  return ok(vec.length);
}
