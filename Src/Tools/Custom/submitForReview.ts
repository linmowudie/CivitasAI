/**
 * agent.submit_review —— 提交审核（2026-10-04 接线，替代原 S9 桩实现）。
 *
 * 设计依据：Docs/Agent/02 §6「Worker 不可自行宣告完成，必须走 submitForReview」
 * （执行级角色统一为 worker / partner / assembly_node）。
 *
 * 评审链路（FE-050 接线；FE-056/057 实装验证管线）：
 *   [1] submitForReview —— 登记待审（Agent 进入 awaitingApproval）
 *   [2] ensureReviewerAgent —— 复用/创建本 trace 的独立 Reviewer（Maker-Checker 分离）
 *   [3] performReview —— 四级验证管线（L1 结构 → L2 规则 → L3 异模型 LLM Judge，ADR-0003/0004）
 *   [4] markSubtaskReviewed —— 评审结论回写 subtasks 台账（completed / failed）
 *
 * 边界（诚实说明）：L3 Judge 需可用异模型（routing.verifierModel → 其他候选）；无可用异模型时
 * 降级为 L1+L2（仍满足 minLevelsRequired=2）；Judge 调用失败按 fail-closed 拒绝。
 */

import type { ToolDefinition } from '../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../Traits/toolSpec.js';
import { contentOutputSchema } from '../Builtin/_shared.js';
import { getToolServicePorts } from '../Registry/toolServicePorts.js';

export const submitForReview: ToolDefinition = {
  spec: {
    name: 'agent.submit_review',
    version: '0.2.0',
    description:
      '提交任务成果给 Reviewer 审核（执行级 Agent 不得自行宣告完成）。'
      + '提交后由本 trace 的独立 Reviewer 审核；通过即视为子任务完成，被拒需修改后重新提交。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '子任务 ID（即派发时分配给你的 taskId / assignmentId）' },
        summary: { type: 'string', description: '成果摘要（供 Reviewer 审核）' },
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: '产物路径列表',
        },
      },
      required: ['taskId', 'summary'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ reviewId, status, reviewerAgentId, comment }'),
    dangerLevel: 'CONTROLLED',
    idempotency: 'CONDITIONAL',
    idempotencyKeyFields: ['taskId'],
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'workspace',
    // FE-050：执行级角色均可提交（partner/assembly_node 此前无评审通道）
    requiredRoles: ['worker', 'partner', 'assembly_node'],
    sandboxMode: 'none',
    timeoutMs: 15_000,
  },

  async execute(input, context) {
    const port = getToolServicePorts().review;
    if (!port) {
      return toolError(context.operationId, 'NOT_ENABLED',
        '评审链路未装配（由组合根注入）；本次未提交任何评审', false);
    }

    const taskId = String(input['taskId'] ?? '').trim();
    const summary = String(input['summary'] ?? '').trim();
    const artifacts = Array.isArray(input['artifacts'])
      ? (input['artifacts'] as unknown[]).map(String)
      : [];

    // ── 输入校验 ──
    if (!taskId) return toolError(context.operationId, 'INVALID_INPUT', '缺少 taskId（子任务 ID）', false);
    if (!summary) return toolError(context.operationId, 'INVALID_INPUT', '缺少 summary（成果摘要）', false);
    if (summary.length > 4000) {
      return toolError(context.operationId, 'INVALID_INPUT', `summary 过长（${summary.length} > 4000），请精简`, false);
    }
    if (!context.traceId) {
      return toolError(context.operationId, 'INVALID_INPUT', '当前运行缺少 traceId，无法提交评审', false);
    }

    // [1] 登记待审（执行级角色且必须处于 running）
    const submitResult = port.submitForReview({
      taskId,
      workerAgentId: context.agentId,
      payload: { summary, artifacts, submittedBy: context.agentRole },
    });
    if (!submitResult.ok) {
      return toolError(context.operationId, 'INVALID_STATE', submitResult.error, false);
    }

    // [2] 确保独立 Reviewer 存在（Maker-Checker 分离）
    const reviewerResult = port.ensureReviewerAgent(context.traceId);
    if (!reviewerResult.ok) {
      return toolError(context.operationId, 'INTERNAL', `创建 Reviewer 失败：${reviewerResult.error}`, true);
    }

    // [3] 执行评审（FE-056/057：四级验证管线 L1+L2+[L3 异模型 Judge]，替代原“默认接受”桩）
    const reviewResult = await port.performReview({
      taskId,
      reviewerAgentId: reviewerResult.value.agentId,
    });
    if (!reviewResult.ok) {
      return toolError(context.operationId, 'INTERNAL', `评审失败：${reviewResult.error}`, true);
    }

    const accepted = reviewResult.value.status === 'accepted';

    // [4] 评审结论回写子任务台账（subtasks 表）
    port.markSubtaskReviewed(taskId, accepted, reviewResult.value.reviewerComment);

    return toolSuccess(context.operationId, JSON.stringify({
      reviewId: submitResult.value.reviewId ?? reviewResult.value.reviewId,
      taskId,
      status: reviewResult.value.status,
      reviewerAgentId: reviewerResult.value.agentId,
      comment: reviewResult.value.reviewerComment,
    }, null, 2));
  },
};
