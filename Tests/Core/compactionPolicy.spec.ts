/**
 * 《一些思考3》落实测试 —— 压缩决策层（§1 水位线 / §2 成本模型 / §3 难度分级 / §1.3 收益门槛）
 *
 * 纯函数为主，零 IO、零模型调用。
 */
import { describe, it, expect } from "vitest";

import {
  DEFAULT_COMPACTION_POLICY,
  LowGainTracker,
  classifyRequestComplexity,
  compactionGainRatio,
  decideCompaction,
  estimateCacheInvalidation,
  estimateCompactionCost,
  meetsGainGate,
  mergeCompactionPolicy,
  resolveCacheSensitivity,
  resolveProfile,
  resolveTailProtectTokens,
  type CompactionPolicyConfig,
} from "../../Src/Core/Loop/compactionPolicy.js";
import type { CompactionSignals } from "../../Src/Infra/Contracts/compactionTypes.js";

const CFG: CompactionPolicyConfig = DEFAULT_COMPACTION_POLICY;

function signals(over: Partial<CompactionSignals> = {}): CompactionSignals {
  return {
    complexity: "medium",
    usageRatio: 0,
    remainingTokens: 500_000,
    expectedNextGrowthTokens: 0,
    toolOutputTokens: 0,
    subtaskEnded: false,
    manualRequested: false,
    prefixHitRate: 0,
    ...over,
  };
}

