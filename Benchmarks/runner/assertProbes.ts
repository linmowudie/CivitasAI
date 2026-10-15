/**
 * 真实调用探针（assertProbes）
 *
 * 目的：用户裁定 —— "关键检查改为**真实调用**，停止用『代码里还有这段形态』充当行为证据"。
 *
 * 与 `staticRecon`（静态对账）的区别：
 *   staticRecon  读源码文本，证明"这段形态还在"  → attestation=static（归 Tests 领域）
 *   本模块        真的调用产品公共 API，读**返回值** → 可支撑 attestation=executed 的覆盖声明
 *
 * 层规（必须逐条声明 `whyThisEntry`，否则不许加探针）：
 *   只能调用**被测层之上**的接口驱动实验；层下探针只用于监控、不用于驱动。
 *   也就是说：探针必须写清"被测的是什么、这个入口在被测层的上方还是就是它自己的装配期 API"。
 *   装配期属性（如"工具在注册期即被拒"）没有上层入口可驱动 —— 此时允许调用该层**自己的公共 API**，
 *   但必须如实标注 `assemblyTime: true`，不得伪装成"从上层驱动"。
 */

import { transition } from "../../Src/Core/AgentRuntime/stateMachine.js";
import { registerTool } from "../../Src/Tools/Registry/toolRegistry.js";
import { createAgent } from "../../Src/Core/AgentRuntime/agentFactory.js";
import { contentOutputSchema } from "../../Src/Tools/Builtin/_shared.js";
import { consolidateLoopKnowledge } from "../../Src/Core/Loop/loopKnowledge.js";
import { runHumanGate } from "../../Src/Services/LoopControl/verifier/humanGateCore.js";
import { createMemoryRetriever } from "../../Src/Services/Retrieval/retriever.js";
import { retrieveForContextAssembly } from "../../Src/Core/Loop/memoryRetrievalEntry.js";

export interface AssertProbeResult {
  id: string;
  passed: boolean;
  detail: string;
}

interface ProbeDef {
  /** 被测层 */
  layerUnderTest: string;
  /** 驱动入口所在层 */
  driverEntry: string;
  /** 该属性是否为装配期属性（无上层入口可驱动） */
  assemblyTime?: boolean;
  /** 为什么这个入口合规（层规自述；缺此字段的探针不予收录） */
  whyThisEntry: string;
  run: () => Promise<{ passed: boolean; detail: string }>;
}

/** 长文本（满足记忆沉淀的长度闸门 MIN_SUMMARY_CHARS=50），用于"闸门不该放行"的对照 */
const LONG_OUTPUT =
  "这是一段足够长的输出内容，用于验证记忆沉淀闸门是否按 exitReason 与长度双重判定，".repeat(
    2,
  );

