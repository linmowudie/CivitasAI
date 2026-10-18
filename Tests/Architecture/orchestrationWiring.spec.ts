/**
 * P4 · "文档声明 = 实际接线" 对账守卫。
 *
 * 目的：融合过程中最容易发生的是**单向漂移**——代码接线了、文档还写"未接"，
 * 或者文档宣称已接、组合根里根本没有注入。这个测试把两者钉在一起：
 * - `main.ts` 必须真的初始化编排运行时并把端口注入工具端口表；
 * - L1 执行入口必须真的用内核（OuterLoop + ReActCore + ReActLoop）；
 * - 融合文档必须登记 P0/P1/P2/P3 状态，且提到对应实现文件。
 *
 * 注意：这是**声明一致性**检查，不是行为测试；行为测试在 l1Entry/orchestrationRuntime 等文件。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

describe("编排融合 · 文档-接线对账守卫", () => {
  it("main.ts 真的初始化编排运行时并注入 orchestration 端口", () => {
    const main = read("Src/main.ts");
    expect(main).toContain("initOrchestrationRuntime(");
    expect(main).toContain("orchestration: getOrchestrationPort(");
    // P0：分裂/合并端口也必须在组合根注入
    expect(main).toContain("splitMergeFor: splitMergePortFor");
    // 开关必须由配置显式接管（不是隐藏环境变量/默认开）
    expect(main).toContain("orchestration.kernel");
    expect(main).toContain("setOrchestrationKernelEnabled(");
    // 运维覆盖：env 1/0 优先于配置（文档承诺的回滚通道必须真的存在）
    expect(main).toContain('process.env["CIVITAS_ORCHESTRATION_KERNEL"]');
    const defaultCfg = JSON.parse(read("Configs/default.json")) as {
      orchestration?: { kernel?: { enabled?: boolean } };
    };
    // 内核优先（2026-10-18）：生产默认开启内核路由；回滚 = 改配置 false 或 env 覆盖
    expect(defaultCfg.orchestration?.kernel?.enabled).toBe(true);
  });

  it("L1 执行入口真的以内核为所有者（OuterLoop + ReActCore + ReActLoop）", () => {
    const entry = read("Src/Core/Orchestration/l1Entry.ts");
    expect(entry).toContain("createOuterLoop(");
    expect(entry).toContain("createReActCore(");
    expect(entry).toContain("createReActLoop(");
    expect(entry).toContain("isOrchestrationKernelEnabled");
    // 账本必须来自 LedgerHub（禁止自建 L1HostRegistry）
    expect(entry).toContain("ensureL1Host(");
    expect(entry).not.toContain("createL1HostRegistry(");
  });

  it("账本所有权唯一：生产代码不允许自建 L1HostRegistry（除 ledgerHub 自身）", () => {
    const hub = read("Src/Core/Orchestration/ledgerHub.ts");
    expect(hub).toContain("createL1HostRegistry(");
    // 组合根与分裂端口通过 hub 获取账本
    expect(read("Src/Core/Orchestration/splitMergeComposition.ts")).toContain(
      "getL1HostRegistry(",
    );
    expect(
      read("Src/Core/Orchestration/orchestrationRuntime.ts"),
    ).not.toContain("createL1HostRegistry(");
  });

  it("融合文档登记了各阶段状态与实现文件（防止代码超前文档）", () => {
    const doc = read("Docs/Dev/L1编排设计/29-融合方案-内核优先.md");
    for (const stage of ["P0", "P1", "P2", "P3"]) {
      expect(doc).toContain(stage);
    }
    expect(doc).toContain("ledgerHub.ts");
    expect(doc).toContain("orchestrationRuntime.ts");
    expect(doc).toContain("l1Entry.ts");
  });

  it("模块级兜底关闭（生产默认由配置开启；未初始化组合根时不擅自接管）", async () => {
    // 该测试文件不设置 CIVITAS_ORCHESTRATION_KERNEL，故默认应为关闭
    const { isOrchestrationKernelEnabled } =
      await import("../../Src/Core/Orchestration/l1Entry.js");
    expect(isOrchestrationKernelEnabled()).toBe(false);
  });
});
