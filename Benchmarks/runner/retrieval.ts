/**
 * @module Benchmarks/runner/retrieval
 * @description
 * 检索质量实验（系统轴 · 检索系统）：把 `retrievalGoldenSet.json` 真正跑起来，
 * 产出 Recall@K / MRR。
 *
 * 为什么需要它：九系统检验方案 §5 指出项目**不存在任何检索 ground truth**，
 * 因此 Recall@K / MRR 类实验当时不可执行；数据资产交付后仍需要 seeding + 指标计算，
 * 否则资产只是"躺在那里的 JSON"。
 *
 * 评测卫生（文档 §2.3）：`searchMemories` 有写副作用（`accessCount` / `lastAccessedAt`，
 * ≥5 触发 `MEMORY_SELF_REINFORCING`）。本实验**全程跑在实验台自己的临时数据根**
 * （`Data/_bench_<scenarioId>`，场景结束即删除），因此不会污染开发机记忆，
 * 也保证"上一轮实验不会把自己抬高"。该副作用已由 `SC-LOCK-SEARCH-WRITE-SIDE-EFFECT` 锁定。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createMemoryRetriever } from "../../Src/Services/Retrieval/retriever.js";
import {
  retrieveForContextAssembly,
  type MemorySearchPortFn,
} from "../../Src/Core/Loop/memoryRetrievalEntry.js";
import { writeMemory } from "../../Src/Services/SharedMemory/longTermMemory.js";
import type { RetrievalSummary } from "./types.js";

interface GoldenCorpusEntry {
  memoryId: string;
  title: string;
  content: string;
  category: string;
  status?: string;
}

interface GoldenQuery {
  id: string;
  query: string;
  expected: string[];
  topK?: number;
  note?: string;
}

interface GoldenSet {
  version: string;
  corpus: GoldenCorpusEntry[];
  queries: GoldenQuery[];
}

/**
 * 跑一遍检索质量实验。
 * @param goldenSetRel 相对仓库根的 golden set 路径
 * @param traceId 用于记忆来源标记
 */
export async function runRetrievalSuite(
  goldenSetRel: string,
  traceId: string,
): Promise<RetrievalSummary> {
  const path = resolve(process.cwd(), goldenSetRel);
  const golden = JSON.parse(readFileSync(path, "utf8")) as GoldenSet;

  // ── 1. seeding：写入语料，并保留 memoryId → 内部 id 的映射 ──
  const internalIdToMemoryId = new Map<string, string>();
  let seeded = 0;
  for (const entry of golden.corpus) {
    const r = writeMemory({
      title: entry.title,
      content: entry.content,
      category: entry.category as never,
      sourceTraceIds: [traceId],
    });
    if (r.ok) {
      internalIdToMemoryId.set(r.value.memoryId, entry.memoryId);
      seeded += 1;
    }
  }

  // ── 2. 逐条查询并算指标 ──
  // ── 层规（裁定① / §10.3.2）──
  // 不再直调 Services 的 retriever.retrieve；改为**经 Core 层入口**驱动
  // （与 loop 的 ⑷ ContextAssembly 调用的是同一个函数 retrieveForContextAssembly）。
  // 端口包装内记录本次返回的命中 —— 这是"层下探针只用于监控"：读它返回什么不构成驱动。
  const retriever = createMemoryRetriever();
  const recorded: string[] = [];
  const searchPort: MemorySearchPortFn = async (query, limit) => {
    const res = await retriever.retrieve({ query, topK: limit, minScore: 0 });
    // retriever 失败/超时返回 err 而不是抛（回忆质量实验不应被单条失败中断）
    const fragments =
      res && typeof res === "object" && "ok" in res && res.ok
        ? res.value.fragments
        : [];
    const hits = fragments.map((f) => ({
      key: internalIdToMemoryId.get(f.id) ?? f.id,
      content: typeof f.content === "string" ? f.content : "",
    }));
    recorded.splice(0, recorded.length, ...hits.map((h) => h.key));
    return hits;
  };
  const rows: RetrievalSummary["queries"] = [];

  for (const q of golden.queries) {
    const topK = q.topK ?? 5;
    // 经 Core 入口驱动（返回值是上下文分区，此处不用；命中由 port 记录）
    await retrieveForContextAssembly(searchPort, q.query, topK);
    const returned = [...recorded];

    const expected = q.expected;
    let recallAtK: number | null = null;
    let reciprocalRank: number | null = null;
    if (expected.length > 0) {
      const hitRanks = expected
        .map((id) => returned.indexOf(id))
        .filter((idx) => idx >= 0)
        .map((idx) => idx + 1);
      recallAtK = hitRanks.length / expected.length;
      reciprocalRank = hitRanks.length > 0 ? 1 / Math.min(...hitRanks) : 0;
    }

    rows.push({
      id: q.id,
      query: q.query,
      topK,
      expected,
      returned,
      recallAtK,
      reciprocalRank,
    });
  }

  const scored = rows.filter((r) => r.recallAtK !== null);
  const meanRecall = scored.length
    ? scored.reduce((s, r) => s + (r.recallAtK ?? 0), 0) / scored.length
    : null;
  const mrr = scored.length
    ? scored.reduce((s, r) => s + (r.reciprocalRank ?? 0), 0) / scored.length
    : null;

  return {
    goldenSet: goldenSetRel,
    goldenVersion: golden.version,
    corpusSize: golden.corpus.length,
    seeded,
    queryCount: rows.length,
    scoredQueries: scored.length,
    k: 5,
    meanRecallAtK: meanRecall === null ? null : Number(meanRecall.toFixed(4)),
    mrr: mrr === null ? null : Number(mrr.toFixed(4)),
    queries: rows,
  };
}
