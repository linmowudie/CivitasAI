/**
 * LedgerHub 验证（融合 P0）：进程内唯一的 L1 账本所有权。
 *
 * 验证的不是"函数存在"，而是融合纪律：
 * - 分裂/合并端口用的 registry 与外层（未来 OuterLoop）拿到的是**同一实例**；
 * - 懒登记幂等（同一身份不重复挂账本）；
 * - 重置后账本清空（测试隔离），且新实例不共享旧账本。
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  getL1HostRegistry,
  ensureL1Host,
  listL1Hosts,
  resetL1LedgerHub,
} from "../../Src/Core/Orchestration/ledgerHub.js";
import {
  splitMergePortFor,
  resetSplitMergeComposition,
} from "../../Src/Core/Orchestration/splitMergeComposition.js";

describe("L1 账本枢纽（LedgerHub）", () => {
  beforeEach(() => {
    resetL1LedgerHub();
    resetSplitMergeComposition();
  });

  it("分裂端口与 hub 共用同一份 L1 账本（不许两本账）", () => {
    const port = splitMergePortFor("agent-l1-hub");
    expect(port).toBeDefined();
    // 关键断言：端口解析出来的宿主必须能在 hub 的 registry 里找到
    expect(listL1Hosts()).toContain("agent-l1-hub");
    expect(getL1HostRegistry().resolve("agent-l1-hub")).toBeDefined();
    expect(port?.domainView().rootId).toBe("agent-l1-hub");
  });

  it("懒登记幂等：重复 ensure 不重复挂账", () => {
    const a = ensureL1Host("agent-l1-idem");
    const b = ensureL1Host("agent-l1-idem");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(listL1Hosts().filter((id) => id === "agent-l1-idem")).toHaveLength(
      1,
    );
  });

  it("空身份拒绝（不伪造宿主）", () => {
    expect(ensureL1Host("   ").ok).toBe(false);
    expect(listL1Hosts()).toHaveLength(0);
  });

  it("重置后账本清空，且新 registry 不继承旧账本", () => {
    ensureL1Host("agent-l1-reset");
    const before = getL1HostRegistry();
    expect(listL1Hosts()).toContain("agent-l1-reset");

    resetL1LedgerHub();
    expect(getL1HostRegistry()).not.toBe(before);
    expect(listL1Hosts()).toHaveLength(0);
  });
});
