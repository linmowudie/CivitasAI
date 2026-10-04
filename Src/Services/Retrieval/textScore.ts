/**
 * @module Retrieval/textScore
 * @description
 * 文本相关性打分——检索的确定性打分基础（FE-058 实装）。
 *
 * 面向中英混合文本、无外部依赖（不调模型、不查库）：
 *  - 拉丁/数字词元（≥2 字符，小写化）；
 *  - CJK 字符 bigram（覆盖中文无空格分词场景；单字成词也保留）；
 *  - 综合分 = 覆盖率（query 词元命中比例，主）× 词频强度（命中词在文档中的饱和频次，辅）。
 *
 * 打分区间 [0, 1]：完全覆盖且词频充足 → 接近 1。
 */

/** 分词：拉丁词元 + CJK bigram（导出供检索与测试复用） */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // 拉丁/数字词元（下划线视为词内字符）
  for (const m of lower.matchAll(/[a-z0-9_]{2,}/g)) {
    tokens.push(m[0]);
  }

  // CJK 连续段 → bigram（单字段保留单字）
  const cjkRuns = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }

  return tokens;
}

/**
 * 文本相关性打分（确定性）。
 * @returns [0, 1]；query 或文档无语义词元时返回 0
 */
export function textRelevanceScore(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const docTokens = tokenize(text);
  if (docTokens.length === 0) return 0;

  // 文档词频
  const freq = new Map<string, number>();
  for (const t of docTokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  // query 去重后统计命中
  const uniqueQuery = [...new Set(queryTokens)];
  let hit = 0;
  let strengthSum = 0;
  for (const t of uniqueQuery) {
    const f = freq.get(t);
    if (!f) continue;
    hit++;
    strengthSum += f / (f + 2); // 饱和词频贡献（0..1）
  }
  if (hit === 0) return 0;

  const coverage = hit / uniqueQuery.length;
  const strengthAvg = strengthSum / hit;
  return Math.min(1, coverage * 0.75 + coverage * strengthAvg * 0.25);
}
