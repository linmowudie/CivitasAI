/**
 * S4 · 落盘通道 key 空间分区负向测试
 *
 * 设计出处：20-归属复核 §2 问题 1（快照有两个写者）· 24（版本记录）· 16 §4（落盘分区）
 * 纪律（25 §1）：负向用例必须**真实调用**，不得静态断言。
 */
import { describe, it, expect } from "vitest";

import {
  createCheckpointRouter,
  createMemoryCheckpointBackend,
  checkpointKey,
  parseCheckpointKey,
  componentCheckpointPort,
  conversationCheckpointPort,
  type CheckpointBackend,
} from "../../Src/Core/Durable/checkpointRouter.js";
import { ok, err } from "../../Src/Infra/types.js";

describe("S4 · 快照 key 空间分区", () => {
  it("键格式与解析：ckpt:<scope>:<ownerId>", () => {
    expect(checkpointKey("component", "c1")).toBe("ckpt:component:c1");
    expect(checkpointKey("conversation", "d1")).toBe("ckpt:conversation:d1");
    expect(parseCheckpointKey("ckpt:component:c1")).toEqual({
      scope: "component",
      ownerId: "c1",
    });
    expect(parseCheckpointKey("ckpt:bogus:c1")).toBeNull();
    expect(parseCheckpointKey("not-a-key")).toBeNull();
  });

  // ── 规则 1：一个 key 空间只有一个写者 ────────────────────
  it("【负向】同一 key 空间注册第二个不同写者 ⇒ 被拒", () => {
    const r = createCheckpointRouter(createMemoryCheckpointBackend());
    expect(r.registerWriter("component", "c1", "w1").ok).toBe(true);
    const second = r.registerWriter("component", "c1", "w2");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("拒绝第二个写者");
  });

  it("同一写者重复注册 ⇒ 幂等成功", () => {
    const r = createCheckpointRouter(createMemoryCheckpointBackend());
    expect(r.registerWriter("component", "c1", "w1").ok).toBe(true);
    expect(r.registerWriter("component", "c1", "w1").ok).toBe(true);
    expect(r.writersOf("component", "c1")).toEqual(["w1"]);
  });

  it("【负向】未注册写者直接写入 ⇒ 被拒", async () => {
    const r = createCheckpointRouter(createMemoryCheckpointBackend());
    const out = await r.save("component", "c1", "ghost", { a: 1 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("未注册写者");
  });

  it("【负向】非注册写者冒充写入 ⇒ 被拒", async () => {
    const r = createCheckpointRouter(createMemoryCheckpointBackend());
    r.registerWriter("conversation", "d1", "outer");
    const out = await r.save("conversation", "d1", "intruder", { a: 1 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("拒绝 intruder 写入");
  });

  // ── 规则 2：两空间永不冲突 ──────────────────────────────
  it("【负向】相同 ownerId 落在不同空间 ⇒ 互不覆盖，序列各自独立", async () => {
    const r = createCheckpointRouter(createMemoryCheckpointBackend());
    r.registerWriter("component", "same", "w-comp");
    r.registerWriter("conversation", "same", "w-conv");

    const a = await r.save("component", "same", "w-comp", {
      from: "component",
    });
    const b = await r.save("conversation", "same", "w-conv", {
      from: "conversation",
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) expect(a.value.key).toBe("ckpt:component:same");
    if (b.ok) expect(b.value.key).toBe("ckpt:conversation:same");
    // 两个空间的第一条记录序号都是 1（独立序列）
    if (a.ok) expect(a.value.sequence).toBe(1);
    if (b.ok) expect(b.value.sequence).toBe(1);

    const comp = await r.load("component", "same");
    const conv = await r.load("conversation", "same");
    expect(comp.ok && comp.value).toEqual({ from: "component" });
    expect(conv.ok && conv.value).toEqual({ from: "conversation" });
  });

  it("【负向】组件端口收到**非本空间**的键 ⇒ 拒绝（防跨空间污染）", async () => {
    const r = createCheckpointRouter(createMemoryCheckpointBackend());
    r.registerWriter("component", "c1", "w1");
    r.registerWriter("conversation", "d1", "w2");

    const port = componentCheckpointPort(r, "c1", "w1");
    const bad = await port.save(checkpointKey("conversation", "d1"), { x: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("非本空间键");

    // 正确键则成功
    const good = await port.save(checkpointKey("component", "c1"), { x: 1 });
    expect(good.ok).toBe(true);
  });

  it("【负向】对话端口同理：不得写入组件空间", async () => {
    const r = createCheckpointRouter(createMemoryCheckpointBackend());
    r.registerWriter("conversation", "d1", "outer");
    const port = conversationCheckpointPort(r, "d1", "outer");
    const bad = await port.save(checkpointKey("component", "c1"), { x: 1 });
    expect(bad.ok).toBe(false);
    const good = await port.save(checkpointKey("conversation", "d1"), { x: 1 });
    expect(good.ok).toBe(true);
  });

  // ── round-trip 与序列 ──────────────────────────────────
  it("round-trip：写入后可读回，且 load 取**最新**一条", async () => {
    const r = createCheckpointRouter(createMemoryCheckpointBackend());
    r.registerWriter("component", "c1", "w1");
    const s1 = await r.save("component", "c1", "w1", { step: 1 });
    const s2 = await r.save("component", "c1", "w1", { step: 2 });
    expect(s1.ok && s1.value.sequence).toBe(1);
    expect(s2.ok && s2.value.sequence).toBe(2);
    const loaded = await r.load("component", "c1");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toEqual({ step: 2 });
  });

  it("未写入过的空间 load 返回 null（不是错误）", async () => {
    const r = createCheckpointRouter(createMemoryCheckpointBackend());
    const loaded = await r.load("component", "never");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toBeNull();
  });

  // ── 规则 3：失败必须传播 ────────────────────────────────
  it("【负向】后端写入失败 ⇒ save 返回错误（绝不记假成功）", async () => {
    const failing: CheckpointBackend = {
      append: async () => err("磁盘满"),
      latest: async () => ok(null),
    };
    const r = createCheckpointRouter(failing);
    r.registerWriter("component", "c1", "w1");
    const out = await r.save("component", "c1", "w1", { a: 1 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("快照写入失败");
  });
});
