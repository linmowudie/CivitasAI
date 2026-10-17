/**
 * @module Core/Ledger/ledgers
 * @description
 * **两本账，两个尺度，两个判据**。合成一本会让"父不等兄弟"失效。
 *
 * 设计出处：Docs/Dev/L1编排设计/17-账本-子代与兄弟.md · 20 §2 问题 1/2 · 06 · 07
 *
 * | 账本 | 记什么 | 回答什么 | 影响 |
 * |---|---|---|---|
 * | `ChildRegistry` | **下级**（recruit） | 这个**组件**能否 terminate | 合法集输入 |
 * | `DomainLedger` | **同级兄弟**（split） | 这个 **L1 域**算不算完成 | 外层判据 |
 *
 * 一条铁律：**ReAct 既不持有也不查询账本** —— 合法集本就在外部算（13 §17 归属表）。
 */

import { MAX_LIVE_SUBAGENTS_PER_TRACE } from "../../Tools/Custom/agentRecruiter.js";
import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

/** 子代结局（**必须有超时/放弃**，否则"永不收敛"） */
export type ChildOutcome = "success" | "failed" | "timeout" | "abandoned";

export interface ChildRecord {
  readonly childId: string;
  readonly joinedAt: number;
  readonly deadlineAt?: number;
  settledAt?: number;
  outcome?: ChildOutcome;
  producedRefs: string[];
}

/** 乐观版本：两个写者并发覆盖同一账本时必须被拒 */
export interface Versioned {
  version(): number;
  /** 版本不符 ⇒ 拒绝（防止并发覆盖） */
  commit(expectedVersion: number, mutate: () => void): Result<number>;
}

export interface ChildRegistrySnapshot {
  readonly version: number;
  readonly children: ChildRecord[];
}

export interface ChildRegistry extends Versioned {
  register(input: {
    childId: string;
    joinedAt: number;
    deadlineAt?: number;
    /** 子代已产出的引用（转归时随迁；缺省空） */
    producedRefs?: readonly string[];
  }): Result<void>;
  settle(childId: string, outcome: ChildOutcome, at: number): Result<void>;
  /** 未收敛子代 id（喂给 `default_legality` 的判定） */
  outstanding(): string[];
  quiescent(): boolean;
  get(childId: string): ChildRecord | undefined;
  /** 超时自动结算（防止子代超时后永远留在 outstanding） */
  expire(now: number): string[];
  /** 存活上限（转归等跨账本动作需要**前置**校验容量，避免半转移） */
  maxLive(): number;
  snapshot(): ChildRegistrySnapshot;
}

export function createChildRegistry(opts?: {
  maxLive?: number;
}): ChildRegistry {
  const maxLive = opts?.maxLive ?? MAX_LIVE_SUBAGENTS_PER_TRACE;
  const children = new Map<string, ChildRecord>();
  let ver = 0;

  function outstanding(): string[] {
    const out: string[] = [];
    for (const [id, rec] of children)
      if (rec.settledAt === undefined) out.push(id);
    return out;
  }

  return {
    version: () => ver,
    commit(expectedVersion, mutate) {
      if (expectedVersion !== ver) {
        return err(
          "账本版本冲突：期望 v" +
            expectedVersion +
            "，实际 v" +
            ver +
            "（拒绝并发覆盖）",
        );
      }
      mutate();
      ver += 1;
      return ok(ver);
    },

    register(input) {
      if (children.has(input.childId)) {
        return err("子代 " + input.childId + " 已登记（重复登记）");
      }
      if (outstanding().length >= maxLive) {
        // ★ 账本侧也要拦：不能只靠工具层
        return err(
          "已达存活子代上限 " + maxLive + "，拒绝登记 " + input.childId,
        );
      }
      children.set(input.childId, {
        childId: input.childId,
        joinedAt: input.joinedAt,
        ...(input.deadlineAt !== undefined
          ? { deadlineAt: input.deadlineAt }
          : {}),
        producedRefs: [...(input.producedRefs ?? [])],
      });
      ver += 1;
      return ok(undefined);
    },

    settle(childId, outcome, at) {
      const rec = children.get(childId);
      if (!rec) return err("未登记的子代 " + childId + "（不得凭空结算）");
      if (rec.settledAt !== undefined)
        return err("子代 " + childId + " 已结算（重复结算）");
      rec.settledAt = at;
      rec.outcome = outcome;
      ver += 1;
      return ok(undefined);
    },

    outstanding,
    quiescent: () => outstanding().length === 0,
    get: (childId) => children.get(childId),

    expire(now) {
      const expired: string[] = [];
      for (const [id, rec] of children) {
        if (rec.settledAt !== undefined) continue;
        if (rec.deadlineAt !== undefined && now >= rec.deadlineAt) {
          rec.settledAt = now;
          rec.outcome = "timeout";
          expired.push(id);
        }
      }
      if (expired.length > 0) ver += 1;
      return expired;
    },

    maxLive: () => maxLive,

    snapshot: () => ({
      version: ver,
      children: [...children.values()].map((c) => ({
        ...c,
        producedRefs: [...c.producedRefs],
      })),
    }),
  };
}

