/**
 * @module Core/Orchestration/splitMergeToolPort
 * @description
 * **`AgentSplit` / `AgentMerge` 的工具身份**：把兄弟账本（C3 `DomainLedger`）接到
 * Tools 层的 `SplitMergePort` 上。
 *
 * 设计出处：Docs/Dev/L1编排设计/07-分裂与自合并.md §3 · 05 §9.4 · 11 §3 ·
 *   17-账本-子代与兄弟.md §0/§3/§5（反例 2/6/7）· 16 §9 规则 2
 *
 * 四条纪律（每条都有负向测试）：
 *  1. **分裂产出的对端是兄弟，不是下级**：只写 `DomainLedger`。本适配层的依赖里
 *     **根本没有 `ChildRegistry`** —— "父不等兄弟"靠构造上不可见保证，不靠自觉（17 反例 2）。
 *  2. **每次 1 个**：一次调用登记一个兄弟；批量拆分的语义在模型侧，不在账本侧。
 *  3. **工具不合并**：`requestMerge` 只登记请求 + 交给监管，返回恒为待裁决。
 *     改域结构的唯一入口是 `DomainLedger.resolveMerge`（监管裁决侧调用）。
 *  4. **判定不复制**：冲突域唯一性、兄弟是否在域内、依据非空、重复请求 ——
 *     全部由 `DomainLedger` 自己拒；这里抄一份校验就等于制造两份会互相遮蔽的真源。
 *
 * 补偿纪律（C6 `retract` 的同族）：登记失败 ⇒ 回收已创建的同级 L1；
 * 提交监管失败 ⇒ 撤销请求。**撤销也失败时如实上报分叉，不假装干净。**
 */

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import type { DomainLedger, SharedContextSink } from "../Ledger/ledgers.js";
import type {
  DomainViewPort,
  MergeRequestOutcomePort,
  SplitMergePort,
  SplitOutcomePort,
} from "../../Tools/Registry/toolServicePorts.js";

/** 交给监管的合并请求（原始字段，便于组合根映射到工单/审批） */
export interface MergeRequestSubmission {
  readonly id: string;
  readonly raisedById: string;
  readonly withPeerId: string;
  readonly absorbedId: string;
  readonly evidence: string;
}

export interface SplitMergeToolPortDeps {
  /** 本 L1 的域账本（持有者注入；适配层不另存一份域视图） */
  domain: DomainLedger;
  /** 打开一个**同级** L1（独立外层+内层+上下文）；由组合根提供（预算取其系统默认） */
  openSiblingPeer(input: {
    task: string;
    conflictDomain: string;
  }): Promise<Result<{ peerId: string }>>;
  /** 回收刚创建的同级 L1（登记失败时的补偿动作） */
  abandonPeer(peerId: string): Promise<Result<void>>;
  /** 共享上下文投递（不投递 ⇒ 自合并永远发现不了相关性） */
  shared: SharedContextSink;
  /** 把合并请求提交给监管，拿受理号 */
  submitToRegulator(
    req: MergeRequestSubmission,
  ): Promise<Result<{ caseId: string }>>;
  /** 时间源（测试可注入确定性时钟） */
  now(): number;
}

export function createSplitMergeToolPort(
  deps: SplitMergeToolPortDeps,
): SplitMergePort {
  return {
    async split(input): Promise<Result<SplitOutcomePort>> {
      const opened = await deps.openSiblingPeer({
        task: input.task,
        conflictDomain: input.conflictDomain,
      });
      if (!opened.ok) {
        return ok({
          splitHappened: false,
          failure: "peer_open_failed",
          conflictDomain: input.conflictDomain,
          sharedPublished: false,
          reason:
            "同级 L1 未能创建：" +
            opened.error +
            "（域账本未改动，本次分裂没有发生）",
        });
      }
      const peerId = opened.value.peerId;

      const added = deps.domain.addPeer(peerId, input.conflictDomain);
      if (!added.ok) {
        const retracted = await deps.abandonPeer(peerId);
        if (!retracted.ok) {
          // 补偿也失败 ⇒ 真分叉，只能如实上报（同 C6 的 retract 家族）
          return err(
            "兄弟登记失败：" +
              added.error +
              "；且同级 L1 " +
              peerId +
              " 回收失败（" +
              retracted.error +
              "）" +
              " ⇒ 已创建但无域归属，需人工回收",
          );
        }
        return ok({
          splitHappened: false,
          failure: "domain_rejected",
          conflictDomain: input.conflictDomain,
          sharedPublished: false,
          reason:
            "兄弟登记失败：" +
            added.error +
            `（已回收同级 L1 ${peerId}，本次分裂没有发生）`,
        });
      }

      const published = await deps.domain.publishToShared(deps.shared);
      if (!published.ok) {
        // 兄弟**已在运行且已登记**：为一次可重投的广播回滚整次分裂代价更高 ⇒ 如实报失败并给补救入口
        return ok({
          splitHappened: true,
          failure: "broadcast_failed",
          peerId,
          conflictDomain: input.conflictDomain,
          sharedPublished: false,
          reason:
            "同级 L1 " +
            peerId +
            " 已创建并登记进域，但域进展未投递共享上下文（" +
            published.error +
            "）" +
            " ⇒ 自合并判定无从发生，请用 republishShared 重投或人工介入",
        });
      }
      return ok({
        splitHappened: true,
        failure: "none",
        peerId,
        conflictDomain: input.conflictDomain,
        sharedPublished: true,
        reason: "",
      });
    },

    async requestMerge(input): Promise<Result<MergeRequestOutcomePort>> {
      const absorbedId = input.absorbedId ?? input.withPeerId;
      const raised = deps.domain.requestMerge({
        raisedById: input.by,
        withPeerId: input.withPeerId,
        absorbedId,
        evidence: input.evidence,
        raisedAt: deps.now(),
      });
      if (!raised.ok) {
        return ok({
          submitted: false,
          failure: "request_rejected",
          reason: raised.error,
        });
      }
      const id = raised.value.id;

      const submitted = await deps.submitToRegulator({
        id,
        raisedById: input.by,
        withPeerId: input.withPeerId,
        absorbedId,
        evidence: input.evidence,
      });
      if (!submitted.ok) {
        const withdrawn = deps.domain.withdrawMerge(id);
        if (!withdrawn.ok) {
          return err(
            "合并请求提交监管失败：" +
              submitted.error +
              "；且请求 " +
              id +
              " 撤销失败（" +
              withdrawn.error +
              "）" +
              " ⇒ 存在无人受理的悬挂请求，需人工裁决",
          );
        }
        return ok({
          submitted: false,
          failure: "submit_failed",
          reason:
            "合并请求提交监管失败：" +
            submitted.error +
            `（请求 ${id} 已撤销，未留下悬挂请求）`,
        });
      }
      return ok({
        submitted: true,
        failure: "none",
        requestId: id,
        caseId: submitted.value.caseId,
        reason: "",
      });
    },

    domainView(): DomainViewPort {
      const pending = deps.domain
        .mergeRequests()
        .filter((r) => !r.settled).length;
      return {
        rootId: deps.domain.snapshot().rootId,
        selfState: deps.domain.snapshot().selfState,
        peers: deps.domain
          .peers()
          .map((p) => ({
            peerId: p.peerId,
            state: p.state,
            conflictDomain: p.conflictDomain,
          })),
        pendingMergeRequests: pending,
        dissolved: deps.domain.dissolved(),
      };
    },

    republishShared(): Promise<Result<void>> {
      return deps.domain.publishToShared(deps.shared);
    },
  };
}
