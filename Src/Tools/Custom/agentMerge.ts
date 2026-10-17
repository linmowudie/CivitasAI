/**
 * AgentMerge —— **自合并请求**（向监管请求合并，工具自身不合并）。
 *
 * 设计依据：`Docs/Dev/L1编排设计/07-分裂与自合并.md` §3（G→H：调 AgentMerge 请求，**监管批准**才有结果）·
 *   `11-共享上下文.md` §3（相关性判定的输入来自共享上下文）·
 *   `17-账本-子代与兄弟.md` §3（`merge_requests` 是域账本的一项）
 *
 * 三条纪律：
 *  1. **本工具没有"合并"这个动作**：成功返回只表示**请求已被受理**（带受理号），
 *     域结构的改动唯一入口是 `DomainLedger.resolveMerge`（监管裁决侧调用）。
 *     若这里能直接合并，"监管批准"这一步就成了装饰（07 §3 的闭环断在 G 之后）。
 *  2. **依据必填**：`evidence` 是监管的判定输入。空依据的请求既无从裁决，也污染工单队列。
 *     长度上限在工具（形状）与域账本（不变量）两侧都有，**两侧各有独立负向测试** ——
 *     否则一处放宽另一处失效时无人发现。
 *  3. **目标必须是本域兄弟**：不在域内的 `withPeerId` 由域账本拒绝（判定归账本，工具不复制）。
 */
import type { ToolDefinition } from "../Traits/toolSpec.js";
import { toolSuccess, toolError } from "../Traits/toolSpec.js";
import { contentOutputSchema } from "../Builtin/_shared.js";
import { getToolServicePorts } from "../Registry/toolServicePorts.js";
// 合并语义层（设计 §3.7）：合并形态/同级关系判定（生产路径调用）
import { mergeKindOf } from "../../Core/AgentRuntime/splitSemantics.js";

const MAX_EVIDENCE_LENGTH = 500;

export const agentMerge: ToolDefinition = {
  spec: {
    name: "AgentMerge",
    version: "0.1.0",
    description:
      "向**监管**请求与某个同级兄弟合并（自分裂的收敛入口，需审批）。" +
      "触发条件：经共享上下文发现两边工作内容高度相关。" +
      '本工具只提交请求，**不会**合并 —— 批准后由监管裁决为"完全合并"或"归属转换"（子代转归另一方）。' +
      "必须给出相关性依据（evidence）；list=true 可同时返回本域兄弟清单。",
    inputSchema: {
      type: "object",
      properties: {
        withPeerId: {
          type: "string",
          description:
            "要与本 L1 合并的兄弟 id（必须 ∈ 本域；用 list=true 查看）",
        },
        absorbedId: {
          type: "string",
          description:
            "提议由谁被并入（只能是本 L1 或该兄弟之一）；缺省=把该兄弟并回本 L1",
        },
        evidence: {
          type: "string",
          description: `相关性依据（在共享上下文里看到了什么，≤${MAX_EVIDENCE_LENGTH} 字）`,
        },
        list: {
          type: "boolean",
          description: "是否同时返回本域视图（默认 false）",
        },
      },
      required: ["withPeerId", "evidence"],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema(
      "{ requestId, caseId, submitted, by, domain }",
    ),
    // 只发起请求，不改结构、不销毁任何 L1
    dangerLevel: "CONTROLLED",
    // 重复请求会被域账本拒（同一对不得有两条未裁决请求）——不是幂等重放
    idempotency: "NO",
    reversibility: "PARTIAL",
    sideEffectScope: "workspace",
    requiredRoles: ["prime_director", "partner"],
    sandboxMode: "none",
    timeoutMs: 15_000,
  },

  async execute(input, context) {
    const port = getToolServicePorts().splitMergeFor?.(context.agentId);
    if (!port) {
      return toolError(
        context.operationId,
        "NOT_ENABLED",
        `自合并链路未装配（agentId=${context.agentId} 未登记为域宿主，域账本与监管提交口由组合根按身份注入）；本次**未提交任何合并请求**`,
        false,
      );
    }

    const withPeerId =
      typeof input["withPeerId"] === "string"
        ? (input["withPeerId"] as string).trim()
        : "";
    const absorbedId =
      typeof input["absorbedId"] === "string"
        ? (input["absorbedId"] as string).trim()
        : "";
    const evidence =
      typeof input["evidence"] === "string"
        ? (input["evidence"] as string).trim()
        : "";
    const withList = input["list"] === true;
    const domain = port.domainView();

    if (!withPeerId) {
      // 与 OrchestratorSelect 同纪律：空目标不得被当成"查看清单"的副作用路径
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        "缺少 withPeerId（要查看本域兄弟请带 list=true，但合并目标不可为空）",
        false,
        { domain },
      );
    }
    if (!evidence) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        "缺少 evidence（监管需要相关性依据才能裁决）",
        false,
        withList ? { domain } : undefined,
      );
    }
    if (evidence.length > MAX_EVIDENCE_LENGTH) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        `evidence 过长（${evidence.length} > ${MAX_EVIDENCE_LENGTH}）`,
        false,
      );
    }

    // 合并语义层（生产调用点）：计算合并形态并随请求上报监管，供裁决参考。
    // 注意：**域归属判定归账本**（17 §3 的纪律），工具不复制该判定 ——
    // 目标不在本域仍由 DomainLedger 拒绝；这里只做"形态"标注，不做前置拦截。
    const mergeKind = mergeKindOf(context.agentId, withPeerId);

    const out = await port.requestMerge({
      by: context.agentId,
      withPeerId,
      ...(absorbedId ? { absorbedId } : {}),
      evidence,
    });
    if (!out.ok) {
      // 端口报 err ⇒ 提交失败且**撤销也失败**：存在无人受理的悬挂请求
      return toolError(
        context.operationId,
        "INTERNAL",
        `合并请求状态未知：${out.error}`,
        true,
      );
    }

    const outcome = out.value;
    if (!outcome.submitted) {
      if (outcome.failure === "request_rejected") {
        // 账本拒了这条请求（目标不在域内 / 重复请求 / 依据不合形）⇒ 入参问题
        return toolError(
          context.operationId,
          "INVALID_INPUT",
          `合并请求未被登记：${outcome.reason}`,
          true,
          { domain: port.domainView() },
        );
      }
      // 已登记但未能交给监管（并已撤销）⇒ 是链路问题，不是模型能改的入参
      return toolError(
        context.operationId,
        "INTERNAL",
        `合并请求未能提交监管：${outcome.reason}`,
        true,
      );
    }

    return toolSuccess(
      context.operationId,
      JSON.stringify(
        {
          requestId: outcome.requestId,
          caseId: outcome.caseId,
          submitted: true,
          merged: false,
          mergeKind,
          by: context.agentId,
          domain: port.domainView(),
          ...(withList ? { peers: domain.peers } : {}),
          hint: '请求已提交监管，**尚未合并**。批准结果只会是"完全合并"或"归属转换"，由监管裁决后生效。',
        },
        null,
        2,
      ),
    );
  },
};
