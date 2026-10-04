/**
 * tool.execute —— 通用工具执行元工具（**统一派发器的入口**）。
 *
 * 存在意义（设计依据：MongoTerminalAgent v2.0 工具头部冻结 + 统一派发器）：
 *  头部 `tools` 不能随会话变化（否则前缀缓存失效），因此无法把"探索到的新工具"加进头部。
 *  本工具让 Agent 用 **`tool.execute(name, args)`** 执行**任意已注册工具**：
 *  先用 `tool.search` 探索到工具 schema（schema 作为工具结果追加到上下文），再用本工具执行。
 *
 * 安全边界（重要）：
 *  - 本工具自身为 `CONTROLLED`：每次使用都会记入 EffectJournal（可审计、可幂等重放）；
 *  - **只允许执行 SAFE / CONTROLLED 工具**：DANGEROUS 工具必须出现在头部，
 *    否则安全门看不到它、无法触发审批 —— 这是刻意保留的红线，避免"借壳绕过审批"。
 */
import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { contentOutputSchema } from '../_shared.js';
import { getTool } from '../../Registry/toolRegistry.js';
import { dispatchToolCall } from '../../Registry/toolDispatcher.js';

export const toolExecutor: ToolDefinition = {
  spec: {
    name: 'tool.execute',
    version: '0.1.0',
    description:
      '执行任意已注册工具（统一派发）。用于执行**不在当前工具头部**中的工具：'
      + '先用 tool.search 查到它的名称与参数结构，再用本工具执行。'
      + '出于安全，危险级工具（DANGEROUS）不能经本工具执行，必须直接调用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要执行的工具名（如 file.write）' },
        arguments: { type: 'object', description: '该工具的参数对象（结构见 tool.search 返回）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ tool, status, durationMs, content }'),
    dangerLevel: 'CONTROLLED',
    idempotency: 'CONDITIONAL',
    idempotencyKeyFields: ['name', 'arguments'],
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'external',
    requiredRoles: ['prime_director', 'partner', 'worker', 'reviewer', 'assembly_node'],
    sandboxMode: 'none',
    timeoutMs: 120_000,
  },

  async execute(input, context) {
    const name = String(input['name'] ?? '').trim();
    if (!name) return toolError(context.operationId, 'INVALID_INPUT', '缺少 name（要执行的工具名）', false);
    if (name === 'tool.execute') {
      return toolError(context.operationId, 'INVALID_INPUT', '禁止递归调用 tool.execute', false);
    }

    const inner = getTool(name);
    if (!inner) {
      return toolError(context.operationId, 'TOOL_NOT_FOUND',
        `工具 ${name} 未注册；可用 tool.search 探索可用工具`, false);
    }
    // 安全边界：DANGEROUS 必须走头部（安全门可见），不得借壳执行
    if (inner.spec.dangerLevel === 'DANGEROUS' || inner.spec.dangerLevel === 'FORBIDDEN') {
      return toolError(context.operationId, 'ROLE_FORBIDDEN',
        `工具 ${name} 属 ${inner.spec.dangerLevel} 级，不能经 tool.execute 执行（需直接调用以便审批）`, false);
    }
    if (!inner.spec.requiredRoles.includes(context.agentRole)) {
      return toolError(context.operationId, 'ROLE_FORBIDDEN',
        `角色 ${context.agentRole} 无权调用 ${name}`, false);
    }

    const args = (input['arguments'] ?? {}) as Record<string, unknown>;
    // 统一派发（同一收口：角色门/超时/归一/埋点都在派发器内）
    const outcome = await dispatchToolCall({
      toolName: name,
      arguments: args,
      context: { ...context, operationId: context.operationId },
    });

    const payload = {
      tool: name,
      status: outcome.result.status,
      durationMs: outcome.durationMs,
      errorClass: outcome.errorClass ?? null,
      content: outcome.text,
    };

    if (outcome.result.status === 'error') {
      return toolError(context.operationId, outcome.result.error?.code ?? 'INTERNAL',
        `经 tool.execute 执行 ${name} 失败：${outcome.result.error?.message ?? '未知错误'}`, outcome.result.recoverable);
    }
    return toolSuccess(context.operationId, JSON.stringify(payload, null, 2));
  },
};
