/**
 * 兄弟账本链路的工具身份 —— `AgentSplit` / `AgentMerge` 接线测试
 *
 * 覆盖：`Docs/Dev/L1编排设计/07-分裂与自合并.md` §3（分裂→共享上下文→相关性→请求→监管批准）·
 *   `17-账本-子代与兄弟.md` §0/§3/§5（**反例 2** 兄弟不进下级账本、**反例 6** 域未收敛不得完成、
 *   **反例 7** 进展必须投递共享上下文）· `10-组件的三集合.md`（内层工具集含 split/merge）·
 *   `28-设计实现覆盖清点.md` G3
 *
 * 纪律（25 §1）：**负向用例必须真实调用**。本文件不 mock 域账本 ——
 * `createDomainLedger` / `createChildRegistry` 走真实实现，只有"创建同级 L1 / 回收 /
 * 共享上下文 / 提交监管"四个**外部副作用**端口换成可记录的内存端口（它们本就由组合根提供）。
 * 补偿分叉用例只把 `withdrawMerge` 的**返回值**改成 err（补偿动作本身会失败这件事，
 * 账本无法自己制造），其余判定仍在真账本上发生。
 *
 * 一条容易被忽略的接线约束在此显式化：`DomainLedger.requestMerge` 要求**发起端 ∈ {根, 兄弟}**，
 * 而工具把 `context.agentId` 作为发起端 —— 故组合根注入的域账本必须以**本 L1 的 agentId 为
 * rootId**（见 ROOT）。换掉 rootId 会让整片用例变红，这正是"工具身份 = 域成员"的证明。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  createDomainLedger,
  createChildRegistry,
  type DomainLedger,
  type ChildRegistry,
  type SharedContextSink,
} from "../../Src/Core/Ledger/ledgers.js";
import {
  createSplitMergeToolPort,
  type MergeRequestSubmission,
} from "../../Src/Core/Orchestration/splitMergeToolPort.js";
import { ok, err, type Result } from "../../Src/Infra/types.js";

import { agentSplit } from "../../Src/Tools/Custom/agentSplit.js";
import { agentMerge } from "../../Src/Tools/Custom/agentMerge.js";
import {
  configureToolServicePorts,
  resetToolServicePorts,
  type SplitMergePort,
} from "../../Src/Tools/Registry/toolServicePorts.js";
import { registerBuiltinTools } from "../../Src/Tools/builtinLoader.js";
import { getTool } from "../../Src/Tools/Registry/toolRegistry.js";
import { dispatchToolCall } from "../../Src/Tools/Registry/toolDispatcher.js";
import type { ToolResult } from "../../Src/Tools/Traits/toolSpec.js";

/** 本 L1 的 agentId 同时是域账本的根（见文件头说明） */
const ROOT = "agent-prime-1";

interface Fixture {
  readonly root: string;
  domain: DomainLedger;
  children: ChildRegistry;
  port: SplitMergePort;
  /** 已成功创建的同级 L1 */
  opened: string[];
  openFails: boolean;
  /** 被回收（补偿）的同级 L1 */
  abandoned: string[];
  abandonFails: boolean;
  /** 共享上下文收到的发布 */
  published: Array<{
    rootId: string;
    selfState: string;
    peers: Array<{ peerId: string }>;
  }>;
  publishFails: boolean;
  /** 监管收到的合并请求 */
  submitted: MergeRequestSubmission[];
  submitFails: boolean;
  /** 撤销补偿本身失败（⇒ 分叉上报分支） */
  withdrawFails: boolean;
}

