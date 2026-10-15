/**
 * S0 · 负向测试①：乐观锁版本冲突必须【拒写】—— Result 层即失败。
 *
 * 现状缺陷（已核实）：
 *   `writeGuard.interceptWrite` 检出冲突后返回 `ok({ success: false, conflict })`，
 *   `globalWorkspace.write` 在 L173-175 又 `return ok(guardResult.value)`，
 *   ⇒ **条目确实没写进去，但对外报告 `ok: true`**。
 *   任何检查 `result.ok` 的调用方都会把它当成成功（假绿）。
 *
 * 纪律（见 Docs/Dev/L1编排设计/25 §1）：负向用例必须**真实调用**，
 * 不能用"源码里有检查"充当验证。本测试在修复前**必须红**。
 *
 * 对应设计：13-ReAct跨切面约束 §6「乐观锁检出未拒写」· 25 §2 步 S0
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  write,
  resetGlobalWorkspace,
  getByTrace,
} from "../../Src/Services/SharedMemory/globalWorkspace.js";

const base = {
  key: "ctx:s0:optimistic-lock",
  contentType: "fact" as const,
  assertion: "observed" as const,
  traceId: "trace-s0",
  agentId: "agent-s0",
};

describe("S0 · 乐观锁版本冲突必须拒写", () => {
  beforeEach(() => {
    resetGlobalWorkspace();
  });

  it("首次写入成功（前置条件）", () => {
    const first = write({ ...base, content: "v1" });
    expect(first.ok).toBe(true);
  });

  it("【负向】陈旧 expectedVersion 的写入必须被拒绝（result.ok === false）", () => {
    const first = write({ ...base, content: "v1" });
    expect(first.ok).toBe(true);

    // 实际版本已到 1，却以 expectedVersion=0 写入 ⇒ 冲突
    const stale = write({
      ...base,
      agentId: "agent-s0-b",
      content: "v2",
      expectedVersion: 0,
    });

    // 修复前：返回 ok({success:false}) ⇒ 本断言失败（这就是"检出未拒写"）
    expect(stale.ok).toBe(false);
  });

  it("【负向】冲突时内容不得生效（不得出现 v2 条目）", () => {
    write({ ...base, content: "v1" });
    write({
      ...base,
      agentId: "agent-s0-b",
      content: "v2",
      expectedVersion: 0,
    });

    const entries = getByTrace(base.traceId);
    expect(entries.some((e) => e.content === "v2")).toBe(false);
  });
});
