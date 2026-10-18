/**
 * @module Core/Orchestration/l1HostRegistry
 * @description
 * **L1 宿主登记**：一本域账本 + 一本下级账本属于**一个** L1 实例，这里持有那份归属关系。
 *
 * 设计出处：Docs/Dev/L1编排设计/07-分裂与自合并.md §3 · 17-账本-子代与兄弟.md §0/§1 ·
 *   05-上下文作用域.md §9.4（两个 L1 不共享会话上下文与预算）· 28-设计实现覆盖清点.md G4
 *
 * 四条纪律（每条都有负向测试）：
 *  1. **身份即作用域**：`AgentSplit` / `AgentMerge` 的端口容器是进程级单例，而域账本是
 *     L1 实例私有的。因此这里产出的是 `agentId → 端口` 的解析器；两个 L1 各分裂一次，
 *     结果必须落在**各自**的域里（否则兄弟会互相看见，05 §9.4 的隔离面直接失效）。
 *  2. **不得双宿主**：同一 agentId 只能登记一次。重复登记会把同一身份接到两本账上，
 *     而工具每次调用现取端口 ⇒ 写进哪一本取决于装配顺序，这是最难查的一类不一致。
 *  3. **`rootId` 必须等于 agentId**：工具把 `context.agentId` 当作合并请求的发起端，
 *     而 `DomainLedger.requestMerge` 要求发起端 ∈ {根, 兄弟}。rootId 不相等时整条自合并
 *     链路会静默变红（请求恒被拒），所以登记时就拒，不留到运行时猜。
 *  4. **恢复不半做**：`reopen` 沿用 `restoreLedgers` 的口径 —— 任一份快照不自洽或身份冲突
 *     ⇒ 整批拒绝，进程内不留半套宿主。
 *
 * 现状（如实登记）：本模块给出的是**解析层**。生产组合根尚未登记任何宿主
 * （`createOuterLoop` / `createDomainLedger` 在 `Src/main.ts` 里没有调用方），
 * 因为还缺两项外部能力：真实的同级 L1 工厂（`openSiblingPeer`）与监管裁决回投
 * （`submitToRegulator` → HITL → `resolveMerge`）。见 28 §6 G4。
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import {
  createChildRegistry,
  createDomainLedger,
  restoreLedgers,
  snapshotLedgers,
  type ChildRegistry,
  type DomainLedger,
  type LedgerBundleSnapshot,
} from "../Ledger/ledgers.js";
import type { SplitMergePort } from "../../Tools/Registry/toolServicePorts.js";

import {
  createSplitMergeToolPort,
  type SplitMergeToolPortDeps,
} from "./splitMergeToolPort.js";

export interface L1Host {
  readonly agentId: string;
  readonly children: ChildRegistry;
  readonly domain: DomainLedger;
}

export interface L1HostInit {
  readonly agentId: string;
  /** 缺省自建空账本（挂起恢复路径应显式传入 `restoreLedgers` 的产物） */
  readonly children?: ChildRegistry;
  readonly domain?: DomainLedger;
}

export interface L1HostRegistry {
  open(init: L1HostInit): Result<L1Host>;
  resolve(agentId: string): L1Host | undefined;
  close(agentId: string): Result<void>;
  hostIds(): string[];
  /** 全部宿主的账本快照（随挂起落盘，见 17 §5 反例 4） */
  snapshotAll(): LedgerBundleSnapshot[];
  /** 从快照重建宿主：任一处不自洽 ⇒ 整批拒绝 */
  reopen(snapshots: readonly LedgerBundleSnapshot[]): Result<number>;
}

export function createL1HostRegistry(): L1HostRegistry {
  const hosts = new Map<string, L1Host>();

  return {
    open(init): Result<L1Host> {
      const agentId = init.agentId.trim();
      if (agentId === "")
        return err("宿主 agentId 不可为空（解析端口时它就是查找键）");
      if (hosts.has(agentId)) {
        return err(
          "宿主 " +
            agentId +
            " 已登记：同一身份不得挂两本账" +
            "（否则写进哪一本取决于装配顺序）",
        );
      }

      const domain = init.domain ?? createDomainLedger(agentId);
      const rootId = domain.snapshot().rootId;
      if (rootId !== agentId) {
        return err(
          "域账本的 rootId（" +
            rootId +
            "）与宿主 agentId（" +
            agentId +
            "）不一致：" +
            "合并请求的发起端取 agentId，而账本要求发起端 ∈ {根, 兄弟}，" +
            "不相等会让自合并链路恒被拒绝",
        );
      }

      const host: L1Host = {
        agentId,
        children: init.children ?? createChildRegistry(),
        domain,
      };
      hosts.set(agentId, host);
      return ok(host);
    },

    resolve(agentId): L1Host | undefined {
      return hosts.get(agentId.trim());
    },

    close(agentId): Result<void> {
      const key = agentId.trim();
      if (!hosts.has(key)) return err("宿主 " + key + " 未登记，无从注销");
      hosts.delete(key);
      return ok(undefined);
    },

    hostIds(): string[] {
      return [...hosts.keys()];
    },

    snapshotAll(): LedgerBundleSnapshot[] {
      return [...hosts.values()].map((h) =>
        snapshotLedgers(h.children, h.domain),
      );
    },

    reopen(snapshots): Result<number> {
      // 先整批校验（身份非空、不与在活宿主重复、批内不重复），再整批落位
      const restored: Array<{
        agentId: string;
        children: ChildRegistry;
        domain: DomainLedger;
      }> = [];
      const seen = new Set<string>();
      for (const snap of snapshots) {
        const agentId = snap.domain.rootId.trim();
        if (agentId === "") return err("快照的域根为空（无从确定宿主身份）");
        if (seen.has(agentId))
          return err("快照内同一身份 " + agentId + " 出现两次");
        if (hosts.has(agentId))
          return err("宿主 " + agentId + " 已在运行，恢复会覆盖活体账本");
        const back = restoreLedgers(snap);
        if (!back.ok)
          return err("宿主 " + agentId + " 的账本恢复被拒：" + back.error);
        seen.add(agentId);
        restored.push({ agentId, ...back.value });
      }
      for (const h of restored) hosts.set(h.agentId, { ...h });
      return ok(restored.length);
    },
  };
}

/** 除域账本之外的运行时依赖（同级 L1 工厂 / 回收 / 共享上下文 / 监管提交口 / 时钟 / 分裂语义） */
export type SplitMergeRuntimeDeps = Omit<SplitMergeToolPortDeps, "domain">;

/**
 * 产出注入 Tools 层端口容器的解析器：`agentId → 该 L1 私有的端口`。
 *
 * 每次调用现建端口、不缓存 —— 宿主 `close`/`reopen` 换掉账本实例后，解析器不会继续
 * 交出一份指向陈旧账本的端口。
 */
export function createSplitMergePortForHosts(
  registry: L1HostRegistry,
  runtime: SplitMergeRuntimeDeps,
): (agentId: string) => SplitMergePort | undefined {
  return (agentId) => {
    const host = registry.resolve(agentId);
    if (!host) return undefined;
    return createSplitMergeToolPort({ domain: host.domain, ...runtime });
  };
}
