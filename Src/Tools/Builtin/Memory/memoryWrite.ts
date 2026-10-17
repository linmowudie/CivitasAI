/**
 * `MemoryWrite` —— 记忆写入的**上层入口**（裁定 (a)，2026-10-14 项目负责人）
 *
 * 为什么要这个工具：记忆写属 Services 层，而产品里唯一的 Core→记忆写 路径是
 * `consolidateLoopKnowledge`（仅 success 且长度达标的沉淀），**产生不了**
 * FORBIDDEN 键 / 治理键 / 任意 version 冲突这些被测输入。于是红线实验只能**直调 Services 写 API**，
 * 违反调用层规（"只能调用被测层之上的接口驱动实验"）。
 *
 * 本工具让 **Agent 经 Core/Loop 调用**它，由组合根注入的 Services 写实现落库 ——
 * 驱动方是 Agent（在 Services 之上），故合规。
 *
 * 写入仍走 Services 的 `writeMemory`：§8.4 断言守卫（仅 observed 可入长期记忆）与
 * 红线/治理键判定都在那一侧，本工具**不复制**任何判定逻辑。
 */
import type { ToolDefinition } from "../../Traits/toolSpec.js";
import { toolSuccess, toolError } from "../../Traits/toolSpec.js";
import { contentOutputSchema } from "../_shared.js";
import { getToolServicePorts } from "../../Registry/toolServicePorts.js";

export const memoryWrite: ToolDefinition = {
  spec: {
    name: "MemoryWrite",
    description:
      "把一条观察到的结论写入长期记忆（仅 observed 可入；红线键与治理键会被拒绝）",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "记忆标题" },
        content: { type: "string", description: "记忆内容" },
        category: { type: "string", description: "记忆分类" },
        assertion: {
          type: "string",
          description:
            "断言级别（observed / inferred / assumed），默认 observed",
        },
      },
      required: ["title", "content", "category"],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema("记忆写入结果"),
    version: "0.1.0",
    dangerLevel: "CONTROLLED",
    reversibility: "REVERSIBLE",
    sideEffectScope: "external",
    requiredRoles: [
      "prime_director",
      "partner",
      "worker",
      "assembly_node",
      "reviewer",
    ],
    sandboxMode: "none",
    timeoutMs: 15_000,
    idempotency: "NO",
  },

  async execute(input, context) {
    const title = String(input["title"] ?? "");
    const content = String(input["content"] ?? "");
    const category = String(input["category"] ?? "");
    if (!title.trim() || !content.trim() || !category.trim()) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        "缺少 title / content / category",
        false,
      );
    }

    const port = getToolServicePorts().memoryWrite;
    if (!port) {
      // 端口未注入 = 该上层入口未启用：如实回错，不静默假装成功（假绿防线）
      return toolError(
        context.operationId,
        "PORT_UNAVAILABLE",
        "memoryWrite 端口未注入（上层入口未启用）",
        true,
      );
    }

    const rawAssertion = input["assertion"];
    const assertion =
      typeof rawAssertion === "string" && rawAssertion.trim()
        ? rawAssertion
        : undefined;
    const r = port({
      title: title.trim(),
      content: content.trim(),
      category: category.trim(),
      sourceTraceIds: [context.traceId ?? ""],
      ...(assertion ? { assertion } : {}),
    });

    if (!r.ok) {
      // 红线/守卫拒绝：原样回传原因（实验要证明的正是"被拒"这件事）
      return toolError(
        context.operationId,
        "MEMORY_WRITE_REJECTED",
        r.error,
        true,
      );
    }
    return toolSuccess(context.operationId, { memoryId: r.value.memoryId });
  },
};
