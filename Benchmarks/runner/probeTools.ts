/**
 * @module Benchmarks/runner/probeTools
 * @description
 * Benchmark **探针工具** —— 场景可控的副作用替身。
 *
 * 为什么不用真实工具（`FileWrite` / `ShellExec`）做基准实验：
 *  - 它们把**环境**（路径守卫、工作区隔离、宿主权限）卷进被判对象，
 *    失败时无法区分"Agent 用错了工具"与"沙箱拒绝了这个路径"；
 *  - 基准要的是**可复现、无环境依赖**的观测。
 *
 * 因此探针工具只做三件事，且行为完全由场景声明：
 *  - `BenchEcho`：回显参数（用于验证参数装配无误）；
 *  - `BenchRead`：从一个**场景内声明的内存 fixture** 里读文本（用于制造"需要多轮才能拿到信息"的任务）；
 *  - `BenchFail`：恒返回错误（用于驱动"连续错误 → limits 退出"与恢复路径）。
 */

import { memoryWrite } from "../../Src/Tools/Builtin/Memory/memoryWrite.js";
import { registerTool } from "../../Src/Tools/Registry/toolRegistry.js";
import type {
  ToolDefinition,
  ToolSpec,
  ToolResult,
} from "../../Src/Tools/Traits/toolSpec.js";
import { toolSuccess, toolError } from "../../Src/Tools/Traits/toolSpec.js";
import { contentOutputSchema } from "../../Src/Tools/Builtin/_shared.js";
import type { ScenarioToolSpec } from "./types.js";

/** 全部探针工具都允许的角色（基准里角色本身也是被观测项，不该被工具可见性挡住） */
const ALL_ROLES = [
  "prime_director",
  "partner",
  "worker",
  "reviewer",
  "assembly_node",
  "arbitrator",
  "auditor",
  "regulator",
] as const;

function baseSpec(
  name: string,
  description: string,
  timeoutMs: number,
  dangerous = false,
): ToolSpec {
  return {
    name,
    version: "1.0.0",
    description,
    // 注意：`specValidator` 禁止 `additionalProperties: true`（避免"什么都收"的模糊契约），
    // 并要求 outputSchema 有 properties —— 这两条是注册被拒时的实际报错，按契约写全。
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要回显的文本" },
        path: { type: "string", description: "fixture 键" },
      },
      required: [],
    },
    // 复用内置工具的**规范输出形状**（status + recoverable，Docs/Agent/10 §6.2）——
    // 不自己拼 schema，否则每次校验器加约束都要再猜一遍。
    outputSchema: contentOutputSchema("探针返回内容"),
    // 危险且不可逆 → `toolSafetyGate` 走**阻塞式**审批门（治理面实验的被测路径）
    dangerLevel: dangerous ? "DANGEROUS" : "SAFE",
    idempotency: dangerous ? "NO" : "YES",
    // idempotency='YES' 时校验器强制要求声明幂等键字段
    ...(dangerous ? {} : { idempotencyKeyFields: ["text", "path"] }),
    reversibility: dangerous ? "IRREVERSIBLE" : "REVERSIBLE",
    // 危险且不可逆 ⇒ 按 specValidator 规则 11 必须声明 L4 HumanGate，
    // 否则探针注册会被拒（矩阵 TOOL-SEC-L4GATE 的同一条规则）
    ...(dangerous ? { humanGateLevel: "L4" as const } : {}),
    sideEffectScope: dangerous ? "external" : "none",
    requiredRoles: [...ALL_ROLES],
    sandboxMode: "none",
    timeoutMs,
  };
}

/** 场景 fixture：`BenchRead` 从中取内容 */
export type ProbeFixtures = Record<string, string>;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 注册场景声明的探针工具（幂等：同名先清后注册由调用方负责 `clearRegistry`）。
 * @param onExecute 每次**执行体真的被调用**时回调 —— 用于观测"幂等缓存是否挡住了第二次执行"。
 *   只看工具调用次数是看不出来的：缓存命中也返回一条结果，调用数照样是 2。
 * @returns 实际注册的工具名
 */