/** 域成员状态 */
export type DomainMemberState = "running" | "waiting" | "done";

/**
 * 监管对合并请求的裁决（裁定④）：
 * - `full` **完全合并** ⇒ 被并方退出域（两 agent 合一）
 * - `reassign` **归属转换** ⇒ 域结构不变，相关**子代**转归另一方（见 `transferChildren`）
 * - `rejected` ⇒ 不合并
 */
export type MergeResolution = "full" | "reassign" | "rejected";

export interface MergeRequestRecord {
  readonly id: string;
  /** 发起端（本域根或某个兄弟 —— 任一端都可发现相关性） */
  readonly raisedById: string;
  readonly withPeerId: string;
  /** 提议由谁被并入（只能是这两端之一） */
  readonly absorbedId: string;
  /** 相关性依据（来自共享上下文；空依据 ⇒ 拒绝，否则监管无从判定） */
  readonly evidence: string;
  readonly raisedAt: number;
  settled: boolean;
  resolution?: MergeResolution;
  resolvedBy?: string;
  resolvedAt?: number;
}

export interface DomainLedgerSnapshot {
  readonly version: number;
  readonly rootId: string;
  readonly selfState: DomainMemberState;
  readonly peers: Array<{
    peerId: string;
    state: DomainMemberState;
    conflictDomain: string;
  }>;
  readonly mergeRequests: MergeRequestRecord[];
  readonly dissolved: boolean;
}

/**
 * 恢复专用初始化（`restoreLedgers` 的落点）。
 *
 * 为什么历史记录**不走** `requestMerge`/`addPeer`：那两条路径校验的是"此刻的域成员"，
 * 而一段已裁决的历史，它引用的兄弟可能早已被后续裁决移出域；本域根被并入后账本又是作废态、
 * 守卫会拒掉恢复期的注入 —— 用活体不变量去审既成事实，恢复就会凭空失败（本模块实测踩过）。
 * 因此注入前由 `restoreLedgers` 做**完整性**校验（成员自洽、裁决署名齐备），
 * 校验通过才原样注入；作废态最后落，注入完成后账本对外表现与作废前一致（一律拒写）。
 */
export interface DomainLedgerInit {
  readonly peers?: ReadonlyArray<{
    peerId: string;
    state: DomainMemberState;
    conflictDomain: string;
  }>;
  readonly selfState?: DomainMemberState;
  readonly mergeRequests?: readonly MergeRequestRecord[];
  readonly dissolved?: boolean;
  /** 沿用快照版本号（恢复后陈旧写者仍会被拒） */
  readonly version?: number;
}

/** 共享上下文投递端口（供**自合并**判定；裁定④） */
export interface SharedContextSink {
  publish(payload: {
    rootId: string;
    selfState: DomainMemberState;
    peers: Array<{
      peerId: string;
      state: DomainMemberState;
      conflictDomain: string;
    }>;
  }): Promise<Result<void>>;
}

