/**
 * 《一些思考3》落实测试 —— 相关度五维评分（§4）
 *
 * 覆盖：五个维度的打分、权重档、加权总分、预算贪心填充与强制保留。
 * 全部确定性、零模型调用。
 */
import { describe, it, expect } from "vitest";

import {
  TEMPORAL_DECAY,
  WEIGHT_PROFILES,
  citationScore,
  computeRelevanceScores,
  defaultSemanticFn,
  partitionByRelevance,
  structuralScore,
  subtaskScore,
  temporalScore,
  type ContextChunk,
} from "../../Src/Core/Loop/relevanceScoring.js";

function chunk(
  over: Partial<ContextChunk> & { chunkId: string },
): ContextChunk {
  return {
    role: "user",
    content: "内容",
    tokens: 100,
    timestamp: 0,
    ...over,
  };
}

describe("一些思考3 · §4.2 单维打分", () => {
  it("结构重要性：system > 约束 > 结论 > user > tool > assistant > 其它", () => {
    expect(structuralScore(chunk({ chunkId: "a", role: "system" }))).toBe(1.0);
    expect(structuralScore(chunk({ chunkId: "b", isConstraint: true }))).toBe(
      0.95,
    );
    expect(
      structuralScore(chunk({ chunkId: "c", isConfirmedConclusion: true })),
    ).toBe(0.85);
    expect(structuralScore(chunk({ chunkId: "d", role: "user" }))).toBe(0.7);
    expect(structuralScore(chunk({ chunkId: "e", role: "tool" }))).toBe(0.5);
    expect(structuralScore(chunk({ chunkId: "f", role: "assistant" }))).toBe(
      0.4,
    );
    expect(structuralScore(chunk({ chunkId: "g", role: "other" }))).toBe(0.3);
  });

  it("时间衰减：exp(-0.3 × age)，越近越高；无时间轴时恒为 1", () => {
    expect(
      temporalScore(chunk({ chunkId: "a", timestamp: 10 }), 10),
    ).toBeCloseTo(1, 6);
    expect(
      temporalScore(chunk({ chunkId: "b", timestamp: 9 }), 10),
    ).toBeCloseTo(Math.exp(-TEMPORAL_DECAY), 6);
    expect(temporalScore(chunk({ chunkId: "c", timestamp: 0 }), 0)).toBe(1);
  });

  it("引用强度：入度 ×0.6 + 出度 ×0.3，封顶 1.0", () => {
    expect(citationScore(chunk({ chunkId: "a" }))).toBe(0);
    expect(
      citationScore(chunk({ chunkId: "b", referencedBy: ["x"] })),
    ).toBeCloseTo(0.6, 6);
    expect(
      citationScore(chunk({ chunkId: "c", referencesTo: ["x"] })),
    ).toBeCloseTo(0.3, 6);
    expect(
      citationScore(chunk({ chunkId: "d", referencedBy: ["x", "y", "z"] })),
    ).toBe(0.6 * 3 > 1 ? 1 : 1);
    expect(
      citationScore(chunk({ chunkId: "e", referencedBy: ["x", "y"] })),
    ).toBe(1);
  });

  it("子任务状态：活跃 1.0 / 已关闭 0.2 / 无归属 0.5", () => {
    const active = new Set(["sub-1"]);
    expect(
      subtaskScore(chunk({ chunkId: "a", subtaskId: "sub-1" }), active),
    ).toBe(1.0);
    expect(
      subtaskScore(chunk({ chunkId: "b", subtaskId: "sub-9" }), active),
    ).toBe(0.2);
    expect(subtaskScore(chunk({ chunkId: "c" }), active)).toBe(0.5);
  });

  it("§4.5 三套权重档各自和为 1.0", () => {
    for (const [name, w] of Object.entries(WEIGHT_PROFILES)) {
      const sum =
        w.semantic + w.structural + w.temporal + w.citation + w.subtask;
      expect(Math.abs(sum - 1), `${name} 权重和应为 1`).toBeLessThan(1e-9);
    }
    // 简单档：最近几轮主导
    expect(WEIGHT_PROFILES.simple.semantic).toBeGreaterThan(
      WEIGHT_PROFILES.complex.semantic,
    );
    expect(WEIGHT_PROFILES.simple.temporal).toBeGreaterThan(
      WEIGHT_PROFILES.complex.temporal,
    );
    // 缓存敏感档：结构权重最高
    expect(WEIGHT_PROFILES.cacheSensitive.structural).toBeGreaterThan(
      WEIGHT_PROFILES.complex.structural,
    );
  });
});

