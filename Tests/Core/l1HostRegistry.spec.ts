/**
 * L1 宿主登记 + `agentId → 端口` 解析器
 *
 * 覆盖：`Docs/Dev/L1编排设计/07-分裂与自合并.md` §3 · `17-账本-子代与兄弟.md` §0/§5（反例 4 账本随快照落盘）·
 *   `28-设计实现覆盖清点.md` §6 G4（生产链路未装配的根因：身份是实例级的，端口容器是进程级的）
 *
 * 纪律：域账本/下级账本/兄弟端口都用**真实实现**，只有四个外部副作用（创建同级 L1 / 回收 /
 * 共享上下文 / 提交监管）是内存记录器 —— 它们本就由组合根提供。
 */
import { describe, it, expect } from "vitest";

import { ok, type Result } from "../../Src/Infra/types.js";
import {
  createChildRegistry,
  createDomainLedger,
  snapshotLedgers,
  type LedgerBundleSnapshot,
  type SharedContextSink,
} from "../../Src/Core/Ledger/ledgers.js";
import {
  createL1HostRegistry,
  createSplitMergePortForHosts,
  type SplitMergeRuntimeDeps,
} from "../../Src/Core/Orchestration/l1HostRegistry.js";

interface Rec {
  opened: string[];
}

function mkRuntime(rec: Rec): SplitMergeRuntimeDeps {
  const shared: SharedContextSink = {
    async publish(): Promise<Result<void>> {
      return ok(undefined);
    },
  };
  return {
    async openSiblingPeer(): Promise<Result<{ peerId: string }>> {
      const peerId = `sib-${rec.opened.length + 1}`;
      rec.opened.push(peerId);
      return ok({ peerId });
    },
    async abandonPeer(peerId): Promise<Result<void>> {
      const i = rec.opened.indexOf(peerId);
      if (i >= 0) rec.opened.splice(i, 1);
      return ok(undefined);
    },
    shared,
    async submitToRegulator(): Promise<Result<{ caseId: string }>> {
      return ok({ caseId: "case-1" });
    },
    now: () => 100,
    // 本文件只考「身份 → 私有端口」的解析与账本归属；分裂语义给最小可用桩
    hostAgentId: "agent-a",
    requestSplitApproval: () =>
      ok({ approvalId: "split-approval-stub", status: "pending" }),
    registerPeerSplit: () => {},
    mergeKind: () => "peer_merge",
  };
}

function emptySnapshot(agentId: string): LedgerBundleSnapshot {
  return snapshotLedgers(createChildRegistry(), createDomainLedger(agentId));
}

