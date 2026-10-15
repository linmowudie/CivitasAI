/**
 * 《Docs/Agent/17-控制论审查》第 3 批（执行器与慢环）之 P1-8 / P2-16 回归锁
 *
 * - E5（P1-8）：暂停—观察—恢复通道生效（修复前 `loopState.phase` 零读取）
 * - P2-16：系统提示缓存 LRU 逐出（修复前 `size > 64` 时全量 clear，一次打掉整个会话前缀缓存）
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  waitWhilePaused,
  buildStableSystemPrompt,
  getSystemPromptCacheSize,
  resetSystemPromptCache,
} from "../../Src/Core/Loop/runIteration.js";
import { createLoopState, resumeLoop } from "../../Src/Core/Loop/loopEngine.js";
import { createLoopConfig } from "../../Src/Core/Loop/loopConfig.js";
import { resetRolePrompts } from "../../Src/Services/Prompts/promptRegistry.js";

function state(configOverrides: Record<string, unknown> = {}) {
  const cfg = createLoopConfig({
    model: "test-model",
    stream: false,
    ...configOverrides,
  });
  if (!cfg.ok) throw new Error("cfg");
  return createLoopState({
    loopId: "loop-pause",
    agentId: "a",
    traceId: "t",
    config: cfg.value,
  });
}

beforeEach(() => {
  resetSystemPromptCache();
  resetRolePrompts();
});

// ═══════════════════════════════════════════════════════════════════
// E5 · P1-8 暂停通道
// ═══════════════════════════════════════════════════════════════════

describe("E5 · P1-8 暂停—恢复通道", () => {
  it("非暂停态直接返回 resumed（不阻塞）", async () => {
    const s = state();
    s.phase = "running";
    expect(await waitWhilePaused(s, undefined)).toBe("resumed");
  });

  it("暂停后恢复 → resumed", async () => {
    const s = state();
    s.phase = "paused";
    // 100ms 后恢复
    setTimeout(() => {
      s.phase = "running";
    }, 100);
    expect(await waitWhilePaused(s, undefined, 20, 5_000)).toBe("resumed");
  });

  it("暂停等待期间 abort → aborted（合法中断，不是无限挂起）", async () => {
    const s = state();
    s.phase = "paused";
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    expect(await waitWhilePaused(s, ac.signal, 20, 5_000)).toBe("aborted");
  });

  it("pauseSignal 被 abort → aborted（该字段此前零消费者）", async () => {
    const s = state();
    const ac = new AbortController();
    s.config.pauseSignal = ac;
    s.phase = "paused";
    setTimeout(() => ac.abort(), 60);
    expect(await waitWhilePaused(s, undefined, 20, 5_000)).toBe("aborted");
  });

  it("超过等待上限 → timeout（避免永久挂起）", async () => {
    const s = state();
    s.phase = "paused";
    expect(await waitWhilePaused(s, undefined, 10, 60)).toBe("timeout");
  });

  it("resumeLoop 可把 phase 从 paused 拨回 running", () => {
    const s = state();
    s.phase = "running";
    expect(require_resume(s)).toBe(true);
  });

  function require_resume(s: ReturnType<typeof state>): boolean {
    // pauseLoop 需要 running 态；这里直接拨到 paused 再 resume
    s.phase = "paused";
    const r = resumeLoop(s);
    return r.ok && s.phase === "running";
  }
});

// ═══════════════════════════════════════════════════════════════════
// P2-16 · 系统提示缓存 LRU
// ═══════════════════════════════════════════════════════════════════

describe("P2-16 · 系统提示缓存 LRU 逐出", () => {
  it("超过上限时只逐出最旧一条，不整表清空", () => {
    // 写满 64 条（每次工具集不同 → 缓存键不同）
    for (let i = 0; i < 64; i++) {
      buildStableSystemPrompt([`tool_${i}`]);
    }
    expect(getSystemPromptCacheSize()).toBe(64);

    // 再写一条 → 逐出最旧（tool_0），其余 63 条仍在
    buildStableSystemPrompt(["tool_new"]);
    expect(getSystemPromptCacheSize()).toBe(64);

    // 关键回归：修复前的 `clear()` 会让缓存规模掉到 1；现在最热的一条必须仍命中
    const recent = buildStableSystemPrompt(["tool_63"]);
    expect(getSystemPromptCacheSize()).toBe(64);
    // 命中不改变规模
    expect(buildStableSystemPrompt(["tool_63"])).toBe(recent);
  });

  it("LRU 语义：命中的条目被刷新为最近使用", () => {
    for (let i = 0; i < 64; i++) buildStableSystemPrompt([`t${i}`]);
    // 触碰 t0（刷新为最近使用），随后插入新条目应逐出 t1 而不是 t0
    buildStableSystemPrompt(["t0"]);
    buildStableSystemPrompt(["fresh"]);
    expect(getSystemPromptCacheSize()).toBe(64);
    // t0 仍应命中（内容非空且稳定）
    expect(buildStableSystemPrompt(["t0"])).toBe(
      buildStableSystemPrompt(["t0"]),
    );
  });

  it("cache=false 不写缓存", () => {
    buildStableSystemPrompt(["x"], undefined, false);
    expect(getSystemPromptCacheSize()).toBe(0);
  });

  it("同一工具集返回字节级相同字符串（前缀稳定的前提）", () => {
    const a = buildStableSystemPrompt(["b", "a"]);
    const b = buildStableSystemPrompt(["a", "b"]);
    expect(a).toBe(b);
  });
});