function mkFixture(root: string = ROOT): Fixture {
  const domain = createDomainLedger(root);
  const children = createChildRegistry();
  let seq = 0;
  let clock = 100;

  const fx: Fixture = {
    root,
    domain,
    children,
    port: undefined as unknown as SplitMergePort,
    opened: [],
    openFails: false,
    abandoned: [],
    abandonFails: false,
    published: [],
    publishFails: false,
    submitted: [],
    submitFails: false,
    withdrawFails: false,
  };

  const shared: SharedContextSink = {
    async publish(payload): Promise<Result<void>> {
      if (fx.publishFails) return err("共享上下文通道不可用");
      fx.published.push({
        rootId: payload.rootId,
        selfState: payload.selfState,
        peers: payload.peers.map((p) => ({ peerId: p.peerId })),
      });
      return ok(undefined);
    },
  };

  /** 真账本，只让"撤销"这个补偿动作可失败（判定仍在真账本上） */
  const domainForPort: DomainLedger = {
    ...domain,
    withdrawMerge: (id) =>
      fx.withdrawFails
        ? err("撤销通道不可用（快照盘只读）")
        : domain.withdrawMerge(id),
  };

  fx.port = createSplitMergeToolPort({
    domain: domainForPort,
    async openSiblingPeer(): Promise<Result<{ peerId: string }>> {
      if (fx.openFails) return err("同级 L1 工厂不可用（预算已耗尽）");
      const peerId = `sib-${(seq += 1)}`;
      fx.opened.push(peerId);
      return ok({ peerId });
    },
    async abandonPeer(peerId): Promise<Result<void>> {
      if (fx.abandonFails) return err("回收接口超时");
      fx.abandoned.push(peerId);
      return ok(undefined);
    },
    shared,
    async submitToRegulator(req): Promise<Result<{ caseId: string }>> {
      if (fx.submitFails) return err("监管工单服务不可用");
      fx.submitted.push(req);
      return ok({ caseId: `case-${fx.submitted.length}` });
    },
    now: () => (clock += 1),
  });

  return fx;
}

let fx: Fixture;

beforeEach(() => {
  resetToolServicePorts();
  fx = mkFixture();
  configureToolServicePorts({
    splitMergeFor: (agentId) => (agentId === ROOT ? fx.port : undefined),
  });
});

afterEach(() => {
  resetToolServicePorts();
});

/** 工具执行上下文（split/merge 只依赖 agentId / agentRole / operationId） */
function toolCtx(overrides: Record<string, unknown> = {}): never {
  return {
    operationId: "op-1",
    agentId: ROOT,
    agentRole: "prime_director",
    traceId: "trace-1",
    ...overrides,
  } as never;
}

function codeOf(res: ToolResult): string {
  return res.error?.code ?? "";
}
function msgOf(res: ToolResult): string {
  return res.error?.message ?? "";
}
function payloadOf(res: ToolResult): Record<string, unknown> {
  return JSON.parse(String(res.content)) as Record<string, unknown>;
}
function detailsOf(res: ToolResult): Record<string, unknown> {
  return (res.error?.details ?? {}) as Record<string, unknown>;
}

/** 先真分裂一个兄弟，供 merge 侧用例复用 */
async function splitOne(conflictDomain = "d-src"): Promise<string> {
  const res = await agentSplit.execute(
    { conflictDomain, task: "独立负责这条隔离面" },
    toolCtx(),
  );
  expect(res.status).toBe("success");
  return String(payloadOf(res).peerId);
}

