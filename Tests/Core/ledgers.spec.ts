/**
 * S5 · 账本负向测试（两本账、两个尺度）
 *
 * 设计出处：17-账本-子代与兄弟.md · 20 §2 问题 2（C1 只注入 ChildRegistry）· 裁定④（父不等兄弟）
 * 纪律（25 §1）：负向用例必须**真实调用**。
 */
import { describe, it, expect } from "vitest";

import {
  createChildRegistry,
  createDomainLedger,
  snapshotLedgers,
  restoreLedgers,
  transferChildren,
  type SharedContextSink,
} from "../../Src/Core/Ledger/ledgers.js";
import { MAX_LIVE_SUBAGENTS_PER_TRACE } from "../../Src/Tools/Custom/agentRecruiter.js";
import { createLifecycleController } from "../../Src/Core/Lifecycle/lifecycleController.js";
import type { LifecycleCtx } from "../../Src/Core/Lifecycle/lifecycleTypes.js";
import { ok, err } from "../../Src/Infra/types.js";

function ctxWith(outstanding: string[]): LifecycleCtx {
  return {
    componentId: "comp",
    outstanding,
    produced: [],
    dependencySatisfied: true,
    budgetRemaining: 100,
    now: 0,
  };
}

describe("S5 · ChildRegistry（下级 join 账本）", () => {
  it("【负向】超过存活上限 ⇒ 拒绝登记（与工具层同一常量，不重复定义）", () => {
    const reg = createChildRegistry();
    for (let i = 0; i < MAX_LIVE_SUBAGENTS_PER_TRACE; i++) {
      expect(reg.register({ childId: "c" + i, joinedAt: 0 }).ok).toBe(true);
    }
    const overflow = reg.register({ childId: "c-overflow", joinedAt: 0 });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok)
      expect(overflow.error).toContain("上限 " + MAX_LIVE_SUBAGENTS_PER_TRACE);
    expect(reg.outstanding().length).toBe(MAX_LIVE_SUBAGENTS_PER_TRACE);
  });

  it("【负向】重复登记 / 重复结算 / 未登记结算 都被拒", () => {
    const reg = createChildRegistry();
    expect(reg.register({ childId: "c1", joinedAt: 0 }).ok).toBe(true);
    expect(reg.register({ childId: "c1", joinedAt: 1 }).ok).toBe(false);
    expect(reg.settle("ghost", "success", 2).ok).toBe(false);
    expect(reg.settle("c1", "success", 3).ok).toBe(true);
    expect(reg.settle("c1", "success", 4).ok).toBe(false);
  });

  it("【负向】子代超时 ⇒ expire 自动结算，**不得永远留在 outstanding**", () => {
    const reg = createChildRegistry();
    reg.register({ childId: "slow", joinedAt: 0, deadlineAt: 100 });
    reg.register({ childId: "fast", joinedAt: 0, deadlineAt: 10_000 });
    expect(reg.outstanding().sort()).toEqual(["fast", "slow"]);
    const expired = reg.expire(200);
    expect(expired).toEqual(["slow"]);
    expect(reg.outstanding()).toEqual(["fast"]);
    expect(reg.get("slow")?.outcome).toBe("timeout");
  });

  it("【负向】乐观版本：陈旧版本提交 ⇒ 被拒（防并发覆盖）", () => {
    const reg = createChildRegistry();
    const v0 = reg.version();
    expect(
      reg.commit(v0, () => {
        reg.register({ childId: "c1", joinedAt: 0 });
      }).ok,
    ).toBe(true);
    const stale = reg.commit(v0, () => {
      reg.register({ childId: "c2", joinedAt: 0 });
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toContain("版本冲突");
    expect(reg.get("c2")).toBeUndefined();
  });
});

describe("S5 · DomainLedger（兄弟收敛账本）", () => {
  it("【负向·关键】兄弟**不得**计入组件 outstanding ⇒ 父不等兄弟", async () => {
    const children = createChildRegistry();
    const domain = createDomainLedger("L1-root");
    domain.addPeer("peer-1", "domain-a");
    domain.addPeer("peer-2", "domain-b");

    // 兄弟在跑，但**没有下级** ⇒ 组件侧 outstanding 为空
    expect(children.outstanding()).toEqual([]);
    expect(children.quiescent()).toBe(true);

    // 集成：LifecycleController 在"无下级"时允许 terminate（兄弟不参与该判定）
    const controller = createLifecycleController({
      askModel: async () => ({ next: "terminate" }),
    });
    expect(controller.ok).toBe(true);
    if (!controller.ok) return;
    const legal = controller.value.legalFor(
      "iteration.exited",
      ctxWith(children.outstanding()),
    );
    expect([...legal]).toEqual(["terminate"]);
    const out = await controller.value.onEvent(
      "iteration.exited",
      ctxWith(children.outstanding()),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.next).toBe("terminate");
  });

  it("【负向】域在**兄弟未收敛**时不得宣布完成", () => {
    const domain = createDomainLedger("L1-root");
    domain.addPeer("peer-1", "domain-a");
    domain.setSelfState("done");
    expect(domain.domainQuiescent()).toBe(false); // 兄弟仍在跑
    domain.peerSettled("peer-1");
    expect(domain.domainQuiescent()).toBe(true);
  });

  it("【负向】自我登记为兄弟 / 重复登记兄弟 / 结算未登记兄弟 都被拒", () => {
    const domain = createDomainLedger("root");
    expect(domain.addPeer("root", "d").ok).toBe(false);
    expect(domain.addPeer("p1", "d").ok).toBe(true);
    expect(domain.addPeer("p1", "d").ok).toBe(false);
    expect(domain.peerSettled("ghost").ok).toBe(false);
  });

  it("【负向】空冲突域 ⇒ 账本自己拒（不靠工具形状校验兜底）；同域两兄弟也拒", () => {
    const domain = createDomainLedger("root");
    const blank = domain.addPeer("p1", "   ");
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error).toContain("冲突域不可为空");
    expect(domain.peers()).toHaveLength(0);
    expect(domain.version()).toBe(0); // 被拒不留下任何痕迹

    expect(domain.addPeer("p1", " d-a ").ok).toBe(true);
    expect(domain.conflictDomainOf("p1")).toBe("d-a"); // 登记值已归一
    const sameDomain = domain.addPeer("p2", "d-a");
    expect(sameDomain.ok).toBe(false);
    if (!sameDomain.ok) expect(sameDomain.error).toContain("已由兄弟 p1 持有");
  });

  it("【负向】乐观版本：陈旧版本提交 ⇒ 被拒", () => {
    const domain = createDomainLedger("root");
    const v0 = domain.version();
    expect(
      domain.commit(v0, () => {
        domain.addPeer("p1", "d");
      }).ok,
    ).toBe(true);
    const stale = domain.commit(v0, () => {
      domain.addPeer("p2", "d");
    });
    expect(stale.ok).toBe(false);
    expect(domain.peers().length).toBe(1);
  });

  it("【负向】兄弟进展**必须**投递共享上下文（否则永远触发不了自合并）", async () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "domain-a");
    let received: unknown = null;
    const sink: SharedContextSink = {
      publish: async (payload) => {
        received = payload;
        return ok(undefined);
      },
    };
    const out = await domain.publishToShared(sink);
    expect(out.ok).toBe(true);
    expect(received).toEqual({
      rootId: "root",
      selfState: "running",
      peers: [{ peerId: "p1", state: "running", conflictDomain: "domain-a" }],
    });
  });

  it("【负向】投递失败必须传播（不得静默）", async () => {
    const domain = createDomainLedger("root");
    const failing: SharedContextSink = {
      publish: async () => err("共享上下文不可用"),
    };
    const out = await domain.publishToShared(failing);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("共享上下文不可用");
  });

  it("冲突域可查（分区键用于共享上下文选址）", () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "domain-a");
    expect(domain.conflictDomainOf("p1")).toBe("domain-a");
    expect(domain.conflictDomainOf("nope")).toBeUndefined();
  });
});

