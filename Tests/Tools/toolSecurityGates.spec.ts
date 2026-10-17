/**
 * 工具安全门的**执行方**回归测试（矩阵 cell TOOL-SEC-L4GATE / TOOL-SEC-RATE）。
 *
 * 背景（2026-10-17）：
 * - `TOOL-SEC-L4GATE`：`specValidator` 规则 11 原为空 if 块（只写注释），
 *   危险且不可逆工具**不声明 L4 HumanGate 也能注册**——判据"校验期即拒绝"从未成立。
 * - `TOOL-SEC-RATE`：`ToolSpec.rateLimitPerAgent` 只有声明、无任何执行方，
 *   "每 Agent 每窗口最多 N 次"既不生效也不报错。
 *
 * 本文件同时是两条 cell 的断言锚（标题含 cell id）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { validateToolSpec } from "../../Src/Tools/Traits/specValidator.js";
import type {
  ToolSpec,
  ToolDefinition,
} from "../../Src/Tools/Traits/toolSpec.js";
import { toolSuccess } from "../../Src/Tools/Traits/toolSpec.js";
import {
  registerTool,
  executeTool,
  clearRegistry,
} from "../../Src/Tools/Registry/toolRegistry.js";
import { resetToolRateLimiter } from "../../Src/Tools/Registry/toolRateLimiter.js";
import type { ToolExecutionContext } from "../../Src/Tools/Traits/toolSpec.js";

const ctx = (agentId: string): ToolExecutionContext =>
  ({
    operationId: `op-${agentId}`,
    agentId,
    agentRole: "worker",
    loopId: "loop-gate-1",
    traceId: "trace-gate-1",
  }) as ToolExecutionContext;

function specOf(over: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name: "GateProbe",
    version: "0.1.0",
    description: "安全门测试工具",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        recoverable: { type: "boolean" },
        content: { type: "object" },
      },
      required: ["status", "recoverable"],
      additionalProperties: true,
    },
    dangerLevel: "SAFE",
    idempotency: "NO",
    reversibility: "REVERSIBLE",
    sideEffectScope: "none",
    requiredRoles: ["worker"],
    sandboxMode: "none",
    timeoutMs: 2_000,
    ...over,
  };
}

function defOf(spec: ToolSpec): ToolDefinition {
  return {
    spec,
    execute: async (_input, c) => toolSuccess(c.operationId, { ok: true }),
  };
}

beforeEach(() => {
  clearRegistry();
  resetToolRateLimiter();
});

afterEach(() => {
  clearRegistry();
  resetToolRateLimiter();
});

describe("TOOL-SEC-L4GATE · 危险且不可逆工具必须在校验期声明 L4 HumanGate", () => {
  it("TOOL-SEC-L4GATE: DANGEROUS+IRREVERSIBLE 未声明 L4 → 校验期拒绝注册", () => {
    const spec = specOf({
      name: "GateDangerNoL4",
      dangerLevel: "DANGEROUS",
      idempotency: "NO",
      reversibility: "IRREVERSIBLE",
      sideEffectScope: "process",
    });

    const validation = validateToolSpec(spec);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("L4");

    // 注册入口同样拒收（不是"只在文档里写"）
    const reg = registerTool(defOf(spec));
    expect(reg.ok).toBe(false);
    if (reg.ok === false) expect(reg.error).toContain("L4");
  });

  it('TOOL-SEC-L4GATE: 声明 humanGateLevel=L4 后允许注册（约束不是"一刀切禁危险工具"）', () => {
    const spec = specOf({
      name: "GateDangerWithL4",
      dangerLevel: "DANGEROUS",
      idempotency: "NO",
      reversibility: "IRREVERSIBLE",
      sideEffectScope: "process",
      humanGateLevel: "L4",
    });

    expect(validateToolSpec(spec).valid).toBe(true);
    expect(registerTool(defOf(spec)).ok).toBe(true);
  });
});

describe("TOOL-SEC-RATE · rateLimitPerAgent 有执行方", () => {
  /** 注册一个带限流的工具并返回其定义 */
  function registerLimited(max: number, windowMs: number): void {
    const spec = specOf({
      name: "GateLimited",
      idempotency: "NO",
      rateLimitPerAgent: { max, windowMs },
    });
    const reg = registerTool(defOf(spec));
    expect(reg.ok).toBe(true);
  }

  it("TOOL-SEC-RATE: 窗口内超限调用被拒（TOOL_RATE_LIMITED）并留痕", async () => {
    registerLimited(2, 60_000);

    const first = await executeTool("GateLimited", {}, ctx("agent-rate-1"));
    const second = await executeTool("GateLimited", {}, ctx("agent-rate-1"));
    const third = await executeTool("GateLimited", {}, ctx("agent-rate-1"));

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(third.status).toBe("error");
    expect(third.error?.code).toBe("TOOL_RATE_LIMITED");
    // 可重试（窗口滑动后可恢复），而不是永久封禁
    expect(third.recoverable).toBe(true);
    expect(third.error?.message).toContain("限流");
  });

  it("TOOL-SEC-RATE: 限流按 agent 隔离（一个 Agent 超限不牵连他人）", async () => {
    registerLimited(1, 60_000);

    expect((await executeTool("GateLimited", {}, ctx("agent-a"))).status).toBe(
      "success",
    );
    expect((await executeTool("GateLimited", {}, ctx("agent-a"))).status).toBe(
      "error",
    );
    // 另一个 Agent 仍有自己的配额
    expect((await executeTool("GateLimited", {}, ctx("agent-b"))).status).toBe(
      "success",
    );
  });

  it("TOOL-SEC-RATE: 未声明 rateLimitPerAgent 的工具不受影响", async () => {
    const reg = registerTool(defOf(specOf({ name: "GateUnlimited" })));
    expect(reg.ok).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(
        (await executeTool("GateUnlimited", {}, ctx("agent-u"))).status,
      ).toBe("success");
    }
  });
});
