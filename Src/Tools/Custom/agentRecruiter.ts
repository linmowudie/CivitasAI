/**
 * agent.recruit —— 招募子 Agent（多 Agent 核心能力，2026-10-03 接线，替代原 S10 桩实现）。
 *
 * 设计依据：`Docs/Agent/03-Agent编排引擎/Agent编排引擎设计.md` §5.1
 *  - **仅 L1 入口级 Agent 可招募**（Prime Director / Partner）→ 由 `requiredRoles` 约束；
 *  - 招募时须分配**工具白名单**、**Token 预算**、**迭代上限**、**时限**；
 *  - 治理三权（Regulator / Auditor / Arbitrator）**不参与编排**，因此**不允许被招募**。
 *
 * 治理与安全：
 *  - `dangerLevel: DANGEROUS` → 每次招募都须经安全门/审批（与"招募=不可逆外部副作用"一致）；
 *  - 每个 trace 的**存活子 Agent 数上限**（默认 8）→ 防止模型递归招募导致失控；
 *  - 所有约束落库到 `agents` 表，便于审计与重启恢复（此前这些字段被完全忽略）。
 *
 * 边界（诚实说明）：本工具负责**招募 + 登记任务与约束**；把子任务真正派发到子 Agent 执行
 * 由 `POST /api/agents/<agentId>/execute`（Core/AgentRuntime/agentExecutor，FE-072 实装）
 * 或编排链指派驱动——返回值以 `dispatch: 'manual'` 如实标注驱动方式。
 */
import type { ToolDefinition } from '../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../Traits/toolSpec.js';
import { contentOutputSchema } from '../Builtin/_shared.js';
import {
  getToolServicePorts, type RecruitableRolePort,
} from '../Registry/toolServicePorts.js';

/** 允许被招募的角色（治理三权除外；worker/reviewer/partner/assembly_node 可被招募） */
const RECRUITABLE_ROLES: readonly RecruitableRolePort[] = [
  'worker', 'reviewer', 'partner', 'assembly_node',
];

/** 治理三权：系统指派、不可被 Agent 招募 */
const GOVERNANCE_ROLES: readonly string[] = ['regulator', 'auditor', 'arbitrator'];

/** 每个 trace 同时存活的子 Agent 上限（防止递归招募失控） */
export const MAX_LIVE_SUBAGENTS_PER_TRACE = 8;

/** 默认编排约束（工具入参可覆盖，均有上下限校验） */
const DEFAULT_TOKEN_BUDGET = 50_000;
const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_TIME_LIMIT_MS = 120_000;