export interface DomainLedger extends Versioned {
  addPeer(
    peerId: string,
    conflictDomain: string,
    state?: DomainMemberState,
  ): Result<void>;
  peerSettled(peerId: string): Result<void>;
  setSelfState(state: DomainMemberState): Result<void>;
  /** 域完成判据：**所有**成员（含自己）都 done */
  domainQuiescent(): boolean;
  conflictDomainOf(peerId: string): string | undefined;
  peers(): Array<{
    peerId: string;
    state: DomainMemberState;
    conflictDomain: string;
  }>;
  /** 把域进展投递共享上下文 —— 不投递则**永远触发不了自合并** */
  publishToShared(sink: SharedContextSink): Promise<Result<void>>;

  /**
   * 发起合并请求（**只登记请求，不合并**）。
   * 拒绝条件：目标/发起端不在域内、`absorbedId` 不是这两端之一、空依据、同对已有未裁决请求。
   */
  requestMerge(input: {
    id?: string;
    raisedById: string;
    withPeerId: string;
    absorbedId: string;
    evidence: string;
    raisedAt: number;
  }): Result<{ id: string }>;
  /** 请求历史（含已裁决；只读副本） */
  mergeRequests(): MergeRequestRecord[];
  /** 撤销未裁决的请求（提交审批失败时的补偿动作，不留悬挂请求） */
  withdrawMerge(id: string): Result<void>;
  /**
   * 裁决合并请求 —— **本账本里唯一能改动域结构的动作**。
   * `full` ⇒ 被并方退出域；被并方若是本域根 ⇒ 本账本作废（不假装能重定根）。
   * 组件/工具都没有这个方法的调用权：调用方只能是监管裁决侧。
   */
  resolveMerge(input: {
    id: string;
    resolution: MergeResolution;
    by: string;
    at: number;
  }): Result<{ absorbedId: string }>;
  /** 本域根已被并入兄弟 ⇒ 账本作废，此后一切写入被拒 */
  dissolved(): boolean;

  snapshot(): DomainLedgerSnapshot;
}

