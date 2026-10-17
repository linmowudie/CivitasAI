/**
 * OrchestratorSelect —— **选件工具**（C6 工具身份的另一半）。
 *
 * 设计依据：`Docs/Dev/L1编排设计/02-组装器与算子闭集.md` §1（外层：选择 = 决定下一组件）·
 *   `10-组件的三集合.md` §L1 外循环（外层工具集**仅编排类**，不含 read/write/execute）·
 *   `19-OuterLoop.md` §6（选件是**外层策略**，但提名可以由外层 LLM 给出）
 *
 * 纪律：**提名不等于生效**。本工具把提名交给组装体持有者（C5），由它按"是否在组装体内"收束；
 * 不在组装体内的提名一律拒绝 —— 否则模型可以凭空调起一个从未被组装的执行件。
 * 只读 + 一次性登记，不改结构、不落盘（改结构是 `OrchestratorCompose` 的职责）。
 */
import type { ToolDefinition } from "../Traits/toolSpec.js";
import { toolSuccess, toolError } from "../Traits/toolSpec.js";
import { contentOutputSchema } from "../Builtin/_shared.js";
import { getToolServicePorts } from "../Registry/toolServicePorts.js";

export const orchestratorSelect: ToolDefinition = {
  spec: {
    name: "OrchestratorSelect",
    version: "0.1.0",
    description:
      "决定下一个执行的组件（仅 L1 外层可用）。" +
      "candidate 必须是**当前组装体内**的节点 id —— 不在组装体内的提名会被拒绝；" +
      "list=true 时同时返回执行件目录与组装体现状，便于重新提名。",
    inputSchema: {
      type: "object",
      properties: {
        candidate: {
          type: "string",
          description: "提名的组件 id（须 ∈ 当前组装体；用 list=true 查看）",
        },
        list: {
          type: "boolean",
          description: "是否同时列出目录与组装体现状（默认 false）",
        },
      },
      required: ["candidate"],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema(
      "{ assemblyId, selected, reason, executables, catalog }",
    ),
    dangerLevel: "CONTROLLED",
    idempotency: "YES",
    idempotencyKeyFields: ["candidate", "list"],
    reversibility: "REVERSIBLE",
    sideEffectScope: "none",
    requiredRoles: ["prime_director"],
    sandboxMode: "none",
    timeoutMs: 10_000,
  },

  async execute(input, context) {
    const port = getToolServicePorts().orchestration;
    if (!port) {
      return toolError(
        context.operationId,
        "NOT_ENABLED",
        "组装闭环未装配（C5/C6/S1 由组合根注入）；本次**未选定任何组件**",
        false,
      );
    }

    const candidate =
      typeof input["candidate"] === "string"
        ? (input["candidate"] as string).trim()
        : "";
    const withList = input["list"] === true;
    const assembly = port.currentAssembly();

    if (!candidate) {
      // 只要清单时也必须显式给出 candidate —— 空提名不得被当成"查看清单"的副作用路径
      const listed = withList
        ? { executables: assembly.executables, catalog: port.catalog() }
        : undefined;
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        "缺少 candidate（要查看可选项请带 list=true，但提名本身不可为空）",
        false,
        listed ? { ...listed } : undefined,
      );
    }

    const selected = port.select(candidate);
    if (!selected.ok) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        `提名未被采纳：${selected.error}`,
        true,
        withList
          ? { executables: assembly.executables, catalog: port.catalog() }
          : undefined,
      );
    }

    return toolSuccess(
      context.operationId,
      JSON.stringify(
        {
          assemblyId: assembly.id,
          selected: selected.value.selected,
          reason: selected.value.reason,
          by: context.agentId,
          ...(withList
            ? { executables: assembly.executables, catalog: port.catalog() }
            : {}),
          hint: "提名已登记为**下一次**选件（一次性）；未被再次提名时由外层选件策略决定。",
        },
        null,
        2,
      ),
    );
  },
};
