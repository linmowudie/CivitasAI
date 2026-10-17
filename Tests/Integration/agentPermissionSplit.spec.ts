/**
 * 集成测试：Agent 权限模型与工具可见性——分裂运行验证
 *
 * R1: prime_director 入口 → 可见 requiredRoles 全集（含 DANGEROUS；执行管控走审批）
 * R2: worker 尝试调用 AgentRecruit → ROLE_FORBIDDEN
 * R3: regulator / arbitrator（L0）按 requiredRoles 观察；prime_director 可见 DANGEROUS
 *
 * ★ FE-051（2026-10-04）收敛：可见性唯一真相源 = `requiredRoles`
 *   （Docs/Agent/10 §3.3.1 v2.2 两轴正交），原 dangerLevel×trustLevel 单轴预期已同步重写。
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  initTrustLevels,
  getTrustLevel,
  isToolAllowed,
} from "../../Src/Infra/Security/trustLevels.js";
import { registerBuiltinTools } from "../../Src/Tools/builtinLoader.js";
import {
  getVisibleToolsForRole,
  getVisibleToolNames,
} from "../../Src/Tools/Factory/toolFactory.js";
import {
  executeTool,
  clearRegistry,
} from "../../Src/Tools/Registry/toolRegistry.js";
import { initWhitelist } from "../../Src/Infra/Security/whitelist.js";
import { initPathGuard } from "../../Src/Infra/Security/pathGuard.js";
import { resolve } from "node:path";

describe("Agent 权限分裂运行验证", () => {
  beforeAll(() => {
    // 初始化系统基础设施
    initTrustLevels({
      systemRoles: ["regulator", "auditor", "arbitrator"],
      userRoles: ["prime_director", "partner"],
      externalRoles: ["worker", "reviewer", "assembly_node"],
    });
    initWhitelist({ forbiddenPaths: ["Data/Auth/"], forbiddenCommands: [] });
    initPathGuard({
      projectRoot: resolve("."),
      forbiddenPaths: ["Data/Auth/"],
    });
    clearRegistry();
    registerBuiltinTools();
  });

  // ━━━ R1: prime_director 入口级工具可见性 ━━━
  describe("R1: prime_director 入口级（L1）", () => {
    it("可见 requiredRoles 全集：SAFE + CONTROLLED + DANGEROUS", () => {
      const visible = getVisibleToolNames({ role: "prime_director" });

      // SAFE 工具应可见
      expect(visible).toContain("FileRead");
      expect(visible).toContain("DirList");
      expect(visible).toContain("FileGrep");

      // CONTROLLED 工具应可见
      expect(visible).toContain("FileWrite");
      expect(visible).toContain("FileEdit");

      // DANGEROUS：requiredRoles 含 prime_director → 可见
      // （FE-051：可见性不按危险级裁剪；执行管控由 toolSafetyGate 审批承担）
      expect(visible).toContain("ShellExec");
      expect(visible).toContain("CodeEval");
    });

    it("partner 与 prime_director 除两处设计差异外对等（FE-050 + C6 工具身份）", () => {
      const pdTools = getVisibleToolNames({ role: "prime_director" });
      const partnerTools = getVisibleToolNames({ role: "partner" });
      // FE-050：partner 是执行级（可被编排派发），需要 AgentSubmitReview 提交通道；
      // prime_director 不自报完成 → 不持有该工具。
      expect(partnerTools).toContain("AgentSubmitReview");
      expect(pdTools).not.toContain("AgentSubmitReview");

      // C6：组装体的决定权只归 prime_director ⇒ 两个编排工具 partner 不可见（10 §3.3.1 两轴正交）
      expect(pdTools).toContain("OrchestratorCompose");
      expect(pdTools).toContain("OrchestratorSelect");
      expect(partnerTools).not.toContain("OrchestratorCompose");
      expect(partnerTools).not.toContain("OrchestratorSelect");

      const strip = (ts: string[]) =>
        ts.filter(
          (t) => t !== "AgentSubmitReview" && !t.startsWith("Orchestrator"),
        );
      expect(strip(partnerTools).sort()).toEqual(strip(pdTools).sort());
    });

    it("信任级别为 L1", () => {
      expect(getTrustLevel("prime_director")).toBe("L1");
      expect(getTrustLevel("partner")).toBe("L1");
    });
  });

  // ━━━ R2: worker 角色权限限制 ━━━
  describe("R2: worker 执行子级（L2）", () => {
    it("可见 requiredRoles 全集（读 + 写 + 执行；FE-051 两轴正交）", () => {
      const visible = getVisibleToolNames({ role: "worker" });

      // 读类可见
      expect(visible).toContain("FileRead");
      expect(visible).toContain("DirList");

      // 写类可见（Worker 职能即执行；v2.2 修订否决了 L2 仅 SAFE 的单轴模型）
      expect(visible).toContain("FileWrite");
      expect(visible).toContain("FileEdit");

      // 执行类可见（管控在审批层，不在可见性层）
      expect(visible).toContain("ShellExec");
      expect(visible).toContain("CodeEval");
      expect(visible).toContain("AgentSubmitReview");

      // 不在 worker 白名单 → 不可见
      expect(visible).not.toContain("AgentRecruit");
    });

    it("executeTool 调用 AgentRecruit → ROLE_FORBIDDEN", async () => {
      // AgentRecruit 的 requiredRoles = ['prime_director', 'partner']
      // worker 不在白名单中，应返回 ROLE_FORBIDDEN
      const result = await executeTool(
        "AgentRecruit",
        { role: "worker", model: "test" },
        {
          operationId: "op-test-r2",
          agentId: "agent-worker-1",
          agentRole: "worker",
        },
      );

      expect(result.status).toBe("error");
      expect(result.recoverable).toBe(false);
      expect(result.error?.code).toBe("ROLE_FORBIDDEN");
      expect(result.error?.message).toContain("worker");
    });

    it("executeTool 调用 FileRead → 成功（worker 在 requiredRoles 中）", async () => {
      // FileRead 的 requiredRoles 包含 worker
      const result = await executeTool(
        "FileRead",
        { path: "package.json" },
        {
          operationId: "op-test-r2-read",
          agentId: "agent-worker-1",
          agentRole: "worker",
        },
      );

      // 应该不是 ROLE_FORBIDDEN（可能成功或文件相关错误）
      if (result.status === "error") {
        expect(result.error?.code).not.toBe("ROLE_FORBIDDEN");
      }
    });

    it("信任级别为 L2", () => {
      expect(getTrustLevel("worker")).toBe("L2");
      expect(getTrustLevel("reviewer")).toBe("L2");
      expect(getTrustLevel("assembly_node")).toBe("L2");
    });
  });

  // ━━━ R3: L0 治理级 vs L1 入口级 对比 ━━━
  describe("R3: 治理级（L0）vs 入口级（L1）", () => {
    it("regulator(L0) 按 requiredRoles：只读观察类可见，不含写入/执行", () => {
      const visible = getVisibleToolNames({ role: "regulator" });
      const allTools = getVisibleToolsForRole("regulator");

      expect(allTools.length).toBeGreaterThanOrEqual(6);
      expect(visible).toContain("FileRead"); // 只读 — regulator 可见
      expect(visible).toContain("ToolSearch");
      expect(visible).not.toContain("ShellExec"); // 治理层不执行副作用
      expect(visible).not.toContain("FileWrite");
      expect(visible).not.toContain("ToolExecute");
    });

    it("arbitrator(L0) 可见集 ⊇ regulator（仲裁需取证/修复，另含写入与执行类）", () => {
      const regTools = getVisibleToolNames({ role: "regulator" });
      const arbTools = getVisibleToolNames({ role: "arbitrator" });
      for (const t of regTools) expect(arbTools).toContain(t);
      expect(arbTools).toContain("FileWrite"); // 修复需要写入
      expect(arbTools).toContain("ShellExec"); // 取证需要执行（管控在审批层）
    });

    it("prime_director(L1) 可见 DANGEROUS（requiredRoles 命中；管控在审批层）", () => {
      const visible = getVisibleToolNames({ role: "prime_director" });
      expect(visible).toContain("ShellExec");
      expect(visible).toContain("CodeEval");
    });

    it("（历史矩阵）isToolAllowed 纯函数语义不变——已废弃，不是可见性闸门", () => {
      expect(isToolAllowed("DANGEROUS", "L0")).toBe(true);
      expect(isToolAllowed("DANGEROUS", "L1")).toBe(false);
      expect(isToolAllowed("CONTROLLED", "L1")).toBe(true);
      expect(isToolAllowed("CONTROLLED", "L2")).toBe(false);
    });

    it("信任级别为 L0", () => {
      expect(getTrustLevel("regulator")).toBe("L0");
      expect(getTrustLevel("auditor")).toBe("L0");
      expect(getTrustLevel("arbitrator")).toBe("L0");
    });
  });
});
