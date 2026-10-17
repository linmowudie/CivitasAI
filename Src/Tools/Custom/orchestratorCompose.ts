/**
 * OrchestratorCompose —— **组装器工具**（C6 的工具身份）。
 *
 * 设计依据：`Docs/Dev/L1编排设计/02-组装器与算子闭集.md` §1（外层用组装工具**改结构**）·
 *   `21-组装闭环.md` §0/§3（提议 → 校验 → 提交，**中间必须夹 validate**）· §5 反例 1/2/3/10 ·
 *   `19-OuterLoop.md` §工具集（外层**仅编排类**工具）· `00-索引.md` 待确认项 1（compose **仅外层可达**，已判为是）
 *
 * 本工具**只做三件事**：入参形状校验、把变更交给端口、如实回报结果。
 * 合法性判定**不在此处**（悬空引用 / 算子闭集 / 环 / 嵌套退化…归 C7；落盘与审计归 C6 的端口实现）——
 * 工具层重复实现判据会造出第二份真源，`C-OP-1` 之类的闭集一旦漂移就无人发现。
 *
 * 权限：`requiredRoles: ['prime_director']` —— 组装体归 L1 宿主（C5）持有，
 * 内层与执行子级不得改结构（否则"闭环检查失效"，见 02 §33 的判断）。
 */
import type { ToolDefinition } from "../Traits/toolSpec.js";
import { toolSuccess, toolError } from "../Traits/toolSpec.js";
import { contentOutputSchema } from "../Builtin/_shared.js";
import {
  getToolServicePorts,
  type AssemblyChangePort,
  type AssemblyNodeDeclPort,
} from "../Registry/toolServicePorts.js";

/** 变更操作闭集（与 21 §3 `AssemblyChange.op` 同形） */
const CHANGE_OPS = ["add", "remove", "replace"] as const;
const MAX_REASON_LENGTH = 500;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => String(v));
}

/**
 * 只白名单搬运**已声明**的字段（不做整体透传）：
 * 否则模型可以往组装体里塞任意结构，C7 的判据就建立在"没人看过的对象"上。
 */
function toNodeDecl(raw: unknown): AssemblyNodeDeclPort | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const id = str(src["id"]);
  const executableRef = str(src["executableRef"]);
  if (!id || !executableRef) return null;
  const decl: AssemblyNodeDeclPort = { id, executableRef };
  const operator = str(src["operator"]);
  if (operator) decl.operator = operator;
  const body = strArray(src["body"]);
  if (body) decl.body = body;
  const inputSections = strArray(src["inputSections"]);
  if (inputSections) decl.inputSections = inputSections;
  const join = src["join"];
  if (join && typeof join === "object" && !Array.isArray(join)) {
    const j = join as Record<string, unknown>;
    decl.join = {
      deps: strArray(j["deps"]) ?? [],
      onMissing: str(j["onMissing"]),
    };
  }
  const plugins = src["plugins"];
  if (Array.isArray(plugins)) {
    decl.plugins = plugins
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .map((p) => ({
        id: str(p["id"]),
        hooks: strArray(p["hooks"]) ?? [],
        conflictDomain: str(p["conflictDomain"]),
        ...(typeof p["enabled"] === "boolean" ? { enabled: p["enabled"] } : {}),
      }));
  }
  return decl;
}