export function createDomainLedger(
  rootId: string,
  init?: DomainLedgerInit,
): DomainLedger {
  let selfState: DomainMemberState = init?.selfState ?? "running";
  let isDissolved = false;
  const peers = new Map<
    string,
    { state: DomainMemberState; conflictDomain: string }
  >();
  const requests = new Map<string, MergeRequestRecord>();
  let seq = 0;
  let ver = 0;

  // 恢复注入（完整性由 `restoreLedgers` 校验后才走到这里）：成员 → 历史 → 作废态
  for (const p of init?.peers ?? []) {
    peers.set(p.peerId, { state: p.state, conflictDomain: p.conflictDomain });
    ver += 1;
  }
  for (const rec of init?.mergeRequests ?? []) {
    const match = /^mrg-(\d+)$/.exec(rec.id);
    seq = Math.max(seq, match ? Number(match[1]) : 0);
    requests.set(rec.id, { ...rec });
    ver += 1;
  }
  if (init?.dissolved === true) isDissolved = true;
  if (init?.version !== undefined) ver = init.version;

  const listPeers = (): DomainLedgerSnapshot["peers"] =>
    [...peers.entries()].map(([peerId, v]) => ({
      peerId,
      state: v.state,
      conflictDomain: v.conflictDomain,
    }));

  const listRequests = (): MergeRequestRecord[] =>
    [...requests.values()].map((r) => ({ ...r }));

  const dissolvedErr = () =>
    err(
      "域账本已作废（本域根被并入兄弟），此后不得再写入 —— 存活方需用自己的账本",
    );

  return {
    version: () => ver,
    commit(expectedVersion, mutate) {
      if (expectedVersion !== ver) {
        return err(
          "账本版本冲突：期望 v" +
            expectedVersion +
            "，实际 v" +
            ver +
            "（拒绝并发覆盖）",
        );
      }
      mutate();
      ver += 1;
      return ok(ver);
    },

    addPeer(peerId, conflictDomain, state = "running") {
      if (isDissolved) return dissolvedErr();
      // 空冲突域 = 没有隔离面 = 这次分裂没有意义；判定归账本（工具的形状校验不替它兜底）
      const domain = conflictDomain.trim();
      if (domain === "")
        return err("冲突域不可为空（分裂的全部意义是工作内容隔离）");
      if (peerId === rootId) return err("不能把自己登记为兄弟");
      if (peers.has(peerId)) return err("兄弟 " + peerId + " 已登记");
      // 冲突域**唯一**：分裂的全部意义是"工作内容高度隔离"（07 §3），
      // 两个兄弟同域 ⇒ 不隔离，登记本身就是错的。
      for (const [id, v] of peers) {
        if (v.conflictDomain === domain) {
          return err(
            "冲突域 " +
              domain +
              " 已由兄弟 " +
              id +
              " 持有（分裂要求域间隔离，不得同域）",
          );
        }
      }
      peers.set(peerId, { state, conflictDomain: domain });
      ver += 1;
      return ok(undefined);
    },

    peerSettled(peerId) {
      if (isDissolved) return dissolvedErr();
      const p = peers.get(peerId);
      if (!p) return err("未登记的兄弟 " + peerId);
      p.state = "done";
      ver += 1;
      return ok(undefined);
    },

    setSelfState(state) {
      if (isDissolved) return dissolvedErr();
      selfState = state;
      ver += 1;
      return ok(undefined);
    },

    domainQuiescent() {
      if (selfState !== "done") return false;
      for (const v of peers.values()) if (v.state !== "done") return false;
      return true;
    },

    conflictDomainOf: (peerId) => peers.get(peerId)?.conflictDomain,
    peers: listPeers,

    async publishToShared(sink) {
      return sink.publish({ rootId, selfState, peers: listPeers() });
    },

    requestMerge(input) {
      if (isDissolved) return dissolvedErr();
      const withPeerId = input.withPeerId;
      const raisedById = input.raisedById;
      const evidence = input.evidence.trim();

      if (raisedById === withPeerId) return err("不能向自己请求合并");
      if (raisedById !== rootId && !peers.has(raisedById)) {
        return err("发起端 " + raisedById + " 不在本域（根 = " + rootId + "）");
      }
      if (!peers.has(withPeerId)) {
        return err(
          "兄弟 " +
            withPeerId +
            " 不在本域 ⇒ 合并请求无处可去（分裂时未登记？）",
        );
      }
      if (input.absorbedId !== raisedById && input.absorbedId !== withPeerId) {
        return err(
          "被并方只能是请求两端之一（" +
            raisedById +
            " / " +
            withPeerId +
            "），收到 " +
            input.absorbedId,
        );
      }
      if (evidence === "") return err("缺少相关性依据（监管无从判定）");
      if (evidence.length > 500)
        return err("依据过长（" + evidence.length + " > 500）");

      const pairHas = (r: MergeRequestRecord) =>
        !r.settled &&
        ((r.raisedById === raisedById && r.withPeerId === withPeerId) ||
          (r.raisedById === withPeerId && r.withPeerId === raisedById));
      const pending = [...requests.values()].find(pairHas);
      if (pending)
        return err(
          "同一对已有未裁决的合并请求 " + pending.id + "（不得重复请求）",
        );

      seq += 1;
      const id = input.id ?? "mrg-" + seq;
      if (requests.has(id)) return err("合并请求 id 重复：" + id);
      requests.set(id, {
        id,
        raisedById,
        withPeerId,
        absorbedId: input.absorbedId,
        evidence,
        raisedAt: input.raisedAt,
        settled: false,
      });
      ver += 1;
      return ok({ id });
    },

    mergeRequests: listRequests,

    withdrawMerge(id) {
      if (isDissolved) return dissolvedErr();
      const rec = requests.get(id);
      if (!rec) return err("未登记的合并请求 " + id);
      if (rec.settled) return err("合并请求 " + id + " 已裁决，无法撤销");
      requests.delete(id);
      ver += 1;
      return ok(undefined);
    },

    resolveMerge(input) {
      if (isDissolved) return dissolvedErr();
      const rec = requests.get(input.id);
      if (!rec) return err("未登记的合并请求 " + input.id);
      if (rec.settled)
        return err("合并请求 " + input.id + " 已裁决（重复裁决被拒）");
      if (input.by.trim() === "") return err("裁决必须署名（谁批准的）");

      if (input.resolution === "full") {
        if (rec.absorbedId === rootId) {
          // 本域根被并入兄弟 ⇒ 这个"域视角"不复存在；不假装能就地重定根
          isDissolved = true;
        } else {
          peers.delete(rec.absorbedId);
        }
      }
      // reassign：域结构不变，子代转归由 transferChildren 落账
      // rejected：什么都不改

      rec.settled = true;
      rec.resolution = input.resolution;
      rec.resolvedBy = input.by;
      rec.resolvedAt = input.at;
      ver += 1;
      return ok({ absorbedId: rec.absorbedId });
    },

    dissolved: () => isDissolved,

    snapshot: () => ({
      version: ver,
      rootId,
      selfState,
      peers: listPeers(),
      mergeRequests: listRequests(),
      dissolved: isDissolved,
    }),
  };
}

