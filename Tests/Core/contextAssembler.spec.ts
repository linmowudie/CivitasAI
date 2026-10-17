/**
 * S6 · ContextAssembler 负向测试（前缀稳定 + 三尺度）
 *
 * 用**真实** `ContextStore`（`Src/Services/Context/contextStore.ts`）实例，不需要任何桩件。
 * 设计出处：18-ContextAssembler.md · 13 §14/§15 · 03 §6（前缀 4 条 + 会话 3 条）
 */
import { describe, it, expect } from "vitest";

import { ContextStore } from "../../Src/Services/Context/contextStore.js";
import {
  createContextAssembler,
  BOUNDARY_KEY_DIALOGUE,
  BOUNDARY_KEY_COMPONENT,
  KEY_DIALOGUE_GOAL,
  type ContextSelector,
  type SectionSpec,
} from "../../Src/Core/Context/contextAssembler.js";
import { ok, err } from "../../Src/Infra/types.js";

const TOOLS = ["FileRead", "ToolSearch"];

function sel(sections: string[], recentTurns = 5): ContextSelector {
  return { sections, history: { recentTurns } };
}

function mk(now: () => number = () => 1000, pullMinIntervalMs = 30_000) {
  const store = new ContextStore();
  const asm = createContextAssembler({ store, now, pullMinIntervalMs });
  return { store, asm };
}

describe("S6 · 恒定区（前缀稳定第一条）", () => {
  it("【负向】恒定区漂移 ⇒ 拒绝（工具区一变则全部前缀失效）", () => {
    const { asm } = mk();
    expect(asm.applyConstantZone("SP-1", TOOLS).ok).toBe(true);
    const drift = asm.applyConstantZone("SP-1", [...TOOLS, "FileWrite"]);
    expect(drift.ok).toBe(false);
    if (!drift.ok) expect(drift.error).toContain("恒定区发生漂移");
  });

  it("【负向】同一内容重复写入 ⇒ 哈希一致（幂等）", () => {
    const { asm } = mk();
    const a = asm.applyConstantZone("SP-1", TOOLS);
    const b = asm.applyConstantZone("SP-1", [...TOOLS].reverse());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value.hash).toBe(b.value.hash);
  });

  it("【负向】工具区顺序不同但集合相同 ⇒ 视作同一恒定区（排序后再哈希）", () => {
    const { asm } = mk();
    const a = asm.applyConstantZone("SP", ["b", "a"]);
    const b = asm.applyConstantZone("SP", ["a", "b"]);
    expect(a.ok && b.ok).toBe(true);
  });

  it("【负向】同一 agent 内工具区不一致 ⇒ 拒绝（组件切换会破坏前缀）", () => {
    const { asm } = mk();
    expect(asm.assertToolZoneConsistent("h1").ok).toBe(true);
    expect(asm.assertToolZoneConsistent("h1").ok).toBe(true);
    const bad = asm.assertToolZoneConsistent("h2");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("工具区不一致");
  });
});

describe("S6 · 对话与组件边界（不清空、不拼接）", () => {
  it("【负向】开新对话**不得清空 store**：恒定区仍在，哈希不变", () => {
    const { store, asm } = mk();
    asm.applyConstantZone("SP", TOOLS);
    asm.putSection({
      key: "ctx:session:pref",
      content: "偏好A",
      changeFreq: 1,
      scope: "session",
    });
    asm.openDialogue({ dialogueId: "d2", goal: "新任务" });

    expect(store.get("ctx:zone:static")).toBeDefined();
    expect(store.get("ctx:zone:tools")).toBeDefined();
    expect(store.get("ctx:session:pref")?.content).toBe("偏好A");
    // 恒定区哈希未变 ⇒ 新对话第一次调用即命中
    const again = asm.applyConstantZone("SP", TOOLS);
    expect(again.ok).toBe(true);
  });

  it("【负向】开新对话只写边界键与对话级键，**不拼接上一对话的消息**", () => {
    const { store, asm } = mk();
    asm.applyConstantZone("SP", TOOLS);
    const before = store.toAppendMessages().length;
    asm.openDialogue({ dialogueId: "d1", goal: "G1" });
    after: {
      const keys = [BOUNDARY_KEY_DIALOGUE, KEY_DIALOGUE_GOAL];
      for (const k of keys) expect(store.get(k)).toBeDefined();
    }
    // 追加区只应因这两个键增加，且不含任何历史消息（历史不在 store 里）
    const after = store.toAppendMessages();
    expect(after.length).toBeGreaterThanOrEqual(before);
    expect(after.every((m) => typeof m.content === "string")).toBe(true);
  });

  it("【负向】组件切换**只写边界键**，不重置上下文", () => {
    const { store, asm } = mk();
    asm.applyConstantZone("SP", TOOLS);
    asm.putSection({
      key: "ctx:plan:steps",
      content: "步骤1",
      changeFreq: 5,
      scope: "dialogue",
    });
    asm.markComponentBoundary("comp-A");
    expect(store.get(BOUNDARY_KEY_COMPONENT)).toBeDefined();
    // 恒定区与既有回合段都还在
    expect(store.get("ctx:zone:static")).toBeDefined();
    expect(store.get("ctx:plan:steps")?.content).toBe("步骤1");
  });
});

