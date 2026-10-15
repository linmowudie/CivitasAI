/**
 * S2 · 压缩会话隔离：`_lowGain` / `_metrics` 必须**每次运行一份**。
 *
 * 缺陷（S1 盘点，2026-10-15）：
 *   `contextCompression.ts` 把「连续低增益计数」与「压缩计量累加器」放在**模块全局**，
 *   ⇒ 嵌套/并发的两层循环会**互相推进对方的计数器、并把计量混在一起**
 *   （后者直接违反"计量必须可归因"）。
 *
 * 纪律（Docs/Dev/L1编排设计/25 §1）：负向用例必须**真实调用**，不能只断言类型/引用相等。
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  createCompressionSession,
  maybeCompressContext,
  getCompactionMetrics,
  getSessionCompactionMetrics,
  resetSessionCompactionMetrics,
  resetCompactionMetrics,
  resetContextCompression,
} from "../../Src/Core/Loop/contextCompression.js";
import type { ChatMessage } from "../../Src/Core/Model/modelCaller.js";

const MSGS: ChatMessage[] = [
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好，有什么可以帮你" },
];

function input() {
  return {
    messages: [...MSGS],
    loopModel: "test-model",
    goal: "g",
    traceId: "trace-s2",
  };
}

describe("S2 · 压缩会话隔离", () => {
  beforeEach(() => {
    resetContextCompression();
    resetCompactionMetrics();
  });

  it("【负向·真实调用】带会话压缩时，计量只记在会话上，**不污染模块全局**", async () => {
    const session = createCompressionSession();
    const globalBefore = getCompactionMetrics().runs;

    await maybeCompressContext(input(), session);

    // 会话自己的计量增加了
    expect(getSessionCompactionMetrics(session).runs).toBeGreaterThan(0);
    // 全局计量**没有被这个会话写脏**（这正是缺陷所在：原先两者是同一个对象）
    expect(getCompactionMetrics().runs).toBe(globalBefore);
  });

  it("【负向】两个会话的计量互不影响（可分别归因）", async () => {
    const a = createCompressionSession();
    const b = createCompressionSession();

    await maybeCompressContext(input(), a);
    await maybeCompressContext(input(), a);
    await maybeCompressContext(input(), b);

    expect(getSessionCompactionMetrics(a).runs).toBe(2);
    expect(getSessionCompactionMetrics(b).runs).toBe(1);
  });

  it("【负向】重置一个会话不得影响另一个会话", async () => {
    const a = createCompressionSession();
    const b = createCompressionSession();
    await maybeCompressContext(input(), a);
    await maybeCompressContext(input(), b);

    resetSessionCompactionMetrics(a);

    expect(getSessionCompactionMetrics(a).runs).toBe(0);
    expect(getSessionCompactionMetrics(b).runs).toBeGreaterThan(0);
  });

  it("【负向】两个会话的低增益跟踪器是不同实例（互不推进）", () => {
    const a = createCompressionSession();
    const b = createCompressionSession();
    expect(a.lowGain).not.toBe(b.lowGain);
    expect(a.metrics).not.toBe(b.metrics);
  });

  it("【基线·记录缺陷成因】不传会话时仍写模块全局（兼容路径，故必须显式传会话）", async () => {
    const before = getCompactionMetrics().runs;
    await maybeCompressContext(input()); // 无 session → 走全局
    expect(getCompactionMetrics().runs).toBeGreaterThan(before);
  });
});