/**
 * 归属转换（裁定④批准的第二条分支）：把**未收敛**的子代从一方的下级账本转到另一方。
 *
 * 为什么先转入、后转出：转入失败 ⇒ 什么都没动（干净中止）；
 * 反过来会留下"原父已放弃、新父未接收"的**无归属子代**，那正是孤儿的定义（17 §6）。
 * 转出侧以 `abandoned` 结算 = "对原父而言不再是它的下级"，转入侧重新登记为未收敛。
 */
export function transferChildren(input: {
  from: ChildRegistry;
  to: ChildRegistry;
  childIds: readonly string[];
  expectedFromVersion: number;
  expectedToVersion: number;
  at: number;
}): Result<{ transferred: string[] }> {
  if (input.childIds.length === 0)
    return err("转归清单为空（归属转换必须指明转走哪些子代）");
  if (input.from === input.to)
    return err("转归的两侧是同一本账（自己转给自己？）");

  const seen = new Set<string>();
  const moving: ChildRecord[] = [];
  for (const id of input.childIds) {
    if (seen.has(id)) return err("子代 " + id + " 在转归清单里重复");
    seen.add(id);
    const rec = input.from.get(id);
    if (!rec) return err("子代 " + id + " 不在转出账本里");
    if (rec.settledAt !== undefined)
      return err("子代 " + id + " 已结算（" + rec.outcome + "），无归属可转");
    if (input.to.get(id))
      return err("子代 " + id + " 已在转入账本里（重复归属）");
    moving.push(rec);
  }
  const incoming = input.to.outstanding().length + moving.length;
  if (incoming > input.to.maxLive()) {
    return err(
      "转入后存活子代达 " +
        incoming +
        "，超出上限 " +
        input.to.maxLive() +
        "（拒绝整批，不留半转移）",
    );
  }
  if (input.from.version() !== input.expectedFromVersion) {
    return err(
      "转出账本版本冲突：期望 v" +
        input.expectedFromVersion +
        "，实际 v" +
        input.from.version(),
    );
  }
  if (input.to.version() !== input.expectedToVersion) {
    return err(
      "转入账本版本冲突：期望 v" +
        input.expectedToVersion +
        "，实际 v" +
        input.to.version(),
    );
  }

  const registered = input.to.commit(input.expectedToVersion, () => {
    for (const rec of moving) {
      input.to.register({
        childId: rec.childId,
        joinedAt: rec.joinedAt,
        ...(rec.deadlineAt !== undefined ? { deadlineAt: rec.deadlineAt } : {}),
        producedRefs: rec.producedRefs,
      });
    }
  });
  if (!registered.ok) {
    return err(
      "转入账本写入被拒：" +
        registered.error +
        "（转出侧未动，本次转归**没有**发生）",
    );
  }

  const settled = input.from.commit(input.expectedFromVersion, () => {
    for (const rec of moving)
      input.from.settle(rec.childId, "abandoned", input.at);
  });
  if (!settled.ok) {
    // 已登记进新账本，旧账本却拒写 ⇒ 子代同时挂在两本账上，只能人工归因
    return err(
      "转入已完成但转出账本拒写：" +
        settled.error +
        " ⇒ 子代 " +
        input.childIds.join("/") +
        " 当前**双挂**，需人工介入清理",
    );
  }
  return ok({ transferred: moving.map((r) => r.childId) });
}