export const orchestratorCompose: ToolDefinition = {
  spec: {
    name: "OrchestratorCompose",
    version: "0.1.0",
    description:
      "变更**组装体**（执行件图）：新增 / 移除 / 替换一个节点。仅 L1 外层可用，需审批。" +
      "本工具只做结构提议；能否提交由检查树裁决（悬空引用、算子闭集、环、嵌套退化、" +
      '插件冲突域、版本一致…），拒绝时会带回"判据 + 定位"供重新提名。' +
      "必须说明变更依据（审计要能归因）。",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          description:
            "变更类型：add（加节点）/ remove（删节点）/ replace（换节点）",
          enum: [...CHANGE_OPS],
        },
        target: {
          type: "string",
          description: "remove / replace 时被改节点的 id",
        },
        added: {
          type: "object",
          description: "add / replace 时的新节点声明（执行件必须已在目录注册）",
          properties: {
            id: { type: "string", description: "节点 id（组装体内唯一）" },
            executableRef: {
              type: "string",
              description: "引用的执行件（S1 目录里的 id）",
            },
            operator: {
              type: "string",
              description: "算子名（闭集由检查树裁决，不在本工具内复制）",
            },
            body: {
              type: "array",
              description: "子节点 id 列表（嵌套）",
              items: { type: "string" },
            },
            inputSections: {
              type: "array",
              description: "该节点声明可见的上下文分区（必须是宿主的真子集）",
              items: { type: "string" },
            },
            join: {
              type: "object",
              description: "汇合声明（必须给出 onMissing，否则拒绝）",
              properties: {
                deps: { type: "array", items: { type: "string" } },
                onMissing: {
                  type: "string",
                  description: "block / degrade / abandon",
                },
              },
              additionalProperties: false,
            },
            plugins: {
              type: "array",
              description: "插件声明（同 conflictDomain 不得同时启用两个）",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  hooks: { type: "array", items: { type: "string" } },
                  conflictDomain: { type: "string" },
                  enabled: { type: "boolean" },
                },
                additionalProperties: false,
              },
            },
          },
          required: ["id", "executableRef"],
          additionalProperties: false,
        },
        reason: {
          type: "string",
          description: `变更依据（审计留痕用，≤${MAX_REASON_LENGTH} 字）`,
        },
      },
      required: ["op", "reason"],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema(
      "{ assemblyId, digest, op, target, addedId, by, executables }",
    ),
    // 改结构会影响后续**所有**组件的运行图，必须过审批门
    dangerLevel: "DANGEROUS",
    idempotency: "NO",
    reversibility: "PARTIAL",
    // 写的是组装体快照 + 审计（ckpt:conversation 空间），不触外部系统
    sideEffectScope: "workspace",
    // 仅外层（C5 宿主）：内层能改组装体 ⇒ 闭环检查形同虚设
    requiredRoles: ["prime_director"],
    sandboxMode: "none",
    timeoutMs: 30_000,
  },

  async execute(input, context) {
    const port = getToolServicePorts().orchestration;
    if (!port) {
      return toolError(
        context.operationId,
        "NOT_ENABLED",
        "组装闭环未装配（C5/C6/C7/S1 由组合根注入）；本次**未改动任何组装体**",
        false,
      );
    }

    const op = str(input["op"]);
    const reason = str(input["reason"]);
    const target = str(input["target"]);

    if (!CHANGE_OPS.includes(op as (typeof CHANGE_OPS)[number])) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        `op 必须是 ${CHANGE_OPS.join(" / ")}，实际为 "${op}"`,
        false,
      );
    }
    if (!reason) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        "缺少 reason（组装体变更必须可归因：谁/何时/换成什么/为何）",
        false,
      );
    }
    if (reason.length > MAX_REASON_LENGTH) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        `reason 过长（${reason.length} > ${MAX_REASON_LENGTH}）`,
        false,
      );
    }
    if ((op === "remove" || op === "replace") && !target) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        `${op} 变更必须指明 target 节点 id`,
        false,
      );
    }

    let added: AssemblyNodeDeclPort | undefined;
    if (op === "add" || op === "replace") {
      const decl = toNodeDecl(input["added"]);
      if (!decl) {
        return toolError(
          context.operationId,
          "INVALID_INPUT",
          `${op} 变更必须给出 added 节点，且 added.id 与 added.executableRef 均非空`,
          false,
        );
      }
      added = decl;
    }
    const change: AssemblyChangePort = {
      op: op as AssemblyChangePort["op"],
      ...(target ? { target } : {}),
      ...(added ? { added } : {}),
    };

    const out = await port.compose({ by: context.agentId, change });
    if (!out.ok) {
      return toolError(
        context.operationId,
        "INTERNAL",
        `组装变更执行失败：${out.error}`,
        true,
      );
    }
    const outcome = out.value;
    if (!outcome.committed) {
      if (outcome.violations.length > 0) {
        const detail = outcome.violations
          .map((v) => `${v.criterion}@${v.where}：${v.reason}`)
          .join(" | ");
        return toolError(
          context.operationId,
          "INVALID_INPUT",
          `组装体变更未通过检查树，**未提交**：${detail}`,
          true,
          { violations: outcome.violations },
        );
      }
      // 校验通过但提交环节失败（落盘 / 审计 / 摘要不匹配）⇒ 不是入参问题，如实报内部错误
      return toolError(
        context.operationId,
        "INTERNAL",
        `组装体变更已校验通过但**未提交**：${outcome.reason ?? "（提交器未给出理由）"}`,
        true,
      );
    }

    const current = port.currentAssembly();
    return toolSuccess(
      context.operationId,
      JSON.stringify(
        {
          assemblyId: outcome.assemblyId ?? current.id,
          digest: outcome.digest ?? "",
          op,
          target: target || null,
          addedId: added?.id ?? null,
          reason,
          by: context.agentId,
          executables: current.executables,
          hint: "新组装体已由持有者采用；下一次选件即按新结构进行。",
        },
        null,
        2,
      ),
    );
  },
};