export const ASSERT_PROBES: Record<string, ProbeDef> = {
  "TOOL-FORBIDDEN-REGISTER": {
    layerUnderTest: "Tools（注册期守卫）",
    driverEntry: "Tools（装配期公共 API registerTool）",
    assemblyTime: true,
    whyThisEntry:
      "「FORBIDDEN 级工具不得注册」是**装配期**属性：拒绝发生在任何循环调度之前，" +
      '不存在"由 Core/Loop 驱动"的入口（工具根本进不了注册表，循环无从调度它）。' +
      "故按层规的装配期例外，构造一个真实 ToolDefinition 调 registerTool，读其 Result —— " +
      '这是**真实调用**，不是匹配源码里"那段规则还在不在"。',
    async run() {
      const r = registerTool({
        spec: {
          name: "bench.probe.forbidden",
          description: "实验探针：FORBIDDEN 级工具，注册必须被拒",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          outputSchema: contentOutputSchema("探针输出"),
          version: "0.1.0",
          dangerLevel: "FORBIDDEN",
          reversibility: "IRREVERSIBLE",
          idempotency: "NO",
          sideEffectScope: "none",
          requiredRoles: [
            "prime_director",
            "arbitrator",
            "auditor",
            "partner",
            "worker",
            "assembly_node",
            "reviewer",
            "regulator",
          ],
          sandboxMode: "none",
          timeoutMs: 1_000,
        },
        async execute() {
          throw new Error("FORBIDDEN 工具不应被执行到");
        },
      } as never);
      const refused = r.ok === false;
      return {
        passed: refused,
        detail: refused
          ? "registerTool 拒绝注册 FORBIDDEN 工具（真实调用，读到 Result.error）"
          : "registerTool **接受**了 FORBIDDEN 工具 —— 注册期防线失效",
      };
    },
  },

  "AGENT-ID-MONOTONIC": {
    layerUnderTest: "Core/AgentRuntime（身份分配器）",
    driverEntry: "Core（createAgent 公共 API）",
    whyThisEntry:
      "「ID 只增不复用」是**分配器性质**：由 Core 层公共 API createAgent 连续创建两个 Agent、" +
      '读回各自的 agentId，即可真实验证"不同且序号递增"。' +
      '这比静态匹配 "代码里还有 ++agentCounter" 强 —— 后者只能说明那段实现还在，说明不了行为。',
    async run() {
      const seqOf = (id: string): number => {
        const tail = id.split("-").pop() ?? "";
        const v = Number(tail);
        return Number.isFinite(v) ? v : NaN;
      };
      const first = createAgent(
        { role: "worker", model: "bench-probe-model" },
        "bench-probe-trace",
      );
      const second = createAgent(
        { role: "worker", model: "bench-probe-model" },
        "bench-probe-trace",
      );
      if (first.ok === false || second.ok === false) {
        return { passed: false, detail: "createAgent 失败，无法验证 ID 分配" };
      }
      const id1 = first.value.agentId;
      const id2 = second.value.agentId;
      const s1 = seqOf(id1);
      const s2 = seqOf(id2);
      const passed =
        id1 !== id2 && Number.isFinite(s1) && Number.isFinite(s2) && s2 > s1;
      return {
        passed,
        detail: passed
          ? `连续创建得到 ${id1} → ${id2}（不同且序号递增，ID 不复用）`
          : `ID 分配异常：${id1} → ${id2}（序号 ${s1} → ${s2}）`,
      };
    },
  },
  "AGENT-ILLEGAL-TRANSITION": {
    layerUnderTest: "Core/AgentRuntime 状态机",
    driverEntry: "Core（状态机公共 API）",
    whyThisEntry:
      "状态机的非法转换拒绝是**纯函数级判定点**：合法事件集由 VALID_TRANSITIONS 表决定。" +
      "由 Core 层公共 API transition() 驱动、读其 Result 的 ok/error，" +
      '比静态匹配表内容更能证明"非法转换真的被拒"。',
    async run() {
      // creating 的合法事件只有 INIT_COMPLETE；TASK_COMPLETED 不合法
      const r = transition("creating", { type: "TASK_COMPLETED" } as never);
      return {
        passed: r.ok === false,
        detail:
          r.ok === false
            ? "creating + TASK_COMPLETED 被拒（非法转换防线生效）"
            : "非法转换被接受 —— 状态机防线失效",
      };
    },
  },

  "SUP-HUMANGATE-PENDING": {
    layerUnderTest: "Services/LoopControl/verifier（L4 人类审批门）",
    driverEntry: "Services/LoopControl（runHumanGate 公共 API）",
    whyThisEntry:
      "「L4 门恒返 PENDING_APPROVAL、不自动通过」是该门**返回值契约本身**，" +
      "由它的公共 API 驱动并读回 evidence 里的 status 即为真实验证。" +
      '相比之下，静态检查只能说明"代码里还写着 PENDING_APPROVAL"（连注释都能满足）。',
    async run() {
      const r = await runHumanGate(
        [
          {
            level: "L4" as const,
            kind: "human_gate" as const,
            payload: {
              reason: "bench-probe：验证 L4 门不自动通过",
              reviewerRoles: ["auditor" as const],
              timeoutSec: 60,
            },
          },
        ],
        { loopId: "bench-probe-loop", iteration: 0, requestedAt: Date.now() },
      );
      if (r.ok === false)
        return {
          passed: false,
          detail: "runHumanGate 返回错误: " + String(r.error),
        };
      const first = r.value[0];
      const data = first?.evidence?.[0]?.data as
        { status?: string } | undefined;
      const passed =
        first?.pass === false && data?.status === "PENDING_APPROVAL";
      return {
        passed,
        detail: passed
          ? "L4 门返回 pass=false 且 status=PENDING_APPROVAL（真实调用，不自动通过）"
          : `L4 门行为异常：pass=${String(first?.pass)} status=${String(data?.status)}`,
      };
    },
  },

  "RET-SOURCE-PINNED": {
    layerUnderTest: "Services/Retrieval（结果来源）",
    driverEntry: "Core（retrieveForContextAssembly —— 与 loop ⑷ 同一入口）",
    whyThisEntry:
      "驱动走 **Core 层入口**（被测层 Services 之上）；真实检索实现包成 port 注入，" +
      "包装里记录 retriever 返回的 source —— 端口是边界，读它返回什么属于**监控**，不构成驱动。" +
      '断言"结果来源恒为 long-term-memory"，比静态匹配 retriever.ts 里写着这个字面量强：' +
      "后者连注释都能满足。",
    async run() {
      const retriever = createMemoryRetriever();
      let observedSource: string | undefined;
      const port = async (query: string, limit: number) => {
        const res = await retriever.retrieve({
          query,
          topK: limit,
          minScore: 0,
        });
        const value =
          res && typeof res === "object" && "ok" in res && res.ok
            ? res.value
            : undefined;
        observedSource = (value as { source?: string } | undefined)?.source;
        const fragments = (value?.fragments ?? []) as Array<{
          id: string;
          content?: string;
        }>;
        return fragments.map((f) => ({
          key: f.id,
          content: typeof f.content === "string" ? f.content : "",
        }));
      };
      // 经 Core 入口驱动（返回值此处不用，观测由 port 记录）
      await retrieveForContextAssembly(port, "来源钉死验证", 3);
      const passed = observedSource === "long-term-memory";
      return {
        passed,
        detail: passed
          ? "检索结果 source 恒为 long-term-memory（经 Core 入口驱动，port 记录实测值）"
          : `检索结果 source 异常：${String(observedSource)}（应为 long-term-memory）`,
      };
    },
  },
  "MEM-CONSOLIDATE-GATE": {
    layerUnderTest: "Services（记忆写侧）",
    driverEntry: "Core/Loop（consolidateLoopKnowledge 位于 Core）",
    whyThisEntry:
      "本探针**符合层规**：被测层是 Services 的记忆写侧，而 consolidateLoopKnowledge 位于 " +
      'Core/Loop —— 即**在被测层之上**。由它驱动、观察"是否发生沉淀"，正是"从上层真实入口驱动"。',
    async run() {
      const r = consolidateLoopKnowledge({
        loopId: "bench-probe-loop",
        traceId: "bench-probe-trace",
        agentId: "bench-probe-agent",
        exitReason: "risk",
        outputText: LONG_OUTPUT,
      });
      return {
        passed: r === null,
        detail:
          r === null
            ? "exitReason=risk 时未沉淀（即使输出足够长）—— 双闸门生效"
            : `exitReason=risk 却发生沉淀（consolidated=${r?.consolidated}）—— 闸门失效`,
      };
    },
  },
};

/** 执行声明的探针；未知 id 记为失败（不许静默跳过——静默跳过就是假绿） */
export async function runAssertProbes(
  ids: string[],
): Promise<AssertProbeResult[]> {
  const results: AssertProbeResult[] = [];
  for (const id of ids) {
    const probe = ASSERT_PROBES[id];
    if (!probe) {
      results.push({
        id,
        passed: false,
        detail: `未知探针 id（拼错了？）：${id}`,
      });
      continue;
    }
    try {
      const r = await probe.run();
      results.push({ id, passed: r.passed, detail: r.detail });
    } catch (e) {
      results.push({
        id,
        passed: false,
        detail: `探针抛异常：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return results;
}

/** 供文档/审计读取的探针清单（含层规自述） */
export function describeAssertProbes(): Array<Record<string, unknown>> {
  return Object.entries(ASSERT_PROBES).map(([id, p]) => ({
    id,
    layerUnderTest: p.layerUnderTest,
    driverEntry: p.driverEntry,
    assemblyTime: p.assemblyTime === true,
    whyThisEntry: p.whyThisEntry,
  }));
}
