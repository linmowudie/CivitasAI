/**
 * 分裂/合并**生产组合根**验证（⑦ 生产接线）。
 *
 * 不是测工具（工具已有独立测试），而是测"main.ts 注入给工具的端口真的能按身份解析"：
 * - 懒登记宿主（L1 首次使用分裂能力时建立域账本）；
 * - 同身份不重复挂账本、不同身份各自一本账；
 * - rootId === agentId（合并请求发起端约束）。
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  splitMergePortFor,
  listSplitMergeHosts,
  resetSplitMergeComposition,
} from "../../Src/Core/Orchestration/splitMergeComposition.js";

describe("分裂/合并生产组合根（splitMergeComposition）", () => {
  beforeEach(() => {
    resetSplitMergeComposition();
  });

  it("按身份懒登记宿主并返回可用端口（rootId = agentId）", () => {
    const port = splitMergePortFor("agent-l1-probe");
    expect(port).toBeDefined();
    expect(port?.domainView().rootId).toBe("agent-l1-probe");
    expect(listSplitMergeHosts()).toContain("agent-l1-probe");
  });

  it("同一身份不重复挂两本账；不同身份各自一本", () => {
    splitMergePortFor("agent-l1-a");
    const again = splitMergePortFor("agent-l1-a");
    expect(again).toBeDefined();
    expect(
      listSplitMergeHosts().filter((id) => id === "agent-l1-a"),
    ).toHaveLength(1);

    splitMergePortFor("agent-l1-b");
    expect(listSplitMergeHosts()).toHaveLength(2);
  });

  it("空身份不解析（不伪造宿主）", () => {
    expect(splitMergePortFor("   ")).toBeUndefined();
    expect(listSplitMergeHosts()).toHaveLength(0);
  });
});