describe("一些思考3 · §1 水位线与多级触发", () => {
  it("未达任何水位 → 不触发", () => {
    const d = decideCompaction(CFG, signals({ usageRatio: 0.2 }));
    expect(d.compact).toBe(false);
    expect(d.layer).toBe("none");
    expect(d.reason).toBe("below-watermark");
  });

  it("Light 水位 → 只做免费裁剪（micro 层）", () => {
    // 复杂档触发水位 0.82 > light 0.65 → 0.70 落在 Light 带内，只做免费裁剪
    const d = decideCompaction(
      CFG,
      signals({ complexity: "complex", usageRatio: 0.7 }),
    );
    expect(d.compact).toBe(true);
    expect(d.layer).toBe("micro");
    expect(d.reason).toBe("light-band");
  });

  it("子任务边界（§1.5）→ micro 层", () => {
    const d = decideCompaction(
      CFG,
      signals({ usageRatio: 0.1, subtaskEnded: true }),
    );
    expect(d.layer).toBe("micro");
    expect(d.reason).toBe("subtask-boundary");
  });

  it("High 水位 → auto 层强制压缩", () => {
    const d = decideCompaction(CFG, signals({ usageRatio: 0.92 }));
    expect(d.layer).toBe("auto");
    expect(d.reason).toBe("high-band");
  });

  it("溢出边缘 → emergency 层", () => {
    const d = decideCompaction(CFG, signals({ usageRatio: 0.97 }));
    expect(d.layer).toBe("emergency");
    expect(d.reason).toBe("overflow-band");
  });

  it("Manual 请求优先级最高", () => {
    const d = decideCompaction(
      CFG,
      signals({ usageRatio: 0.1, manualRequested: true }),
    );
    expect(d.layer).toBe("manual");
    expect(d.reason).toBe("manual-request");
  });

  it("剩余空间不足（§1.2）→ auto 层提前触发", () => {
    const d = decideCompaction(
      CFG,
      signals({ usageRatio: 0.3, remainingTokens: 1_000 }),
    );
    expect(d.layer).toBe("auto");
    expect(d.reason).toBe("low-headroom");
  });

  it("预期增长越界（§1.2）→ auto 层", () => {
    const d = decideCompaction(
      CFG,
      signals({
        usageRatio: 0.3,
        remainingTokens: 50_000,
        expectedNextGrowthTokens: 60_000,
      }),
    );
    expect(d.layer).toBe("auto");
    expect(d.reason).toBe("expected-growth-exceeds-headroom");
  });

  it("工具结果膨胀（§1.7）→ auto 层", () => {
    const d = decideCompaction(
      CFG,
      signals({
        usageRatio: 0.3,
        toolOutputTokens: CFG.toolOutputTokenLimit + 1,
      }),
    );
    expect(d.layer).toBe("auto");
    expect(d.reason).toBe("tool-output-bloat");
  });

  it("总开关关闭 → 不触发", () => {
    const disabled: CompactionPolicyConfig = { ...CFG, enabled: false };
    const d = decideCompaction(disabled, signals({ usageRatio: 0.99 }));
    expect(d.compact).toBe(false);
    expect(d.reason).toBe("disabled");
  });

  it("水位线四档严格递增", () => {
    const { light, main, high, overflow } = CFG.watermarks;
    expect(light).toBeLessThan(main);
    expect(main).toBeLessThanOrEqual(high);
    expect(high).toBeLessThanOrEqual(overflow);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

describe("一些思考3 · §3 难度分级", () => {
  it("难度档触发水位方向：简单更早压、复杂更晚压（§3.4/§6 叙述口径）", () => {
    expect(CFG.profiles.simple.triggerRatio).toBeLessThan(
      CFG.profiles.medium.triggerRatio,
    );
    expect(CFG.profiles.medium.triggerRatio).toBeLessThan(
      CFG.profiles.complex.triggerRatio,
    );
  });

  it("难度档尾部保护与缓存敏感度同步递增", () => {
    expect(CFG.profiles.simple.tailProtect).toBeLessThan(
      CFG.profiles.complex.tailProtect,
    );
    expect(CFG.profiles.simple.cacheSensitivity).toBe("low");
    expect(CFG.profiles.complex.cacheSensitivity).toBe("high");
    // 只有复杂档开启「高相关旧片段回插」
    expect(CFG.profiles.simple.promoteRelevant).toBe(false);
    expect(CFG.profiles.complex.promoteRelevant).toBe(true);
  });

  it("同一占用率下，简单档触发、复杂档不触发", () => {
    const simple = decideCompaction(
      CFG,
      signals({ complexity: "simple", usageRatio: 0.6 }),
    );
    const complex = decideCompaction(
      CFG,
      signals({ complexity: "complex", usageRatio: 0.6 }),
    );
    expect(simple.layer).toBe("auto");
    expect(complex.compact).toBe(false);
  });

  it("classifyRequestComplexity：短请求 → simple", () => {
    expect(classifyRequestComplexity("看看这个", { messageCount: 2 })).toBe(
      "simple",
    );
  });

  it("classifyRequestComplexity：长请求 + 工具链 → complex", () => {
    const long = "实现登录".repeat(120);
    expect(
      classifyRequestComplexity(long, { messageCount: 30, toolCallCount: 5 }),
    ).toBe("complex");
  });

  it("classifyRequestComplexity：约束关键词参与加分", () => {
    const withConstraints =
      "必须保留原有接口；不得修改数据库结构；要求最小改动";
    expect(
      classifyRequestComplexity(withConstraints, { messageCount: 10 }),
    ).toBe("medium");
  });

  it("resolveProfile / resolveTailProtectTokens / resolveCacheSensitivity", () => {
    expect(resolveProfile(CFG, "complex").triggerRatio).toBe(
      CFG.profiles.complex.triggerRatio,
    );
    // 100k 窗口 × 0.30 = 30000，与下限 8000 取大
    expect(resolveTailProtectTokens(CFG.profiles.complex, 100_000, 8_000)).toBe(
      30_000,
    );
    // 比例结果低于下限 → 取下限
    expect(resolveTailProtectTokens(CFG.profiles.simple, 10_000, 8_000)).toBe(
      8_000,
    );
    expect(resolveCacheSensitivity(CFG, "simple")).toBe("low");
  });
});

describe("一些思考3 · §2 成本模型", () => {
  it("缓存感知且只动尾部（deltaCache≈0）→ 压缩更划算", () => {
    const cost = estimateCompactionCost(CFG, {
      expectedNextGrowthTokens: 20_000,
      prefixHitRate: 0.9,
      cacheInvalidatedTokens: 0,
      overflowProbability: 0.05,
    });
    expect(cost.costCompact).toBeLessThan(cost.costNoCompact);
    expect(cost.shouldCompact).toBe(true);
  });

  it("压缩导致整段前缀失效 → 不如不压", () => {
    const cost = estimateCompactionCost(CFG, {
      expectedNextGrowthTokens: 1_000,
      prefixHitRate: 0.9,
      cacheInvalidatedTokens: 200_000,
      overflowProbability: 0,
    });
    expect(cost.shouldCompact).toBe(false);
  });

  it("缓存命中率越高，不压缩的边际成本越低", () => {
    const base = {
      expectedNextGrowthTokens: 10_000,
      cacheInvalidatedTokens: 0,
      overflowProbability: 0,
    };
    const hiHit = estimateCompactionCost(CFG, { ...base, prefixHitRate: 1 });
    const loHit = estimateCompactionCost(CFG, { ...base, prefixHitRate: 0 });
    expect(hiHit.costNoCompact).toBeLessThan(loHit.costNoCompact);
  });

  it("关闭缓存感知时按整段前缀失效计价", () => {
    const noCache: CompactionPolicyConfig = { ...CFG, cacheAware: false };
    const cost = estimateCompactionCost(noCache, {
      expectedNextGrowthTokens: 1_000,
      prefixHitRate: 1,
      cacheInvalidatedTokens: 0,
      overflowProbability: 0,
    });
    expect(cost.deltaCache).toBe(1_000 * CFG.cost.cachePrefillToLoadRatio);
  });

  it("缓存敏感度越高，允许失效的缓存越少（§2.3）", () => {
    const high = estimateCacheInvalidation("high", 100_000, 20_000);
    const medium = estimateCacheInvalidation("medium", 100_000, 20_000);
    const low = estimateCacheInvalidation("low", 100_000, 20_000);
    expect(high).toBeLessThan(medium);
    expect(medium).toBeLessThan(low);
  });
});

describe("一些思考3 · §1.3 收益门槛与低收益抑制", () => {
  it("compactionGainRatio / meetsGainGate", () => {
    expect(compactionGainRatio(1000, 400)).toBeCloseTo(0.6, 6);
    expect(compactionGainRatio(0, 10)).toBe(0);
    expect(meetsGainGate(CFG, 1000, 895)).toBe(true); // 10.5% → 达标
    expect(meetsGainGate(CFG, 1000, 950)).toBe(false); // 5% → 空转
    expect(meetsGainGate(CFG, 1000, 890)).toBe(true); // 11% → 达标
  });

  it("连续两次低收益后暂停自动压缩；一次高收益即复位", () => {
    const tracker = new LowGainTracker(CFG.maxConsecutiveLowGain);
    expect(tracker.shouldSuppress()).toBe(false);

    tracker.record(1000, 990, 0.1); // 1% < 10%
    expect(tracker.shouldSuppress()).toBe(false);
    expect(tracker.count).toBe(1);

    tracker.record(1000, 995, 0.1); // 0.5% < 10%
    expect(tracker.shouldSuppress()).toBe(true);

    tracker.record(1000, 500, 0.1); // 50% → 复位
    expect(tracker.shouldSuppress()).toBe(false);
    expect(tracker.count).toBe(0);
  });

  it("maxConsecutiveLowGain = 0 表示不抑制", () => {
    const tracker = new LowGainTracker(0);
    tracker.record(1000, 999, 0.1);
    tracker.record(1000, 999, 0.1);
    expect(tracker.shouldSuppress()).toBe(false);
  });
});

describe("一些思考3 · 配置深合并", () => {
  it("只覆盖显式给出的键，其余默认值保留", () => {
    const merged = mergeCompactionPolicy(CFG, {
      watermarks: { light: 0.5, main: 0.7, high: 0.9, overflow: 0.95 },
      profiles: {
        complex: {
          triggerRatio: 0.9,
          tailProtect: 0.4,
          cacheSensitivity: "high",
          promoteRelevant: true,
        },
      },
    });
    expect(merged.watermarks.light).toBe(0.5);
    expect(merged.minHeadroomTokens).toBe(CFG.minHeadroomTokens);
    expect(merged.profiles.complex.triggerRatio).toBe(0.9);
    // 未覆盖的难度档保持默认
    expect(merged.profiles.simple).toEqual(CFG.profiles.simple);
    expect(merged.cost).toEqual(CFG.cost);
  });
});