export function registerProbeTools(
  specs: ScenarioToolSpec[],
  fixtures: ProbeFixtures,
  onExecute?: (name: string) => void,
): string[] {
  const registered: string[] = [];
  const hit = (name: string) => {
    onExecute?.(name);
  };

  for (const s of specs) {
    const behavior = s.behavior ?? "ok";
    let def: ToolDefinition;

    if (s.name === "BenchEcho") {
      def = {
        spec: baseSpec(
          s.name,
          "回显输入（基准探针）",
          s.timeoutMs ?? 5_000,
          s.dangerous,
        ),
        execute: async (input, context): Promise<ToolResult> => {
          hit(s.name);
          if (behavior === "slow") await delay(s.delayMs ?? 50);
          if (behavior === "fail")
            return toolError(
              context.operationId,
              "PROBE_FAIL",
              "BenchEcho 场景声明为失败",
              true,
            );
          return toolSuccess(
            context.operationId,
            { echoed: input["text"] ?? null },
            { effects: [] },
          );
        },
      };
    } else if (s.name === "BenchRead") {
      def = {
        spec: baseSpec(
          s.name,
          "读取场景内存 fixture（基准探针）",
          5_000,
          s.dangerous,
        ),
        execute: async (input, context): Promise<ToolResult> => {
          hit(s.name);
          if (behavior === "slow") await delay(s.delayMs ?? 50);
          if (behavior === "fail")
            return toolError(
              context.operationId,
              "PROBE_FAIL",
              "BenchRead 场景声明为失败",
              true,
            );
          const key = String(input["path"] ?? "");
          if (!(key in fixtures)) {
            return toolError(
              context.operationId,
              "NOT_FOUND",
              `fixture 不存在: ${key}`,
              true,
            );
          }
          return toolSuccess(
            context.operationId,
            { path: key, content: fixtures[key] },
            { effects: [] },
          );
        },
      };
    } else if (s.name === "BenchFail") {
      def = {
        spec: baseSpec(
          s.name,
          "恒失败（基准探针，用于驱动错误路径）",
          5_000,
          s.dangerous,
        ),
        execute: async (_input, context): Promise<ToolResult> => {
          hit(s.name);
          return toolError(
            context.operationId,
            "PROBE_ALWAYS_FAIL",
            "BenchFail 恒失败（场景故意注入）",
            true,
          );
        },
      };
    } else {
      // 未识别的探针名：注册为回显工具，避免场景因拼写问题静默失效
      def = {
        spec: baseSpec(
          s.name,
          "未识别探针（按回显处理）",
          s.timeoutMs ?? 5_000,
          s.dangerous,
        ),
        execute: async (input, context): Promise<ToolResult> => {
          hit(s.name);
          return toolSuccess(
            context.operationId,
            { note: "unrecognized probe", input },
            { effects: [] },
          );
        },
      };
    }

    const result = registerTool(def);
    if (!result.ok) {
      // 探针注册失败 = **实验台缺陷**，不是 Agent 行为失败：必须响亮失败，
      // 否则场景会退化成"工具不存在"，把基础设施问题记到 Agent 头上。
      throw new Error(`探针工具 ${s.name} 注册失败: ${result.error}`);
    }
    registered.push(s.name);
  }

  return registered;
}

/**
 * 注册 `BenchMemWrite` —— 记忆写入的**实验驱动包装**（裁定 (a)，2026-10-14）。
 *
 * 为什么需要包装：harness 不加载内置工具，而"测 Services 的记忆写"必须由**上层驱动**
 * （Tools 在 Services 之下，直调工具层同样违反层规）。故由 Agent 在循环里调用本工具，
 * 本工具把入参**原样转交**给真实的内置工具 `MemoryWrite` 执行体 ——
 * 端口注入、§8.4 断言守卫、红线/治理键判定全部发生在真实路径上，包装层**不做任何判定**，
 * 只把结果记进 sink 供实验观测。
 */
export function registerMemoryWriteProbe(
  onResult: (r: {
    input: Record<string, unknown>;
    ok: boolean;
    code?: string;
    message?: string;
  }) => void,
): { ok: boolean; error?: string } {
  const def = {
    spec: {
      name: "BenchMemWrite",
      description: "实验用：转交 MemoryWrite 真实执行体，并记录结果",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
          category: { type: "string" },
          assertion: { type: "string" },
        },
        required: ["title", "content", "category"],
        additionalProperties: false,
      },
      outputSchema: contentOutputSchema("记忆写入实验结果"),
      version: "0.1.0",
      dangerLevel: "CONTROLLED",
      reversibility: "REVERSIBLE",
      idempotency: "NO",
      sideEffectScope: "external",
      requiredRoles: ALL_ROLES,
      sandboxMode: "none",
      timeoutMs: 15_000,
    },
    async execute(
      input: Record<string, unknown>,
      context: Parameters<typeof memoryWrite.execute>[1],
    ) {
      const r = await memoryWrite.execute(input, context);
      // toolSuccess/toolError 的返回形状：判 ok 后记录（不解读业务语义）
      const anyR = r as unknown as {
        ok?: boolean;
        error?: { code?: string; message?: string };
      };
      onResult({
        input,
        ok: anyR.ok !== false,
        ...(anyR.error?.code ? { code: anyR.error.code } : {}),
        ...(anyR.error?.message ? { message: anyR.error.message } : {}),
      });
      return r;
    },
  };
  const registered = registerTool(def as never);
  return registered
    ? { ok: true }
    : { ok: false, error: "BenchMemWrite 注册被拒" };
}