// ─────────────────────────────────────────────────────────────
// 落盘：两本账**不单独落盘**，随 C5 的 conversation 空间（见 20 §2 问题 1）
// ─────────────────────────────────────────────────────────────

export interface LedgerBundleSnapshot {
  readonly children: ChildRegistrySnapshot;
  readonly domain: DomainLedgerSnapshot;
}

export function snapshotLedgers(
  children: ChildRegistry,
  domain: DomainLedger,
): LedgerBundleSnapshot {
  return { children: children.snapshot(), domain: domain.snapshot() };
}

/** 从快照恢复（返回**新实例**；任一处不自洽 ⇒ 整体拒绝，绝不半恢复） */
export function restoreLedgers(
  snap: LedgerBundleSnapshot,
  opts?: { maxLive?: number },
): Result<{ children: ChildRegistry; domain: DomainLedger }> {
  const children = createChildRegistry(opts);
  for (const c of snap.children.children) {
    const registered = children.register({
      childId: c.childId,
      joinedAt: c.joinedAt,
      ...(c.deadlineAt !== undefined ? { deadlineAt: c.deadlineAt } : {}),
      producedRefs: c.producedRefs,
    });
    if (!registered.ok) return err("下级账本恢复被拒：" + registered.error);
    if (c.settledAt !== undefined) {
      const settled = children.settle(
        c.childId,
        c.outcome ?? "abandoned",
        c.settledAt,
      );
      if (!settled.ok) return err("下级账本结算状态恢复被拒：" + settled.error);
    }
  }

  const broken = validateDomainSnapshot(snap.domain);
  if (broken !== null) return err("域账本快照不自洽：" + broken);

  const domain = createDomainLedger(snap.domain.rootId, {
    peers: snap.domain.peers,
    selfState: snap.domain.selfState,
    mergeRequests: snap.domain.mergeRequests,
    dissolved: snap.domain.dissolved,
    version: snap.domain.version,
  });
  return ok({ children, domain });
}

/**
 * 域快照的**完整性**校验 —— 审的是"这段记录自不自洽"，不是活体成员不变量的副本。
 *
 * 故意**不**要求"请求端点必须还在域内"：已裁决的历史本来就引用被移出的兄弟，
 * 未裁决请求的端点也可能被另一条裁决移出（它依然可以被拒绝或转归），那是合法状态。
 */
function validateDomainSnapshot(snap: DomainLedgerSnapshot): string | null {
  const peerIds = new Set<string>();
  const domains = new Set<string>();
  for (const p of snap.peers) {
    if (p.peerId === snap.rootId) return "兄弟 id 与本域根同名";
    if (p.conflictDomain.trim() === "")
      return "兄弟 " + p.peerId + " 的冲突域为空（没有隔离面的登记）";
    if (peerIds.has(p.peerId)) return "兄弟 " + p.peerId + " 重复";
    if (domains.has(p.conflictDomain)) {
      return (
        "冲突域 " + p.conflictDomain + " 由两个兄弟同时持有（域间必须隔离）"
      );
    }
    peerIds.add(p.peerId);
    domains.add(p.conflictDomain);
  }

  const ids = new Set<string>();
  for (const r of snap.mergeRequests) {
    if (ids.has(r.id)) return "合并请求 id " + r.id + " 重复";
    ids.add(r.id);
    if (r.raisedById === r.withPeerId)
      return "请求 " + r.id + " 是自己与自己合并";
    if (r.absorbedId !== r.raisedById && r.absorbedId !== r.withPeerId) {
      return "请求 " + r.id + " 的被并方不是请求两端之一";
    }
    if (r.evidence.trim() === "" || r.evidence.length > 500) {
      return "请求 " + r.id + " 的相关性依据不合规";
    }
    if (
      r.settled &&
      (r.resolution === undefined || (r.resolvedBy ?? "").trim() === "")
    ) {
      return "请求 " + r.id + " 标为已裁决却缺裁决或裁决人（不允许无痕裁决）";
    }
  }
  return null;
}