describe("S6 · 可见子范围与排序", () => {
  it("【负向】声明了未注册的分区 ⇒ 拒绝", () => {
    const { asm } = mk();
    const out = asm.assemble(sel(["ctx:nope"]), {
      history: [],
      upstream: {},
      events: [],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("未注册的分区");
  });

  it("【负向】只给**声明**的子范围：未声明的分区不出现在结果里", () => {
    const { asm } = mk();
    asm.putSection({
      key: "ctx:a",
      content: "A",
      changeFreq: 1,
      scope: "session",
    });
    asm.putSection({
      key: "ctx:b",
      content: "B",
      changeFreq: 2,
      scope: "session",
    });
    const out = asm.assemble(sel(["ctx:a"]), {
      history: [],
      upstream: {},
      events: [],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.contextSections.map((s) => s.key)).toEqual(["ctx:a"]);
    expect(out.value.contextSections.some((s) => s.key === "ctx:b")).toBe(
      false,
    );
  });

  it("【负向】回合段按**变更频率升序**排列（稳定的在前）", () => {
    const { asm } = mk();
    // 故意先注册"易变"的，再注册"稳定"的
    asm.putSection({
      key: "ctx:volatile",
      content: "V",
      changeFreq: 9,
      scope: "component",
    });
    asm.putSection({
      key: "ctx:stable",
      content: "S",
      changeFreq: 1,
      scope: "session",
    });
    const out = asm.assemble(sel(["ctx:volatile", "ctx:stable"]), {
      history: [],
      upstream: {},
      events: [],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.contextSections.map((s) => s.key)).toEqual([
      "ctx:stable",
      "ctx:volatile",
    ]);
  });

  it("历史按 recentTurns 截断；'all' 全量", () => {
    const { asm } = mk();
    const history = [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
    ];
    const cut = asm.assemble(sel([], 2), { history, upstream: {}, events: [] });
    expect(cut.ok && cut.value.history.map((m) => m.content)).toEqual([
      "2",
      "3",
    ]);
    const all = asm.assemble(
      { sections: [], history: "all" },
      { history, upstream: {}, events: [] },
    );
    expect(all.ok && all.value.history.length).toBe(3);
  });
});

describe("S6 · 嵌套与拉取频率", () => {
  it("【负向】子件可见面 **等于**宿主全集 ⇒ 拒绝（嵌套退化）", () => {
    const { asm } = mk();
    const host = sel(["ctx:a", "ctx:b"]);
    expect(asm.assertSubsetOfHost(sel(["ctx:a", "ctx:b"]), host).ok).toBe(
      false,
    );
    expect(asm.assertSubsetOfHost(sel(["ctx:a"]), host).ok).toBe(true);
  });

  it("【负向】子件声明的分区**宿主没有** ⇒ 拒绝（越权可见）", () => {
    const { asm } = mk();
    const bad = asm.assertSubsetOfHost(
      sel(["ctx:a", "ctx:secret"]),
      sel(["ctx:a", "ctx:b"]),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("越权");
  });

  it("【负向】同一域**最小间隔内**二次拉取 ⇒ 拒绝（禁止每轮重拉）", async () => {
    let t = 1000;
    const { asm } = mk(() => t, 30_000);
    const reader = async () => ok([{ key: "shared:1", content: "x" }]);

    const first = await asm.pullShared("l1", reader);
    expect(first.ok).toBe(true);

    const second = await asm.pullShared("l1", reader); // 同一时刻
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("拉取过于频繁");

    // 推进时间越过间隔 ⇒ 允许
    t = 1000 + 30_001;
    const third = await asm.pullShared("l1", reader);
    expect(third.ok).toBe(true);
    if (third.ok)
      expect(third.value).toEqual([{ key: "shared:1", content: "x" }]);
  });

  it("【负向】读取失败必须传播（不静默返回空）", async () => {
    const { asm } = mk();
    const failing = async () => err("共享上下文不可用");
    const out = await asm.pullShared("coop", failing);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("共享上下文不可用");
  });

  it("不同域各自独立计时（l1 拉取不影响 system）", async () => {
    const { asm } = mk(() => 5000, 30_000);
    const reader = async () => ok([]);
    expect((await asm.pullShared("l1", reader)).ok).toBe(true);
    expect((await asm.pullShared("system", reader)).ok).toBe(true);
    expect((await asm.pullShared("l1", reader)).ok).toBe(false);
  });
});

describe("S6 · 诊断", () => {
  it("诊断可按变更频率报出顺序（供前缀命中分析）", () => {
    const { asm } = mk();
    asm.applyConstantZone("SP", TOOLS);
    const specs: SectionSpec[] = [
      { key: "ctx:vol", content: "v", changeFreq: 9, scope: "component" },
      { key: "ctx:fix", content: "f", changeFreq: 1, scope: "session" },
    ];
    for (const s of specs) asm.putSection(s);
    const d = asm.diagnostics();
    expect(d.constantHash).not.toBeNull();
    expect(d.order.indexOf("ctx:zone:static")).toBeLessThan(
      d.order.indexOf("ctx:fix"),
    );
    expect(d.order.indexOf("ctx:fix")).toBeLessThan(d.order.indexOf("ctx:vol"));
  });
});