export const agentRecruiter: ToolDefinition = {
  spec: {
    name: 'agent.recruit',
    version: '0.2.0',
    description:
      '招募一个新的子 Agent 来执行特定任务（仅 L1 入口级 Agent 可用，需审批）。'
      + '必须说明角色与任务；可为该 Agent 设定 Token 预算与迭代上限（缺省使用系统默认）。'
      + '招募后子 Agent 处于 ready 状态，其任务与约束会被登记，随后由编排调度派发执行。',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: 'Agent 角色：worker（执行）/ reviewer（评审）/ partner（协作）/ assembly_node（装配）',
          enum: [...RECRUITABLE_ROLES],
        },
        task: { type: 'string', description: '该 Agent 要完成的任务（简明、可验收）' },
        tokenBudget: { type: 'number', description: `Token 预算（默认 ${DEFAULT_TOKEN_BUDGET}）` },
        maxIterations: { type: 'number', description: `最大迭代轮数（默认 ${DEFAULT_MAX_ITERATIONS}）` },
        requiredTools: {
          type: 'array',
          description: '该 Agent 允许使用的工具白名单（缺省不限制）',
          items: { type: 'string' },
        },
      },
      required: ['role', 'task'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ agentId, role, status, parentAgentId, tokenBudget, maxIterations, allowedTools, dispatch }'),
    dangerLevel: 'DANGEROUS',
    idempotency: 'NO',
    reversibility: 'IRREVERSIBLE',
    sideEffectScope: 'external',
    // 仅 L1 入口级 Agent（编排引擎 v2.2：Prime Director + Partner 具备编排能力）
    requiredRoles: ['prime_director', 'partner'],
    sandboxMode: 'none',
    timeoutMs: 30_000,
  },

  async execute(input, context) {
    const port = getToolServicePorts().recruitment;
    if (!port) {
      return toolError(context.operationId, 'NOT_ENABLED',
        '招募服务未装配（由组合根注入）；本次未创建任何 Agent', false);
    }

    const role = String(input['role'] ?? '').trim();
    const task = String(input['task'] ?? '').trim();

    // ── 输入校验 ──
    if (!role) return toolError(context.operationId, 'INVALID_INPUT', '缺少 role（招募角色）', false);
    if (!task) return toolError(context.operationId, 'INVALID_INPUT', '缺少 task（该 Agent 要做的任务）', false);
    if (task.length > 2000) {
      return toolError(context.operationId, 'INVALID_INPUT', `task 过长（${task.length} > 2000），请精简`, false);
    }
    if (GOVERNANCE_ROLES.includes(role)) {
      return toolError(context.operationId, 'INVALID_INPUT',
        `角色 ${role} 属治理三权（Regulator/Auditor/Arbitrator），由系统指派，不可被招募`, false);
    }
    if (!RECRUITABLE_ROLES.includes(role as RecruitableRolePort)) {
      return toolError(context.operationId, 'INVALID_INPUT',
        `角色 ${role} 不可招募；可用角色：${RECRUITABLE_ROLES.join(' / ')}`, false);
    }
    if (!context.traceId) {
      return toolError(context.operationId, 'INVALID_INPUT', '当前运行缺少 traceId，无法招募（招募必须归属某个运行会话）', false);
    }

    // ── 预算/迭代上限校验 ──
    const tokenBudget = input['tokenBudget'] !== undefined ? Number(input['tokenBudget']) : DEFAULT_TOKEN_BUDGET;
    const maxIterations = input['maxIterations'] !== undefined ? Number(input['maxIterations']) : DEFAULT_MAX_ITERATIONS;
    if (!Number.isFinite(tokenBudget) || tokenBudget < 100 || tokenBudget > 2_000_000) {
      return toolError(context.operationId, 'INVALID_INPUT', 'tokenBudget 必须是 100..2000000 之间的数字', false);
    }
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 200) {
      return toolError(context.operationId, 'INVALID_INPUT', 'maxIterations 必须是 1..200 之间的整数', false);
    }
    const rawTools = input['requiredTools'];
    const requiredTools = Array.isArray(rawTools) ? rawTools.map((t) => String(t)) : [];

    // ── 招募上限保护（防止递归招募失控）──
    const live = port.getRecruitedAgents(context.traceId)
      .filter((a) => a.status !== 'destroyed');
    if (live.length >= MAX_LIVE_SUBAGENTS_PER_TRACE) {
      return toolError(context.operationId, 'LIMIT_EXCEEDED',
        `本运行已存活 ${live.length} 个子 Agent，达到上限 ${MAX_LIVE_SUBAGENTS_PER_TRACE}；请先完成或开除部分 Agent`, false);
    }

    // ── 招募 ──
    const result = port.recruitAgent({
      role: role as RecruitableRolePort,
      domain: 'general',
      taskPrompt: task,
      requiredTools,
      tokenBudget,
      maxIterations,
      timeLimitMs: DEFAULT_TIME_LIMIT_MS,
      traceId: context.traceId,
      parentAgentId: context.agentId,
    });

    if (!result.ok) {
      return toolError(context.operationId, 'INTERNAL', `招募失败：${result.error}`, true);
    }

    const agent = result.value;
    return toolSuccess(context.operationId, JSON.stringify({
      agentId: agent.agentId,
      role: agent.role,
      status: agent.status,
      parentAgentId: context.agentId,
      traceId: context.traceId,
      tokenBudget,
      maxIterations,
      allowedTools: requiredTools,
      task,
      // FE-072：执行入口已提供（POST /api/agents/<agentId>/execute）——如实标注为手动/编排驱动
      dispatch: 'manual',
      hint: '子 Agent 已就绪并把任务与约束登记入库；经 POST /api/agents/<agentId>/execute 驱动执行（编排链指派亦可达）。',
    }, null, 2));
  },
};