describe("一些思考3 · §4.3 加权总分", () => {
  it("总分等于五维加权和", () => {
    const c = chunk({
      chunkId: "a",
      role: "user",
      content: "登录接口实现",
      timestamp: 3,
    });
    const [score] = computeRelevanceScores("实现登录接口", [c], {
      weights: WEIGHT_PROFILES.complex,
    });
    expect(score).toBeDefined();
    const expected =
      WEIGHT_PROFILES.complex.semantic * score!.semantic +
      WEIGHT_PROFILES.complex.structural * score!.structural +
      WEIGHT_PROFILES.complex.temporal * score!.temporal +
      WEIGHT_PROFILES.complex.citation * score!.citation +
      WEIGHT_PROFILES.complex.subtask * score!.subtask;
    expect(score!.total).toBeCloseTo(expected, 9);
    expect(score!.keep).toBe(false);
  });

  it("默认语义层：与请求关键词重叠的片段得分更高", () => {
    const related = chunk({
      chunkId: "r",
      content: "登录接口的实现细节",
      timestamp: 1,
    });
    const unrelated = chunk({
      chunkId: "u",
      content: "无关的天气预报内容",
      timestamp: 1,
    });
    expect(defaultSemanticFn("实现登录接口", related.content)).toBeGreaterThan(
      defaultSemanticFn("实现登录接口", unrelated.content),
    );

    const scores = computeRelevanceScores("实现登录接口", [related, unrelated]);
    const byId = new Map(scores.map((s) => [s.chunkId, s]));
    expect(byId.get("r")!.total).toBeGreaterThan(byId.get("u")!.total);
  });

  it("可注入语义函数（§4.6 第 2/3 层 embedding / LLM 重排）", () => {
    const scores = computeRelevanceScores("q", [chunk({ chunkId: "a" })], {
      semanticFn: () => 1,
    });
    expect(scores[0]!.semantic).toBe(1);
  });

  it("语义函数返回越界值会被夹到 [0,1]", () => {
    const scores = computeRelevanceScores("q", [chunk({ chunkId: "a" })], {
      semanticFn: () => 99,
    });
    expect(scores[0]!.semantic).toBe(1);
  });
});

describe("一些思考3 · §4.3 预算填充与强制保留", () => {
  const chunks: ContextChunk[] = [
    chunk({
      chunkId: "c1",
      role: "user",
      content: "登录接口的实现细节",
      tokens: 100,
      timestamp: 0,
    }),
    chunk({
      chunkId: "c2",
      role: "assistant",
      content: "无关的其它内容",
      tokens: 100,
      timestamp: 1,
    }),
    chunk({
      chunkId: "c3",
      role: "system",
      content: "系统提示",
      tokens: 100,
      timestamp: 2,
    }),
    chunk({
      chunkId: "c4",
      role: "user",
      content: "必须保持兼容",
      tokens: 100,
      timestamp: 1,
      isConstraint: true,
    }),
  ];

  it("system 与用户约束被强制保留（不因时间衰减丢失，§4.7-3）", () => {
    const { keepIds } = partitionByRelevance("实现登录接口", chunks, {
      budgetTokens: 0,
      maxKeepRatio: 0.01,
    });
    expect(keepIds).toContain("c3");
    expect(keepIds).toContain("c4");
  });

  it("贪心按分数填充预算，低分片段被淘汰", () => {
    const { keepIds, evictIds } = partitionByRelevance("实现登录接口", chunks, {
      budgetTokens: 350,
      maxKeepRatio: 0.85,
      weights: WEIGHT_PROFILES.complex,
    });
    // 强制保留 c3/c4（200 tokens）→ 剩余预算只够 c1（语义相关）；c2 无关被淘汰
    expect(keepIds).toEqual(["c1", "c3", "c4"]);
    expect(evictIds).toEqual(["c2"]);
  });

  it("keep 标记与 keepIds 一致", () => {
    const { keepIds, scores } = partitionByRelevance("实现登录接口", chunks, {
      budgetTokens: 350,
      maxKeepRatio: 0.85,
    });
    const kept = scores
      .filter((s) => s.keep)
      .map((s) => s.chunkId)
      .sort();
    expect(kept).toEqual([...keepIds].sort());
  });

  it("maxKeepRatio 限制保留总量，防止「全留 = 没压」", () => {
    const { keepIds } = partitionByRelevance("实现登录接口", chunks, {
      budgetTokens: 10_000,
      maxKeepRatio: 0.55, // 上限 220 tokens < 2 条恢复性保留 + 强制 200
    });
    // 强制保留 c3/c4（200 tokens）= 上限内；其余一律不进
    expect(keepIds).toEqual(["c3", "c4"]);
  });

  it("minKeepTokens 在预算不足时保底保留", () => {
    const { keepIds } = partitionByRelevance(
      "实现登录接口",
      [chunks[0]!, chunks[1]!],
      {
        budgetTokens: 1,
        minKeepTokens: 150,
        maxKeepRatio: 1.0,
      },
    );
    expect(keepIds.length).toBeGreaterThan(0);
  });

  it("同分时选择顺序确定（按 chunkId 升序，与输入顺序无关）", () => {
    const a = chunk({
      chunkId: "b",
      role: "user",
      content: "同样的内容",
      timestamp: 1,
      tokens: 100,
    });
    const b = chunk({
      chunkId: "a",
      role: "user",
      content: "同样的内容",
      timestamp: 1,
      tokens: 100,
    });
    const options = { budgetTokens: 100, minKeepTokens: 0, maxKeepRatio: 0.5 };
    const forward = partitionByRelevance("q", [a, b], options);
    const backward = partitionByRelevance("q", [b, a], options);
    // 预算只够一条 → 两次都应挑中 id 更小的 'a'
    expect(forward.keepIds).toEqual(["a"]);
    expect(backward.keepIds).toEqual(["a"]);
    // 返回的 scores 保持输入顺序（不做重排）
    expect(
      partitionByRelevance("q", [a, b], options).scores.map((s) => s.chunkId),
    ).toEqual(["b", "a"]);
  });
});
