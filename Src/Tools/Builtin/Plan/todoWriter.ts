/**
 * todo.write —— Agent 计划清单（TODO）维护工具。
 *
 * 语义（与主流 agent harness 的 plan/todo 工具一致）：
 *  - 一次提交**完整清单**（全量替换），而不是增量 patch；这样模型每次都能自我纠正；
 *  - 归属：写入**调用者自己的** agent 归属（多 agent 平级，各自一张计划表，互不覆盖）；
 *  - 状态：pending / in_progress / completed；建议同时只有一项 in_progress；
 *  - 无副作用（纯应用内状态）：危险级 SAFE，幂等 YES。
 *
 * 前端：右侧「计划」面板按 agent 分组实时展示，并按来源 agent 归因。
 */
import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { contentOutputSchema } from '../_shared.js';
import { getToolServicePorts, type TodoStatusPort } from '../../Registry/toolServicePorts.js';

const STATUS_VALUES: readonly TodoStatusPort[] = ['pending', 'in_progress', 'completed'];

/** 缺省条目上限（端口未注入时的 schema 文案回退值；与 Services/Planning/todoStore 默认一致） */
const FALLBACK_MAX_TODOS = 50;

export const todoWriter: ToolDefinition = {
  spec: {
    name: 'todo.write',
    version: '0.1.0',
    description:
      '维护你自己的任务计划清单（TODO）。一次提交完整清单：把已完成的标记为 completed、'
      + '正在做的标记为 in_progress、未开始的标记为 pending。用于多步任务的进度跟踪，'
      + '每完成一步就更新一次。清单会实时显示在界面的「计划」面板中（按 agent 归属）。',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: `完整清单（最多 ${FALLBACK_MAX_TODOS} 项，按执行顺序排列）`,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '待办内容（简明、可验证）' },
              status: {
                type: 'string',
                enum: [...STATUS_VALUES],
                description: 'pending=未开始；in_progress=进行中；completed=已完成（缺省 pending）',
              },
            },
            required: ['content'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ total, completed, pending, inProgress }'),
    dangerLevel: 'SAFE',
    idempotency: 'YES',
    // 全量替换：同样的 todos 提交两次得到同一份计划，幂等键即 todos 本身
    idempotencyKeyFields: ['todos'],
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'none',
    requiredRoles: ['prime_director', 'arbitrator', 'auditor', 'partner', 'worker', 'assembly_node', 'reviewer', 'regulator'],
    sandboxMode: 'none',
    timeoutMs: 5_000,
  },

  async execute(input, context) {
    const store = getToolServicePorts().todoStore;
    if (!store) {
      return toolError(context.operationId, 'NOT_ENABLED',
        '计划存储未装配（由组合根注入）；本次未写入任何计划', false);
    }

    const sessionId = context.sessionId;
    if (!sessionId) {
      return toolError(context.operationId, 'INVALID_INPUT', '当前运行没有绑定会话，无法维护计划清单', false);
    }
    const raw = input['todos'];
    if (!Array.isArray(raw)) {
      return toolError(context.operationId, 'INVALID_INPUT', '缺少 todos 数组（一次提交完整清单）', false);
    }

    const todos = raw.map((t) => {
      const rec = (t ?? {}) as Record<string, unknown>;
      const status = typeof rec['status'] === 'string' && (STATUS_VALUES as readonly string[]).includes(rec['status'])
        ? (rec['status'] as TodoStatusPort)
        : 'pending';
      return { content: String(rec['content'] ?? ''), status };
    }).filter((t) => t.content.trim() !== '');

    if (todos.length > store.maxTodos) {
      return toolError(context.operationId, 'INVALID_INPUT',
        `计划条目过多（${todos.length} > ${store.maxTodos}），请合并同类项`, false);
    }

    const result = store.replaceTodos({
      sessionId,
      agentId: context.agentId,
      ...(context.agentRole ? { agentRole: String(context.agentRole) } : {}),
      todos,
    });

    if (!result.ok) {
      return toolError(context.operationId, 'INTERNAL', result.error, true);
    }

    const { progress } = result.value;
    const items = store.listTodosForAgent(sessionId, context.agentId);
    const lines = items.map((t) => {
      const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
      return `${mark} ${t.content}`;
    });

    return toolSuccess(context.operationId, JSON.stringify({
      total: progress.total,
      completed: progress.completed,
      pending: progress.pending,
      inProgress: progress.inProgress,
      plan: lines,
    }, null, 2));
  },
};