describe("S5b · DomainLedger 自合并链路（请求 → 监管裁决）", () => {
  const req = (
    domain: ReturnType<typeof createDomainLedger>,
    over: Record<string, unknown> = {},
  ) =>
    domain.requestMerge({
      raisedById: "root",
      withPeerId: "p1",
      absorbedId: "p1",
      evidence: "共享上下文里两边都在改同一批文件",
      raisedAt: 100,
      ...over,
    });

  it("【负向】两个兄弟**不得同冲突域**（分裂的意义就是隔离）", () => {
    const domain = createDomainLedger("root");
    expect(domain.addPeer("p1", "write-src").ok).toBe(true);
    const dup = domain.addPeer("p2", "write-src");
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain("不得同域");
    expect(domain.peers().length).toBe(1);
  });

  it("【负向】请求的四项不变量都由账本守住，且**被拒不留下任何请求**", () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "d-a");

    expect(req(domain, { withPeerId: "ghost" }).ok).toBe(false); // 目标不在域内
    expect(req(domain, { raisedById: "ghost" }).ok).toBe(false); // 发起端不在域内
    expect(req(domain, { absorbedId: "someone-else" }).ok).toBe(false); // 被并方不是两端之一
    expect(req(domain, { evidence: "   " }).ok).toBe(false); // 空依据
    expect(req(domain, { evidence: "x".repeat(501) }).ok).toBe(false); // 依据过长
    expect(req(domain, { withPeerId: "root" }).ok).toBe(false); // 向自己请求
    expect(domain.mergeRequests()).toEqual([]);
  });

  it("【负向】requestMerge **只登记不合并**：域结构在裁决前一字不动", () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "d-a");
    const raised = req(domain);
    expect(raised.ok).toBe(true);
    expect(domain.peers().map((p) => p.peerId)).toEqual(["p1"]);
    expect(domain.dissolved()).toBe(false);
    expect(domain.mergeRequests()[0]?.settled).toBe(false);
  });

  it("【负向】同一对不得有两条未裁决请求；裁决后可再请求", () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "d-a");
    const first = req(domain);
    expect(first.ok).toBe(true);
    const again = req(domain);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("不得重复请求");

    // 反向发起也算同一对（合并是无向的）
    const mirror = req(domain, {
      raisedById: "p1",
      withPeerId: "root",
      absorbedId: "root",
    });
    expect(mirror.ok).toBe(false);

    const id = first.ok ? first.value.id : "";
    expect(
      domain.resolveMerge({
        id,
        resolution: "rejected",
        by: "regulator-1",
        at: 200,
      }).ok,
    ).toBe(true);
    expect(req(domain).ok).toBe(true);
  });

  it("【负向】resolveMerge 是唯一改域结构的动作：full ⇒ 被并方退出域", () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "d-a");
    domain.addPeer("p2", "d-b");
    const raised = req(domain);
    const id = raised.ok ? raised.value.id : "";

    // 未裁决时兄弟仍在域内
    expect(domain.peers().length).toBe(2);
    const done = domain.resolveMerge({
      id,
      resolution: "full",
      by: "regulator-1",
      at: 300,
    });
    expect(done.ok).toBe(true);
    expect(domain.peers().map((p) => p.peerId)).toEqual(["p2"]);
    expect(domain.dissolved()).toBe(false);
  });

  it("【负向】reassign / rejected **不改域结构**（转归是账本动作，不是成员变化）", () => {
    for (const resolution of ["reassign", "rejected"] as const) {
      const domain = createDomainLedger("root");
      domain.addPeer("p1", "d-a");
      const raised = req(domain);
      const id = raised.ok ? raised.value.id : "";
      expect(domain.resolveMerge({ id, resolution, by: "reg", at: 1 }).ok).toBe(
        true,
      );
      expect(domain.peers().map((p) => p.peerId)).toEqual(["p1"]);
      expect(domain.mergeRequests()[0]?.resolution).toBe(resolution);
    }
  });

  it("【负向】裁决不存在的 / 已裁决的 / 匿名的请求 ⇒ 全被拒", () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "d-a");
    expect(
      domain.resolveMerge({
        id: "mrg-404",
        resolution: "full",
        by: "reg",
        at: 1,
      }).ok,
    ).toBe(false);
    const raised = req(domain);
    const id = raised.ok ? raised.value.id : "";
    expect(
      domain.resolveMerge({ id, resolution: "full", by: "  ", at: 1 }).ok,
    ).toBe(false);
    expect(
      domain.resolveMerge({ id, resolution: "full", by: "reg", at: 1 }).ok,
    ).toBe(true);
    expect(
      domain.resolveMerge({ id, resolution: "full", by: "reg", at: 2 }).ok,
    ).toBe(false);
  });

  it("【负向】完全合并吞掉**本域根** ⇒ 账本作废，此后一切写入被拒（不假装能重定根）", () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "d-a");
    const raised = req(domain, { absorbedId: "root" });
    const id = raised.ok ? raised.value.id : "";
    expect(
      domain.resolveMerge({ id, resolution: "full", by: "reg", at: 1 }).ok,
    ).toBe(true);
    expect(domain.dissolved()).toBe(true);

    expect(domain.addPeer("p2", "d-b").ok).toBe(false);
    expect(domain.setSelfState("done").ok).toBe(false);
    expect(domain.peerSettled("p1").ok).toBe(false);
    expect(req(domain, { withPeerId: "p1" }).ok).toBe(false);
    // 兄弟仍未收敛 ⇒ 作废的账本不得谎报域已完成
    expect(domain.domainQuiescent()).toBe(false);
  });

  it("【负向】withdrawMerge：未裁决可撤（净零），已裁决不可撤", () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "d-a");
    const raised = req(domain);
    const id = raised.ok ? raised.value.id : "";
    expect(domain.withdrawMerge("mrg-404").ok).toBe(false);
    expect(domain.withdrawMerge(id).ok).toBe(true);
    expect(domain.mergeRequests()).toEqual([]);
    expect(req(domain).ok).toBe(true); // 撤完可以再提
    const settledId = domain.mergeRequests()[0]?.id ?? "";
    domain.resolveMerge({
      id: settledId,
      resolution: "rejected",
      by: "reg",
      at: 1,
    });
    expect(domain.withdrawMerge(settledId).ok).toBe(false);
  });

  it("裁决必须署名并留时间（审计要能归因）", () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "d-a");
    const raised = req(domain);
    const id = raised.ok ? raised.value.id : "";
    domain.resolveMerge({
      id,
      resolution: "reassign",
      by: "regulator-9",
      at: 777,
    });
    const rec = domain.mergeRequests()[0];
    expect(rec?.resolvedBy).toBe("regulator-9");
    expect(rec?.resolvedAt).toBe(777);
    expect(rec?.settled).toBe(true);
  });
});

