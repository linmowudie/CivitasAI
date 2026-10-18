/**
 * AgentSplit —— **自分裂**（召唤 1 个同级 L1）。
 *
 * 设计依据：`Docs/Dev/L1编排设计/07-分裂与自合并.md` §3（发起者与被召唤者都是 L1、**同级/兄弟**）·
 *   `05-上下文作用域.md` §9.4（两者不共享会话上下文/预算，只共享协同用的共享上下文）·
 *   `10-组件的三集合.md`（内层 L1 工具集含 split/merge，**不含** compose）·
 *   `17-账本-子代与兄弟.md` §0（split 走**域账本**，不走下级账本）
 *
 * 三条纪律：
 *  1. **每次 1 个**：入参只有一个 `task`，没有 `tasks` 数组（`additionalProperties:false`
 *     把"一次拆一批"挡在形状层）。批量语义属于模型如何多次调用，不属于账本。
 *  2. **冲突域必填**：分裂的全部意义是"工作内容高度隔离"。域之间不得重叠的判据归
 *     `DomainLedger.addPeer`（唯一持有者），本工具**不复制**该判定。
 *  3. **兄弟不是下级**：工具没有任何途径把它记成子代 —— 端口依赖里就没有 `ChildRegistry`
 *     （构造上不可见，见 17 §5 反例 2 与 16 §9 规则 2 的同族纪律）。
 *
 * 权限：`requiredRoles: ['prime_director','partner']` —— 只有 L1 入口级角色有"同级"可分裂；
 * worker/reviewer 是被招募的**下级**，再分裂就变成递归招募失控。
 */
import type { ToolDefinition } from "../Traits/toolSpec.js";
import { toolSuccess, toolError } from "../Traits/toolSpec.js";
import { contentOutputSchema } from "../Builtin/_shared.js";
import { getToolServicePorts } from "../Registry/toolServicePorts.js";

const MAX_CONFLICT_DOMAIN_LENGTH = 120;
const MAX_TASK_LENGTH = 2000;

export const agentSplit: ToolDefinition = {
  spec: {
    name: "AgentSplit",
    version: "0.1.0",
    description:
      "自分裂：把当前任务按**冲突域**切出一份，召唤 1 个同级别的 L1 独立完成（每次只能召唤一个，需审批）。" +
      "两者各自运行完整的双层循环，**不共享**会话上下文与预算，只共享用于协同的共享上下文。" +
      "conflictDomain 必须与其他兄弟不同（同域=不隔离，会被域账本拒绝）。" +
      "后续若经共享上下文发现两边工作高度相关，用 AgentMerge 向监管请求合并。",
    inputSchema: {
      type: "object",
      properties: {
        conflictDomain: {
          type: "string",
          description: `本次拆分负责的冲突域（与其他兄弟隔离的边界，≤${MAX_CONFLICT_DOMAIN_LENGTH} 字）`,
        },
        task: {
          type: "string",
          description: `交给该兄弟的那一份任务（简明、可验收，≤${MAX_TASK_LENGTH} 字）`,
        },
      },
      required: ["conflictDomain", "task"],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema(
      "{ peerId, conflictDomain, sharedPublished, by, domain }",
    ),
    // 召唤一个**完整 L1**（自带预算与工具集）——与招募同级风险，必须过审批门
    dangerLevel: "DANGEROUS",
    idempotency: "NO",
    // 兄弟可经 AgentMerge 收敛回一个，但被召唤者已经跑掉的消耗不可回收
    reversibility: "PARTIAL",
    sideEffectScope: "external",
    requiredRoles: ["prime_director", "partner"],
    sandboxMode: "none",
    timeoutMs: 30_000,
  },

  async execute(input, context) {
    const port = getToolServicePorts().splitMergeFor?.(context.agentId);
    if (!port) {
      return toolError(
        context.operationId,
        "NOT_ENABLED",
        `分裂能力未装配（agentId=${context.agentId} 未登记为域宿主，域账本与同级 L1 工厂由组合根按身份注入）；本次**未召唤任何同级 L1**`,
        false,
      );
    }

    const conflictDomain =
      typeof input["conflictDomain"] === "string"
        ? (input["conflictDomain"] as string).trim()
        : "";
    const task =
      typeof input["task"] === "string" ? (input["task"] as string).trim() : "";

    if (!conflictDomain) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        "缺少 conflictDomain（分裂必须说明负责哪个冲突域，否则无从隔离）",
        false,
      );
    }
    if (conflictDomain.length > MAX_CONFLICT_DOMAIN_LENGTH) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        `conflictDomain 过长（${conflictDomain.length} > ${MAX_CONFLICT_DOMAIN_LENGTH}）`,
        false,
      );
    }
    if (!task) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        "缺少 task（交给兄弟的那一份任务）",
        false,
      );
    }
    if (task.length > MAX_TASK_LENGTH) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        `task 过长（${task.length} > ${MAX_TASK_LENGTH}），一次只拆一份`,
        false,
      );
    }

    // 分裂语义层（经端口注入调用，设计 §3.7）：先登记**授权单**（治理留痕；不伪造"已批准"），
    // 拿到受理号后再走端口分裂；成功后登记同级关系，供 AgentMerge 的
    // mergeKind / isPeerSplit 判定使用。
    const approval = port.requestSplitApproval({ conflictDomain, task });
    if (!approval.ok) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        `分裂授权登记失败：${approval.error}`,
        false,
      );
    }

    const out = await port.split({ conflictDomain, task });
    if (!out.ok) {
      // 端口报 err ⇒ 登记失败且**回收也失败**：兄弟 L1 在跑但无域归属
      return toolError(
        context.operationId,
        "INTERNAL",
        `分裂失去控制：${out.error}`,
        true,
      );
    }

    const outcome = out.value;
    if (!outcome.splitHappened) {
      if (outcome.failure === "domain_rejected") {
        // 域账本拒了这次登记 ⇒ 是入参（冲突域）问题，改域即可重试
        return toolError(
          context.operationId,
          "INVALID_INPUT",
          `分裂被域账本拒绝，**未召唤兄弟**：${outcome.reason}`,
          true,
          {
            domain: port.domainView(),
          },
        );
      }
      // 同级 L1 工厂失败：不是模型能改的入参问题
      return toolError(
        context.operationId,
        "INTERNAL",
        `分裂未发生：${outcome.reason}`,
        true,
      );
    }
    if (!outcome.sharedPublished) {
      // 兄弟已登记在跑，但域进展没广播出去 ⇒ 自合并判定无从发生（17 §5 反例 7）
      return toolError(
        context.operationId,
        "INTERNAL",
        `分裂部分完成：${outcome.reason}`,
        true,
        { peerId: outcome.peerId },
      );
    }

    // 同级关系登记（生产写方）：AgentMerge 的 mergeKind / isPeerSplit 依赖它
    if (outcome.peerId) port.registerPeerSplit(outcome.peerId);

    return toolSuccess(
      context.operationId,
      JSON.stringify(
        {
          peerId: outcome.peerId,
          conflictDomain: outcome.conflictDomain,
          sharedPublished: true,
          approvalId: approval.value.approvalId,
          by: context.agentId,
          domain: port.domainView(),
          hint:
            "兄弟 L1 已按该冲突域开始运行。它不进你的下级账本 —— 你不必等它收敛；" +
            "两边若经共享上下文发现工作高度相关，调 AgentMerge 向监管请求合并。",
        },
        null,
        2,
      ),
    );
  },
};