describe("createL1HostRegistry —— 身份与账本的归属", () => {
  it("open 缺省自建两本账，且域根就是 agentId", () => {
    const reg = createL1HostRegistry();
    const opened = reg.open({ agentId: "agent-prime-1" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(opened.value.domain.snapshot().rootId).toBe("agent-prime-1");
    expect(opened.value.children.snapshot()).toEqual({
      version: 0,
      children: [],
    });
    expect(reg.resolve("agent-prime-1")).toBe(opened.value);
    expect(reg.hostIds()).toEqual(["agent-prime-1"]);
  });

  it("【负向】空 agentId ⇒ 拒绝登记（解析键不能是空串）", () => {
    const reg = createL1HostRegistry();
    const bad = reg.open({ agentId: "   " });
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.error).toContain("不可为空");
    expect(reg.hostIds()).toEqual([]);
  });

  it("【负向】同一身份二次 open ⇒ 拒（不得双宿主），已登记的账本没被换掉", () => {
    const reg = createL1HostRegistry();
    const first = reg.open({ agentId: "agent-prime-1" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = reg.open({ agentId: "agent-prime-1" });
    expect(second.ok).toBe(false);
    expect(second.ok ? "" : second.error).toContain("不得挂两本账");

    expect(reg.hostIds()).toEqual(["agent-prime-1"]);
    expect(reg.resolve("agent-prime-1")).toBe(first.value);
  });

  it("【负向】域账本 rootId 与 agentId 不一致 ⇒ 登记时就拒（不留到运行时静默失效）", () => {
    const reg = createL1HostRegistry();
    const mismatch = reg.open({
      agentId: "agent-prime-1",
      domain: createDomainLedger("agent-prime-2"),
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.ok ? "" : mismatch.error).toContain("不一致");
    expect(mismatch.ok ? "" : mismatch.error).toContain("agent-prime-2");
    expect(reg.hostIds()).toEqual([]);
  });

  it("close 后身份消失：未登记的身份无从解析", () => {
    const reg = createL1HostRegistry();
    reg.open({ agentId: "agent-prime-1" });
    expect(reg.close("agent-prime-1").ok).toBe(true);
    expect(reg.resolve("agent-prime-1")).toBeUndefined();
    expect(reg.close("agent-prime-1").ok).toBe(false);
  });
});

describe("snapshotAll / reopen —— 账本随挂起快照落盘（17 反例 4）", () => {
  it("两宿主快照往返：身份、兄弟、版本号都原样回来", async () => {
    const rec: Rec = { opened: [] };
    const reg = createL1HostRegistry();
    const a = reg.open({ agentId: "agent-a" });
    const b = reg.open({ agentId: "agent-b" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok) return;

    const resolve = createSplitMergePortForHosts(reg, mkRuntime(rec));
    const portA = resolve("agent-a");
    expect(portA).toBeDefined();
    const split = await portA?.split({
      conflictDomain: "d-a",
      task: "A 的那一份",
    });
    expect(split?.ok).toBe(true);

    const snaps = reg.snapshotAll();
    expect(snaps).toHaveLength(2);

    const reg2 = createL1HostRegistry();
    const back = reg2.reopen(snaps);
    expect(back.ok).toBe(true);
    expect(back.ok ? back.value : 0).toBe(2);
    expect(reg2.hostIds()).toEqual(["agent-a", "agent-b"]);
    expect(reg2.resolve("agent-a")?.domain.peers()).toEqual(
      a.value.domain.peers(),
    );
    expect(reg2.resolve("agent-a")?.domain.snapshot().version).toBe(
      a.value.domain.snapshot().version,
    );
    expect(reg2.resolve("agent-b")?.domain.peers()).toEqual([]);
  });

  it("【负向】恢复到已有活体宿主 ⇒ 整批拒绝，且不留半套", () => {
    const reg = createL1HostRegistry();
    reg.open({ agentId: "agent-a" });
    const before = reg.resolve("agent-a")?.domain.snapshot();

    const batch = reg.reopen([
      emptySnapshot("agent-b"),
      emptySnapshot("agent-a"),
    ]);
    expect(batch.ok).toBe(false);
    expect(batch.ok ? "" : batch.error).toContain("已在运行");
    // agent-b 排在前面也没被落位：拒绝半恢复
    expect(reg.hostIds()).toEqual(["agent-a"]);
    expect(reg.resolve("agent-a")?.domain.snapshot()).toEqual(before);
  });

  it("【负向】批内同一身份出现两次 ⇒ 整批拒", () => {
    const reg = createL1HostRegistry();
    const dup = reg.reopen([
      emptySnapshot("agent-a"),
      emptySnapshot("agent-a"),
    ]);
    expect(dup.ok).toBe(false);
    expect(dup.ok ? "" : dup.error).toContain("出现两次");
    expect(reg.hostIds()).toEqual([]);
  });

  it("【负向】域根为空的快照 ⇒ 整批拒", () => {
    const reg = createL1HostRegistry();
    const bad = reg.reopen([emptySnapshot("   ")]);
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.error).toContain("域根为空");
  });

  it("【负向】批内混入不自洽的域快照 ⇒ 整批拒，合法的排在前面也不落位（不做半恢复）", () => {
    const reg = createL1HostRegistry();
    const corrupt: LedgerBundleSnapshot = {
      children: { version: 0, children: [] },
      domain: {
        version: 1,
        rootId: "agent-x",
        selfState: "running",
        peers: [
          { peerId: "p1", state: "running", conflictDomain: "d-same" },
          { peerId: "p2", state: "running", conflictDomain: "d-same" },
        ],
        mergeRequests: [],
        dissolved: false,
      },
    };

    const batch = reg.reopen([emptySnapshot("agent-ok"), corrupt]);
    expect(batch.ok).toBe(false);
    expect(batch.ok ? "" : batch.error).toContain("agent-x");
    expect(reg.hostIds()).toEqual([]);
  });
});

describe("createSplitMergePortForHosts —— 每次现取，不交陈旧账本", () => {
  it("宿主 close ⇒ 解析为 undefined；reopen 后解析到的是**新**账本实例", async () => {
    const rec: Rec = { opened: [] };
    const reg = createL1HostRegistry();
    reg.open({ agentId: "agent-a" });
    const resolve = createSplitMergePortForHosts(reg, mkRuntime(rec));

    const split = await resolve("agent-a")?.split({
      conflictDomain: "d-a",
      task: "一份",
    });
    expect(split?.ok).toBe(true);
    expect(reg.resolve("agent-a")?.domain.peers()).toHaveLength(1);

    reg.close("agent-a");
    expect(resolve("agent-a")).toBeUndefined();
    expect(rec.opened).toHaveLength(1); // 回收由调用方负责，这里只证明解析器不再交出端口

    // 以"账本为空"的快照重开同一身份 ⇒ 端口必须指向重开后的账本，而不是旧实例
    const reopened = reg.reopen([emptySnapshot("agent-a")]);
    expect(reopened.ok).toBe(true);
    const view = resolve("agent-a")?.domainView();
    expect(view?.peers).toEqual([]);
    expect(view?.rootId).toBe("agent-a");
  });

  it("两个宿主的端口各写各域（解析器按身份绑定域账本）", async () => {
    const rec: Rec = { opened: [] };
    const reg = createL1HostRegistry();
    reg.open({ agentId: "agent-a" });
    reg.open({ agentId: "agent-b" });
    const resolve = createSplitMergePortForHosts(reg, mkRuntime(rec));

    const pa = resolve("agent-a");
    const pb = resolve("agent-b");
    await pa?.split({ conflictDomain: "d-a", task: "A 的一份" });
    await pb?.split({ conflictDomain: "d-a", task: "B 的一份" });

    expect(
      reg
        .resolve("agent-a")
        ?.domain.peers()
        .map((p) => p.conflictDomain),
    ).toEqual(["d-a"]);
    expect(
      reg
        .resolve("agent-b")
        ?.domain.peers()
        .map((p) => p.conflictDomain),
    ).toEqual(["d-a"]);
    expect(rec.opened).toHaveLength(2);
  });
});