describe("S5c · 归属转换（transferChildren：子代转归另一方）", () => {
  it("正向：转出侧不再阻塞、转入侧重新阻塞，产物随迁", () => {
    const from = createChildRegistry();
    const to = createChildRegistry();
    from.register({
      childId: "c1",
      joinedAt: 10,
      deadlineAt: 500,
      producedRefs: ["file:a.ts"],
    });

    const v0f = from.version();
    const v0t = to.version();
    const out = transferChildren({
      from,
      to,
      childIds: ["c1"],
      expectedFromVersion: v0f,
      expectedToVersion: v0t,
      at: 20,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.transferred).toEqual(["c1"]);

    expect(from.outstanding()).toEqual([]); // 对原父而言不再是它的下级
    expect(from.get("c1")?.outcome).toBe("abandoned");
    expect(to.outstanding()).toEqual(["c1"]); // 新父必须等它收敛
    expect(to.get("c1")?.deadlineAt).toBe(500);
    expect(to.get("c1")?.joinedAt).toBe(10);
    expect(to.get("c1")?.producedRefs).toEqual(["file:a.ts"]);
  });

  it("【负向】空清单 / 已结算 / 不在转出账本 / 目标已有同名 ⇒ 全拒且**两本账都没动**", () => {
    const from = createChildRegistry();
    const to = createChildRegistry();
    from.register({ childId: "c1", joinedAt: 0 });
    from.register({ childId: "done", joinedAt: 0 });
    from.settle("done", "success", 1);
    to.register({ childId: "dup", joinedAt: 0 });

    const v0f = from.version();
    const v0t = to.version();
    const attempts = [[], ["done"], ["ghost"], ["dup"], ["c1", "c1"]];
    for (const childIds of attempts) {
      const out = transferChildren({
        from,
        to,
        childIds,
        expectedFromVersion: v0f,
        expectedToVersion: v0t,
        at: 5,
      });
      expect(out.ok).toBe(false);
    }
    expect(from.outstanding().sort()).toEqual(["c1"]);
    expect(to.outstanding()).toEqual(["dup"]);
    expect(from.version()).toBe(v0f);
    expect(to.version()).toBe(v0t);
  });

  it("【负向】转入后超出存活上限 ⇒ 整批拒绝，不留半转移", () => {
    const from = createChildRegistry({ maxLive: 8 });
    const to = createChildRegistry({ maxLive: 2 });
    from.register({ childId: "c1", joinedAt: 0 });
    from.register({ childId: "c2", joinedAt: 0 });
    to.register({ childId: "t1", joinedAt: 0 });

    const out = transferChildren({
      from,
      to,
      childIds: ["c1", "c2"],
      expectedFromVersion: from.version(),
      expectedToVersion: to.version(),
      at: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("超出上限");
    expect(from.outstanding().sort()).toEqual(["c1", "c2"]);
    expect(to.outstanding()).toEqual(["t1"]);
  });

  it("【负向】任一侧版本陈旧 ⇒ 拒（并发覆盖防线）", () => {
    const from = createChildRegistry();
    const to = createChildRegistry();
    from.register({ childId: "c1", joinedAt: 0 });
    to.register({ childId: "t1", joinedAt: 0 });

    const staleFrom = transferChildren({
      from,
      to,
      childIds: ["c1"],
      expectedFromVersion: 0,
      expectedToVersion: to.version(),
      at: 1,
    });
    expect(staleFrom.ok).toBe(false);
    if (!staleFrom.ok) expect(staleFrom.error).toContain("转出账本版本冲突");

    const staleTo = transferChildren({
      from,
      to,
      childIds: ["c1"],
      expectedFromVersion: from.version(),
      expectedToVersion: 0,
      at: 1,
    });
    expect(staleTo.ok).toBe(false);
    if (!staleTo.ok) expect(staleTo.error).toContain("转入账本版本冲突");
    expect(from.outstanding()).toEqual(["c1"]);
    expect(to.outstanding()).toEqual(["t1"]);
  });

  it("【负向】两侧是同一本账 ⇒ 拒", () => {
    const reg = createChildRegistry();
    reg.register({ childId: "c1", joinedAt: 0 });
    const out = transferChildren({
      from: reg,
      to: reg,
      childIds: ["c1"],
      expectedFromVersion: reg.version(),
      expectedToVersion: reg.version(),
      at: 1,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("同一本账");
  });
});

describe("S5 · 账本快照往返", () => {
  it("snapshot → restore：未收敛/已收敛/兄弟状态都保住", () => {
    const children = createChildRegistry();
    children.register({ childId: "c1", joinedAt: 10, deadlineAt: 999 });
    children.register({ childId: "c2", joinedAt: 11 });
    children.settle("c2", "success", 20);

    const domain = createDomainLedger("root");
    domain.addPeer("p1", "domain-a");
    domain.setSelfState("waiting");

    const snap = snapshotLedgers(children, domain);
    const restoredResult = restoreLedgers(snap);
    expect(restoredResult.ok).toBe(true);
    if (!restoredResult.ok) return;
    const restored = restoredResult.value;

    expect(restored.children.outstanding()).toEqual(["c1"]);
    expect(restored.children.get("c1")?.deadlineAt).toBe(999);
    expect(restored.children.get("c2")?.outcome).toBe("success");
    expect(restored.domain.peers()).toEqual([
      { peerId: "p1", state: "running", conflictDomain: "domain-a" },
    ]);
    expect(restored.domain.snapshot().selfState).toBe("waiting");
    expect(restored.domain.domainQuiescent()).toBe(false);
  });

  it("【负向·反例 4】合并请求与裁决**必须**随快照往返（否则重启后无人知道在等谁）", () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "d-a");
    domain.addPeer("p2", "d-b");
    const first = domain.requestMerge({
      raisedById: "root",
      withPeerId: "p1",
      absorbedId: "p1",
      evidence: "两边都在改 src 目录",
      raisedAt: 10,
    });
    const firstId = first.ok ? first.value.id : "";
    domain.resolveMerge({ id: firstId, resolution: "full", by: "reg", at: 20 });
    domain.requestMerge({
      raisedById: "root",
      withPeerId: "p2",
      absorbedId: "root",
      evidence: "结论互斥",
      raisedAt: 30,
    });

    const snap = snapshotLedgers(createChildRegistry(), domain);
    const restoredResult = restoreLedgers(snap);
    expect(restoredResult.ok).toBe(true);
    if (!restoredResult.ok) return;
    const restored = restoredResult.value.domain;

    // full 的效果直接来自快照成员（p1 已被移出），历史引用已消失的兄弟也不会让恢复凭空失败
    expect(restored.peers().map((p) => p.peerId)).toEqual(["p2"]);
    const requests = restored.mergeRequests();
    expect(requests.length).toBe(2);
    const settled = requests.find((r) => r.id === firstId);
    expect(settled?.resolution).toBe("full");
    expect(settled?.resolvedBy).toBe("reg");
    expect(restored.mergeRequests().filter((r) => !r.settled).length).toBe(1);
    // 未裁决的重复请求保护在恢复后依然成立
    expect(
      restored.requestMerge({
        raisedById: "root",
        withPeerId: "p2",
        absorbedId: "root",
        evidence: "再提一次",
        raisedAt: 40,
      }).ok,
    ).toBe(false);
    // 版本号沿用快照 ⇒ 挂起前的陈旧写者恢复后仍会被拒
    expect(restored.version()).toBe(snap.domain.version);
  });

  it("【负向】不自洽的域快照 ⇒ **整体拒绝**，不做半恢复", () => {
    const children = createChildRegistry();
    children.register({ childId: "c1", joinedAt: 0 });
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "d-a");
    const raised = domain.requestMerge({
      raisedById: "root",
      withPeerId: "p1",
      absorbedId: "p1",
      evidence: "同一批文件",
      raisedAt: 1,
    });
    domain.resolveMerge({
      id: raised.ok ? raised.value.id : "",
      resolution: "reassign",
      by: "reg",
      at: 2,
    });
    const snap = snapshotLedgers(children, domain);

    // ① 无痕裁决（settled 却缺裁决人）
    const anonymous = {
      ...snap,
      domain: {
        ...snap.domain,
        mergeRequests: snap.domain.mergeRequests.map((r) => ({
          ...r,
          resolvedBy: "  ",
        })),
      },
    };
    const out1 = restoreLedgers(anonymous);
    expect(out1.ok).toBe(false);
    if (!out1.ok) expect(out1.error).toContain("不允许无痕裁决");

    // ② 两个兄弟同冲突域
    const sameDomain = {
      ...snap,
      domain: {
        ...snap.domain,
        peers: [
          { peerId: "p1", state: "running" as const, conflictDomain: "d-a" },
          { peerId: "p2", state: "running" as const, conflictDomain: "d-a" },
        ],
      },
    };
    const out2 = restoreLedgers(sameDomain);
    expect(out2.ok).toBe(false);
    if (!out2.ok) expect(out2.error).toContain("两个兄弟同时持有");

    // ③ 请求 id 重复
    const dupId = {
      ...snap,
      domain: {
        ...snap.domain,
        mergeRequests: [
          ...snap.domain.mergeRequests,
          { ...snap.domain.mergeRequests[0] },
        ],
      },
    };
    const out3 = restoreLedgers(dupId);
    expect(out3.ok).toBe(false);
    if (!out3.ok) {
      expect(out3.error).toContain("合并请求");
      expect(out3.error).toContain("重复");
    }
  });

  it("【负向】冲突域为空的兄弟快照 ⇒ 整体拒绝（恢复不得把非法登记带活）", () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "d-a");
    const snap = snapshotLedgers(createChildRegistry(), domain);
    const corrupted = {
      ...snap,
      domain: {
        ...snap.domain,
        peers: [
          { peerId: "p1", state: "running" as const, conflictDomain: "   " },
        ],
      },
    };
    const out = restoreLedgers(corrupted);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("冲突域为空");
  });

  it("作废状态往返：恢复后依然拒绝写入（不靠自觉）", () => {
    const domain = createDomainLedger("root");
    domain.addPeer("p1", "d-a");
    const raised = domain.requestMerge({
      raisedById: "root",
      withPeerId: "p1",
      absorbedId: "root",
      evidence: "合一",
      raisedAt: 1,
    });
    domain.resolveMerge({
      id: raised.ok ? raised.value.id : "",
      resolution: "full",
      by: "reg",
      at: 2,
    });
    expect(domain.dissolved()).toBe(true);

    const restoredResult = restoreLedgers(
      snapshotLedgers(createChildRegistry(), domain),
    );
    expect(restoredResult.ok).toBe(true);
    if (!restoredResult.ok) return;
    const restored = restoredResult.value.domain;
    expect(restored.dissolved()).toBe(true);
    expect(restored.addPeer("p2", "d-b").ok).toBe(false);
    expect(
      restored.requestMerge({
        raisedById: "root",
        withPeerId: "p1",
        absorbedId: "p1",
        evidence: "还想提",
        raisedAt: 3,
      }).ok,
    ).toBe(false);
  });
});