describe("AgentSplit / merge —— 端口未装配时诚实降级", () => {
  it("【负向】split 未注入端口 ⇒ NOT_ENABLED，且**未召唤任何同级 L1**、两本账一字未动", async () => {
    resetToolServicePorts();
    const beforeDomain = fx.domain.snapshot();
    const beforeChildren = fx.children.snapshot();

    const res = await agentSplit.execute(
      { conflictDomain: "d-src", task: "拆一份" },
      toolCtx(),
    );
    expect(res.status).toBe("error");
    expect(codeOf(res)).toBe("NOT_ENABLED");
    expect(msgOf(res)).toContain("未召唤任何同级 L1");
    expect(fx.opened).toHaveLength(0);
    expect(fx.domain.snapshot()).toEqual(beforeDomain);
    expect(fx.children.snapshot()).toEqual(beforeChildren);
  });

  it("【负向】merge 未注入端口 ⇒ NOT_ENABLED，且域里没有多出一条请求", async () => {
    resetToolServicePorts();
    const res = await agentMerge.execute(
      { withPeerId: "sib-1", evidence: "两边都在改同一个文件" },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("NOT_ENABLED");
    expect(msgOf(res)).toContain("未提交任何合并请求");
    expect(fx.domain.mergeRequests()).toHaveLength(0);
    expect(fx.submitted).toHaveLength(0);
  });
});

describe("splitMergeFor —— 身份即作用域（端口容器是进程级单例）", () => {
  /** 两个各自持有域账本的 L1 宿主，共用同一个解析器 */
  function twoHosts() {
    const a = mkFixture("agent-prime-1");
    const b = mkFixture("agent-prime-2");
    const ports: Record<string, SplitMergePort> = {
      [a.root]: a.port,
      [b.root]: b.port,
    };
    configureToolServicePorts({ splitMergeFor: (agentId) => ports[agentId] });
    return { a, b };
  }

  it("【负向】A 分裂只进 A 的域：B 的域账本、B 的同级 L1 工厂都没被碰", async () => {
    const { a, b } = twoHosts();

    const res = await agentSplit.execute(
      { conflictDomain: "d-a", task: "A 的那一份" },
      toolCtx(),
    );
    expect(res.status).toBe("success");

    expect(a.domain.peers().map((p) => p.conflictDomain)).toEqual(["d-a"]);
    expect(a.domain.snapshot().rootId).toBe(a.root);
    expect(a.published[0]?.rootId).toBe(a.root);

    expect(b.domain.peers()).toEqual([]);
    expect(b.domain.snapshot().version).toBe(0);
    expect(b.opened).toEqual([]);
    expect(b.published).toEqual([]);
    expect(b.children.snapshot()).toEqual({ version: 0, children: [] });
  });

  it("【负向】未登记为宿主的 agentId ⇒ NOT_ENABLED，两本账一字未动", async () => {
    const { a, b } = twoHosts();
    const beforeA = a.domain.snapshot();

    const res = await agentSplit.execute(
      { conflictDomain: "d-x", task: "无主的一次分裂" },
      toolCtx({ agentId: "agent-ghost-9" }),
    );
    expect(codeOf(res)).toBe("NOT_ENABLED");
    expect(msgOf(res)).toContain("agent-ghost-9");
    expect(msgOf(res)).toContain("未召唤任何同级 L1");

    expect(a.domain.snapshot()).toEqual(beforeA);
    expect(b.domain.peers()).toEqual([]);
    expect(a.opened).toEqual([]);
    expect(b.opened).toEqual([]);
  });

  it("B 以自己的身份请求合并 ⇒ 请求只登记进 B 的域、只出现在 B 的监管提交口", async () => {
    const { a, b } = twoHosts();
    await agentSplit.execute(
      { conflictDomain: "d-a", task: "A 的那一份" },
      toolCtx(),
    );
    const resB = await agentSplit.execute(
      { conflictDomain: "d-b", task: "B 的那一份" },
      toolCtx({ agentId: b.root }),
    );
    const peerInB = String(payloadOf(resB).peerId);

    const merge = await agentMerge.execute(
      { withPeerId: peerInB, evidence: "B 侧看到两边改同一个文件" },
      toolCtx({ agentId: b.root }),
    );
    expect(merge.status).toBe("success");

    expect(b.domain.mergeRequests().map((r) => r.raisedById)).toEqual([b.root]);
    expect(b.submitted).toHaveLength(1);
    // A 的域与提交口一字未动：端口不是共享的
    expect(a.domain.mergeRequests()).toEqual([]);
    expect(a.submitted).toEqual([]);
  });

  it("【负向】别域的兄弟 id 在本域请求合并 ⇒ 本域账本拒，也不给对方留下请求", async () => {
    const { a, b } = twoHosts();
    const resA = await agentSplit.execute(
      { conflictDomain: "d-a", task: "A 的那一份" },
      toolCtx(),
    );
    const peerInA = String(payloadOf(resA).peerId);

    const merge = await agentMerge.execute(
      { withPeerId: peerInA, evidence: "看到了同一个文件" },
      toolCtx({ agentId: b.root }),
    );
    expect(codeOf(merge)).toBe("INVALID_INPUT");
    expect(msgOf(merge)).toContain("未被登记");

    expect(b.domain.mergeRequests()).toHaveLength(0);
    expect(a.domain.mergeRequests()).toHaveLength(0);
    expect(a.submitted).toEqual([]);
    expect(b.submitted).toEqual([]);
  });
});

describe("AgentSplit —— 入参形状（每次 1 个，不触端口）", () => {
  it("【负向】缺 conflictDomain / 缺 task ⇒ INVALID_INPUT，同级 L1 一个都没创建", async () => {
    const noDomain = await agentSplit.execute({ task: "拆一份" }, toolCtx());
    expect(codeOf(noDomain)).toBe("INVALID_INPUT");
    expect(msgOf(noDomain)).toContain("conflictDomain");

    const noTask = await agentSplit.execute(
      { conflictDomain: "d-src" },
      toolCtx(),
    );
    expect(codeOf(noTask)).toBe("INVALID_INPUT");
    expect(msgOf(noTask)).toContain("task");

    const blank = await agentSplit.execute(
      { conflictDomain: "   ", task: "x" },
      toolCtx(),
    );
    expect(codeOf(blank)).toBe("INVALID_INPUT");

    expect(fx.opened).toHaveLength(0);
    expect(fx.domain.peers()).toHaveLength(0);
  });

  it("【负向】冲突域/任务超长 ⇒ 拒绝（一次只拆一份工作）", async () => {
    const longDomain = await agentSplit.execute(
      { conflictDomain: "d".repeat(121), task: "x" },
      toolCtx(),
    );
    expect(codeOf(longDomain)).toBe("INVALID_INPUT");
    expect(msgOf(longDomain)).toContain("conflictDomain 过长");

    const longTask = await agentSplit.execute(
      { conflictDomain: "d-src", task: "x".repeat(2001) },
      toolCtx(),
    );
    expect(codeOf(longTask)).toBe("INVALID_INPUT");
    expect(msgOf(longTask)).toContain("一次只拆一份");
    expect(fx.opened).toHaveLength(0);
  });

  it("★【负向·每次 1 个】spec 里没有批量入口，硬喂 `tasks` 数组也只召唤 1 个兄弟", async () => {
    const props = agentSplit.spec.inputSchema.properties as Record<
      string,
      unknown
    >;
    expect(Object.keys(props).sort()).toEqual(["conflictDomain", "task"]);
    expect(agentSplit.spec.inputSchema.additionalProperties).toBe(false);

    const res = await agentSplit.execute(
      {
        conflictDomain: "d-src",
        task: "合法的那一份",
        tasks: ["想拆 1", "想拆 2", "想拆 3", "想拆 4"],
      },
      toolCtx(),
    );
    expect(res.status).toBe("success");
    expect(fx.opened).toHaveLength(1);
    expect(fx.domain.peers()).toHaveLength(1);
  });

  it("【负向】绕过工具直连端口喂越界入参 ⇒ 账本自己拒（判定只有单一持有者）", async () => {
    const emptyDomain = await fx.port.split({
      conflictDomain: "",
      task: "空域也想分裂",
    });
    expect(emptyDomain.ok).toBe(true);
    if (emptyDomain.ok) {
      expect(emptyDomain.value.splitHappened).toBe(false);
      expect(emptyDomain.value.failure).toBe("domain_rejected");
    }
    expect(fx.domain.peers()).toHaveLength(0);
  });
});

describe("★ 反例 2 + 反例 6 + 反例 7 —— 兄弟不是下级（结构证明）", () => {
  it("分裂成功后：下级账本**一字未动**，兄弟只出现在域账本里", async () => {
    const before = fx.children.snapshot();
    const peerId = await splitOne();

    expect(fx.children.snapshot()).toEqual(before);
    expect(fx.children.outstanding()).toHaveLength(0);
    expect(fx.children.get(peerId)).toBeUndefined();
    expect(fx.domain.peers().map((p) => p.peerId)).toEqual([peerId]);
  });

  it("【负向·反例 6】兄弟未收敛 ⇒ 域不得宣布完成（子代侧 quiescent 为真，两者不可互替）", async () => {
    await splitOne();
    fx.domain.setSelfState("done");

    expect(fx.children.quiescent()).toBe(true);
    expect(fx.domain.domainQuiescent()).toBe(false);

    fx.domain.peerSettled("sib-1");
    expect(fx.domain.domainQuiescent()).toBe(true);
  });

  it("【反例 7】分裂必须把域进展投递共享上下文（否则自合并无从发现相关性）", async () => {
    await splitOne("d-auth");
    await splitOne("d-billing");

    expect(fx.published).toHaveLength(2);
    expect(fx.published[1]!.peers.map((p) => p.peerId)).toEqual([
      "sib-1",
      "sib-2",
    ]);
  });

  it("【负向】同冲突域的第二个兄弟被域账本拒绝 ⇒ 已创建的同级 L1 被回收，净零", async () => {
    await splitOne("d-src");
    const before = fx.domain.snapshot();

    const res = await agentSplit.execute(
      { conflictDomain: "d-src", task: "同域再拆一份" },
      toolCtx(),
    );
    expect(res.status).toBe("error");
    expect(codeOf(res)).toBe("INVALID_INPUT");
    expect(msgOf(res)).toContain("未召唤兄弟");
    expect(detailsOf(res).domain).toBeTruthy();

    expect(fx.domain.snapshot()).toEqual(before);
    expect(fx.abandoned).toEqual(["sib-2"]);
    expect(fx.published).toHaveLength(1); // 失败这次没有广播
  });

  it("【负向】同级 L1 工厂失败 ⇒ INTERNAL（不是模型能改的入参），域未登记", async () => {
    fx.openFails = true;
    const res = await agentSplit.execute(
      { conflictDomain: "d-src", task: "拆一份" },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INTERNAL");
    expect(msgOf(res)).toContain("分裂未发生");
    expect(fx.domain.peers()).toHaveLength(0);
    expect(fx.published).toHaveLength(0);
  });

  it("【负向】登记失败**且**回收也失败 ⇒ 如实上报分叉，不假装干净", async () => {
    await splitOne("d-src");
    fx.abandonFails = true;

    const res = await agentSplit.execute(
      { conflictDomain: "d-src", task: "同域再来" },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INTERNAL");
    expect(msgOf(res)).toContain("分裂失去控制");
    expect(msgOf(res)).toContain("需人工回收");
    expect(fx.abandoned).toHaveLength(0);
    expect(fx.domain.peers()).toHaveLength(1); // sib-2 既没进域也没被回收 —— 分叉已上报
  });

  it("广播失败 ⇒ 兄弟保留（回滚代价更高）+ 报出 peerId + republishShared 可补投", async () => {
    fx.publishFails = true;
    const res = await agentSplit.execute(
      { conflictDomain: "d-src", task: "拆一份" },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INTERNAL");
    expect(msgOf(res)).toContain("分裂部分完成");
    expect(detailsOf(res).peerId).toBe("sib-1");
    expect(fx.domain.peers()).toHaveLength(1);
    expect(fx.published).toHaveLength(0);

    fx.publishFails = false;
    const repair = await fx.port.republishShared();
    expect(repair.ok).toBe(true);
    expect(fx.published).toHaveLength(1);
  });
});

describe("AgentMerge —— 只请求合并，工具自己绝不合并", () => {
  it("成功提交 ⇒ merged=false，结构未动，请求停在待裁决", async () => {
    const peerId = await splitOne();
    const peersBefore = fx.domain.peers();

    const res = await agentMerge.execute(
      {
        withPeerId: peerId,
        evidence: "两边都在改 Src/Auth/session.ts",
        list: true,
      },
      toolCtx(),
    );
    expect(res.status).toBe("success");
    const payload = payloadOf(res);
    expect(payload.merged).toBe(false);
    expect(payload.submitted).toBe(true);
    expect(String(payload.requestId)).toBe("mrg-1");
    expect(String(payload.caseId)).toBe("case-1");
    expect(payload.by).toBe(ROOT);
    expect(
      (payload.domain as { pendingMergeRequests: number }).pendingMergeRequests,
    ).toBe(1);
    expect(payload.peers).toBeTruthy();

    expect(fx.domain.peers()).toEqual(peersBefore); // ← 工具没有改结构的能力
    expect(fx.domain.mergeRequests()[0]?.settled).toBe(false);
  });

  it("【负向】目标不在本域 ⇒ INVALID_INPUT，账本与监管都没收到东西", async () => {
    const res = await agentMerge.execute(
      { withPeerId: "ghost", evidence: "想和一个不在域里的合并" },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INVALID_INPUT");
    expect(msgOf(res)).toContain("未被登记");
    expect(fx.domain.mergeRequests()).toHaveLength(0);
    expect(fx.submitted).toHaveLength(0);
  });

  it("【负向】空目标不被当成「查看清单」的副作用路径 ⇒ INVALID_INPUT", async () => {
    const res = await agentMerge.execute(
      { withPeerId: "   ", evidence: "有依据", list: true },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INVALID_INPUT");
    expect(msgOf(res)).toContain("withPeerId");
    expect(detailsOf(res).domain).toBeTruthy();
    expect(fx.domain.mergeRequests()).toHaveLength(0);
  });

  it("【负向】依据必填：工具与域账本**两侧各自拦**（一处放宽另一处失效必须被发现）", async () => {
    const peerId = await splitOne();

    const noEvidence = await agentMerge.execute(
      { withPeerId: peerId },
      toolCtx(),
    );
    expect(codeOf(noEvidence)).toBe("INVALID_INPUT");
    expect(msgOf(noEvidence)).toContain("evidence");

    const blank = await agentMerge.execute(
      { withPeerId: peerId, evidence: "   " },
      toolCtx(),
    );
    expect(codeOf(blank)).toBe("INVALID_INPUT");

    const tooLong = await agentMerge.execute(
      { withPeerId: peerId, evidence: "x".repeat(501) },
      toolCtx(),
    );
    expect(codeOf(tooLong)).toBe("INVALID_INPUT");
    expect(msgOf(tooLong)).toContain("evidence 过长");
    expect(fx.submitted).toHaveLength(0);

    // 账本侧独立成立（不靠工具先拦）
    const viaPort = await fx.port.requestMerge({
      by: ROOT,
      withPeerId: peerId,
      evidence: "x".repeat(501),
    });
    expect(viaPort.ok).toBe(true);
    if (viaPort.ok) expect(viaPort.value.submitted).toBe(false);
    expect(fx.domain.mergeRequests()).toHaveLength(0);
  });

  it("★【负向】同一对不得有两条未裁决请求（工具路径）", async () => {
    const peerId = await splitOne();
    const first = await agentMerge.execute(
      { withPeerId: peerId, absorbedId: ROOT, evidence: "结论互斥" },
      toolCtx(),
    );
    expect(first.status).toBe("success");

    const dup = await agentMerge.execute(
      { withPeerId: peerId, absorbedId: ROOT, evidence: "再提一次" },
      toolCtx(),
    );
    expect(codeOf(dup)).toBe("INVALID_INPUT");
    expect(msgOf(dup)).toContain("未被登记");
    expect(fx.submitted).toHaveLength(1);
  });

  it("【负向】兄弟↔兄弟反向提也算同一对（判定在账本，工具无从绕开）", async () => {
    const p1 = await splitOne("d-auth");
    const p2 = await splitOne("d-billing");

    const first = await fx.port.requestMerge({
      by: p2,
      withPeerId: p1,
      evidence: "两边在改同一批文件",
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.submitted).toBe(true);

    const reversed = await fx.port.requestMerge({
      by: p1,
      withPeerId: p2,
      evidence: "换个方向再提",
    });
    expect(reversed.ok).toBe(true);
    if (reversed.ok) expect(reversed.value.failure).toBe("request_rejected");
    expect(fx.domain.mergeRequests()).toHaveLength(1);
  });

  it("【负向】被并方不是请求两端之一 ⇒ 账本拒（工具不复制该判定）", async () => {
    const peerId = await splitOne();
    const res = await agentMerge.execute(
      {
        withPeerId: peerId,
        absorbedId: "someone-else",
        evidence: "并一个第三方",
      },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INVALID_INPUT");
    expect(fx.domain.mergeRequests()).toHaveLength(0);
    expect(fx.submitted).toHaveLength(0);
  });

  it("提交监管失败 ⇒ 请求已撤销（净零，不留悬挂请求）⇒ INTERNAL", async () => {
    const peerId = await splitOne();
    const before = fx.domain.version();
    fx.submitFails = true;

    const res = await agentMerge.execute(
      { withPeerId: peerId, evidence: "两边重复劳动" },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INTERNAL");
    expect(msgOf(res)).toContain("未能提交监管");
    expect(msgOf(res)).toContain("已撤销");
    expect(fx.domain.mergeRequests()).toHaveLength(0);
    // 登记与撤销都是真实写入（版本 +2）⇒ 语义净零、痕迹不撒谎
    expect(fx.domain.version()).toBe(before + 2);
  });

  it("【负向】提交失败**且**撤销也失败 ⇒ err：如实上报存在悬挂请求", async () => {
    const peerId = await splitOne();
    fx.submitFails = true;
    fx.withdrawFails = true;

    const res = await agentMerge.execute(
      { withPeerId: peerId, evidence: "提交与撤销双失败" },
      toolCtx(),
    );
    expect(codeOf(res)).toBe("INTERNAL");
    expect(msgOf(res)).toContain("合并请求状态未知");
    expect(msgOf(res)).toContain("悬挂请求");
    expect(fx.domain.mergeRequests()).toHaveLength(1);
    expect(fx.domain.mergeRequests()[0]?.settled).toBe(false);
  });

  it("★ 改域结构的唯一入口是监管裁决：工具全程结构不动，resolveMerge 一落才减员", async () => {
    const peerId = await splitOne();
    const res = await agentMerge.execute(
      { withPeerId: peerId, evidence: "已确认两边是同一件事" },
      toolCtx(),
    );
    expect(res.status).toBe("success");
    expect(fx.domain.peers()).toHaveLength(1);

    const applied = fx.domain.resolveMerge({
      id: "mrg-1",
      resolution: "full",
      by: "reg",
      at: 200,
    });
    expect(applied.ok).toBe(true);
    expect(fx.domain.peers()).toHaveLength(0);
    expect(fx.domain.peers().map((p) => p.peerId)).not.toContain(peerId);

    const again = fx.domain.resolveMerge({
      id: "mrg-1",
      resolution: "full",
      by: "reg",
      at: 201,
    });
    expect(again.ok).toBe(false); // 重复裁决被拒
  });

  it("【负向】本域根被并入 ⇒ 账本作废 ⇒ 后续 split/merge 一律被拒且诚实报错", async () => {
    const peerId = await splitOne();
    const raised = await agentMerge.execute(
      { withPeerId: peerId, absorbedId: ROOT, evidence: "根并给兄弟" },
      toolCtx(),
    );
    expect(raised.status).toBe("success");
    fx.domain.resolveMerge({
      id: "mrg-1",
      resolution: "full",
      by: "reg",
      at: 200,
    });
    expect(fx.domain.dissolved()).toBe(true);

    const split = await agentSplit.execute(
      { conflictDomain: "d-new", task: "作废后还想拆" },
      toolCtx(),
    );
    expect(codeOf(split)).toBe("INVALID_INPUT");
    expect(msgOf(split)).toContain("未召唤兄弟");
    expect(fx.abandoned).toEqual(["sib-2"]); // 作废域下创建的同级 L1 仍被回收

    const merge = await agentMerge.execute(
      { withPeerId: peerId, evidence: "作废后还想提" },
      toolCtx(),
    );
    expect(merge.status).toBe("error");
    expect(fx.domain.mergeRequests()).toHaveLength(1); // 没有新增第二条
  });
});

describe("分裂/合并工具的角色可见性与派发", () => {
  beforeEach(() => {
    registerBuiltinTools();
  });

  it("两个工具都注册可查（兄弟账本链路的工具身份成立）", () => {
    expect(getTool("AgentSplit")).toBeTruthy();
    expect(getTool("AgentMerge")).toBeTruthy();
  });

  it("【负向】非 L1 入口角色经派发器调用 ⇒ ROLE_FORBIDDEN，且无任何副作用", async () => {
    const split = await dispatchToolCall({
      toolName: "AgentSplit",
      arguments: { conflictDomain: "d-src", task: "worker 想分裂" },
      context: toolCtx({ agentRole: "worker" }),
    });
    expect(codeOf(split.result)).toBe("ROLE_FORBIDDEN");
    expect(split.errorClass).toBe("DISPATCH_REJECTED");

    const merge = await dispatchToolCall({
      toolName: "AgentMerge",
      arguments: { withPeerId: "sib-1", evidence: "worker 想合并" },
      context: toolCtx({ agentRole: "worker" }),
    });
    expect(codeOf(merge.result)).toBe("ROLE_FORBIDDEN");
    expect(merge.errorClass).toBe("DISPATCH_REJECTED");

    expect(fx.opened).toHaveLength(0);
    expect(fx.domain.peers()).toHaveLength(0);
    expect(fx.submitted).toHaveLength(0);
  });

  it("★ 外层经**统一派发入口**真实走完 分裂 → 请求合并 闭环", async () => {
    const split = await dispatchToolCall({
      toolName: "AgentSplit",
      arguments: { conflictDomain: "d-auth", task: "独立负责认证这条隔离面" },
      context: toolCtx(),
      iteration: 4,
    });
    expect(split.result.status).toBe("success");
    expect(split.text).toContain("sib-1");

    const merged = await dispatchToolCall({
      toolName: "AgentMerge",
      arguments: {
        withPeerId: "sib-1",
        evidence: "共享上下文里两边都在改 session.ts",
      },
      context: toolCtx(),
      iteration: 5,
    });
    expect(merged.result.status).toBe("success");
    expect(payloadOf(merged.result).merged).toBe(false);

    expect(fx.domain.peers()).toHaveLength(1);
    expect(fx.domain.mergeRequests().filter((r) => !r.settled)).toHaveLength(1);
    expect(fx.submitted).toHaveLength(1);
    expect(fx.children.snapshot()).toEqual({ version: 0, children: [] }); // 反例 2 在派发链路上同样成立
  });
});
