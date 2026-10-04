/**
 * @module LoopControl/middleware/toolSafetyGate
 * @description
 * 工具安全门中间件——审查报告 P0-3。
 *
 * wrapToolCall 钩子，按工具危险分级强制执行：
 * - DANGEROUS + IRREVERSIBLE → ApprovalGate 审批门
 * - CONTROLLED / DANGEROUS+REVERSIBLE → EffectJournal 副作用日志
 * - SAFE → 直接放行
 *
 * 所有非 SAFE 工具执行前检查幂等缓存（IdempotencyStore DUR-005）。
 */

import type { AgentMiddleware, MiddlewareContext, ToolCallInput, ToolCallOutput } from '../../../Infra/Contracts/middlewareTypes.js';
import { ensureAgentsForRoles } from '../../Governance/governanceProvisioning.js';
import { checkViolation } from '../../Regulation/behaviorCode.js';
import { getTool } from '../../../Tools/Registry/toolRegistry.js';
import { recordIntent, updateEffectStatus, hashPayload } from '../../../Infra/DurableExecution/effectJournal.js';
import { makeIdempotencyKey, lookup as lookupIdempotency, store as storeIdempotency } from '../../../Infra/DurableExecution/idempotencyStore.js';
import { createApproval, registerApproval, forceApprove, waitForApprovalDecision } from '../approvalGate.js';
import { buildApprovalDeciders } from '../../Governance/governanceGuard.js';
import type { ApprovalDecider } from '../loopState.js';
import { publish, createEvent } from '../../EventBus/eventBus.js';
import { EventType } from '../../EventBus/eventTypes.js';
import { delay } from '../../../Infra/Llm/Provider/retryPolicy.js';
import { logger } from '../../../Infra/Logging/logger.js';

/** 工具安全门配置 */
export interface ToolSafetyGateConfig {
  /** 默认审批超时（秒） */
  approvalTimeoutSec: number;
  /** 审批人角色列表（对齐 ApprovalDecider，CRITICAL 级须 ≥ 2 个不同角色） */
  approverRoles: ApprovalDecider[];
  /** 是否启用幂等缓存 */
  enableIdempotency: boolean;
  /**
   * 自动审批工具白名单：命中的工具**无需用户确认**，
   * 仅展示"L0 审查中"动画后自动通过并执行。
   */
  autoApproveTools: string[];
  /** 自动审批时保留的审查动画时长（ms），让"审查中"可被感知 */
  autoApproveDelayMs: number;
}

const DEFAULT_CONFIG: ToolSafetyGateConfig = {
  approvalTimeoutSec: 60,
  // ★ 审批人默认构成（2026-10-04 修复"层级自审"）：
  //   设计意图为 **L0 治理角色**（审批域词表：auditor / regulatory_authority）审查 + 用户确认；
  //   旧默认值是 `user + prime_director`，其中 prime_director 属 L1 入口级，
  //   正是发起危险调用的层级 → 等于自审。此处改为 L0 治理角色 + 用户。
  approverRoles: [
    { role: 'user', weight: 1 },
    { role: 'auditor', weight: 1 },
    { role: 'regulatory_authority', weight: 1 },
  ],
  enableIdempotency: true,
  autoApproveTools: [],
  autoApproveDelayMs: 600,
};

/**
 * 审批域的 **L0 治理角色**。
 *
 * 词表注意：审批域用的是 `Services/LoopControl/types.ts` 的 `UserRole`
 * （`user | prime_director | regulatory_authority | auditor`），
 * 与 `Infra/types.ts` 的执行域 `UserRole`（prime_director/partner/worker/...）**不是同一套**。
 * 因此这里**不能**写 `regulator` / `arbitrator`（那是执行域/编排域的称呼）。
 */
const GOVERNANCE_ROLES = ['auditor', 'regulatory_authority'] as const;

/**
 * 构造**不可逆操作**的审批人列表（2026-10-04 新增）。
 *
 * 规则（修复层级自审）：
 *  1. 必须包含 `user`（人类所有者确认）——除非配置显式移除；
 *  2. 必须包含 **L0 治理角色**（auditor/regulator/arbitrator）；
 *  3. **剔除请求方自身的角色**（谁发起谁不批，杜绝自审）；
 *  4. CRITICAL 需要 ≥2 个不同角色（`createApproval` 会再次校验）。
 *
 * 若配置里给了自定义 approverRoles，则在其基础上**强制补齐 L0 与用户**，
 * 并同样剔除请求方角色——保证"配置可调，但红线不破"。
 */
export function buildIrreversibleDeciders(
  requesterRole: string,
  configured: ApprovalDecider[],
  poolOverride?: Array<{ role: string; weight: number }>,
  options: { maxGovernanceRoles?: number } = {},
): ApprovalDecider[] {
  // 若调用方已按层级给出决策池（推荐路径，见 governanceGuard.buildApprovalDeciders），直接采用 + 红线兜底
  if (poolOverride && poolOverride.length > 0) {
    const seenRoles = new Set<string>();
    const picked: ApprovalDecider[] = [];
    for (const d of poolOverride) {
      if (d.role === requesterRole) continue; // 请求方不得自审
      if (seenRoles.has(d.role)) continue;
      seenRoles.add(d.role);
      picked.push({ role: d.role as ApprovalDecider['role'], weight: d.weight ?? 1 });
    }
    if (!picked.some(d => d.role === 'user')) picked.unshift({ role: 'user', weight: 1 });
    if (!picked.some(d => d.role === 'auditor' || d.role === 'regulatory_authority')) {
      picked.push({ role: 'auditor', weight: 1 });
    }
    return picked;
  }
  const seen = new Set<string>();
  const out: ApprovalDecider[] = [];
  const push = (role: ApprovalDecider['role'], weight = 1) => {
    if (role === requesterRole) return; // 3) 请求方不得自审
    if (seen.has(role)) return;
    seen.add(role);
    out.push({ role, weight });
  };

  // 1) 用户确认（放在最前，界面优先展示）
  const userDecider = configured.find(d => d.role === 'user');
  push('user', userDecider?.weight ?? 1);

  // 2) L0 治理角色：配置里有的优先，其次按默认顺序补齐
  // L0 审批人**只取 1 名**：unanimous 策略要求"每个审批角色都通过"，
  // 取 2 名 L0 会导致必须三人在场才能放行（与 `criticalApprovalRoles: 2` 的双人控制语义不符）。
  // 最终审批人 = 用户 + 1 名 L0 治理角色 = 恰好 2 个角色。
  const maxGov = options.maxGovernanceRoles ?? 1;
  const configuredGov = configured
    .filter(d => (GOVERNANCE_ROLES as readonly string[]).includes(d.role as string))
    .map(d => d.role as string);
  const govOrder: ApprovalDecider['role'][] = [
    ...(configuredGov as ApprovalDecider['role'][]),
    ...GOVERNANCE_ROLES.filter(r => !configuredGov.includes(r)),
  ];
  let govCount = 0;
  for (const role of govOrder) {
    if (govCount >= maxGov) break;
    const before = out.length;
    push(role, configured.find(d => d.role === role)?.weight ?? 1);
    if (out.length > before) govCount++;
  }

  // 3) 兜底：若因"请求方即治理角色"导致不足 2 个角色，补齐剩余治理角色
  for (const role of GOVERNANCE_ROLES) {
    if (out.length >= 2) break;
    push(role);
  }
  return out;
}

/**
 * 全局配置覆盖（由启动期从 `Configs/security.json → security.autoApprove` 注入）。
 * 单个 Loop 实例可通过 createToolSafetyGateMiddleware 的 config 参数覆盖。
 */
let globalConfigOverride: Partial<ToolSafetyGateConfig> = {};

/** 启动期配置安全门（自动审批白名单 / 审查动画时长） */
export function configureToolSafetyGate(config: Partial<ToolSafetyGateConfig>): void {
  globalConfigOverride = { ...globalConfigOverride, ...config };
}

/**
 * 创建工具安全门中间件
 *
 * 注册为 wrapToolCall 钩子，按工具危险分级执行不同管控策略。
 */
export function createToolSafetyGateMiddleware(
  getLoopId: () => string,
  getIteration: () => number,
  getTraceId: () => string,
  config: Partial<ToolSafetyGateConfig> = {},
): AgentMiddleware {
  const cfg = { ...DEFAULT_CONFIG, ...globalConfigOverride, ...config };

  return {
    name: 'ToolSafetyGate',
    hook: 'wrapToolCall',
    priority: 1,  // 最高优先级，先于其他 wrap 中间件
    canShortCircuit: true,

    execute: async (
      ctx: MiddlewareContext,
      input: ToolCallInput,
      next: (input: ToolCallInput) => Promise<ToolCallOutput>,
    ): Promise<ToolCallOutput> => {
      const toolDef = getTool(input.toolName);

      // 工具未注册 → 直接透传（由 toolRegistry 返回 TOOL_NOT_FOUND）
      if (!toolDef) {
        return next(input);
      }

      const { dangerLevel, reversibility, idempotency } = toolDef.spec;
      const loopId = getLoopId();
      const iteration = getIteration();
      const traceId = getTraceId();

      // ── FORBIDDEN 硬拒（纵深防御，运行期第二道闸）──
      // 注册期 specValidator 已拒绝 FORBIDDEN 规格，此处拦截一切绕过注册的执行。
      if (dangerLevel === 'FORBIDDEN') {
        logger.warn('FORBIDDEN 工具执行被拒绝', {
          source: 'ToolSafetyGate', tool: input.toolName,
        });
        return {
          status: 'error',
          content: `工具 ${input.toolName} 为 FORBIDDEN 级别，已拒绝执行`,
          recoverable: false,
        };
      }

      // ── 行为法典检查（FE-060：enforceable 规则命中 → 拒绝执行）──
      //   规则由治理者经 `POST /api/regulation/rules` 维护（默认规则集不含工具禁用规则——
      //   机制已接、策略可配；如添加 `tool.forbid(shell.exec)` 即真实阻断）。
      const violation = checkViolation({
        agentId: ctx.agentId,
        action: input.toolName,
        context: { args: input.arguments, role: ctx.agentRole },
      });
      if (violation.violated) {
        const rule = violation.rules[0];
        logger.warn('行为准则违规，拒绝工具执行', {
          source: 'ToolSafetyGate',
          tool: input.toolName,
          agentId: ctx.agentId,
          ruleId: rule?.ruleId,
          severity: rule?.severity,
        });
        return {
          status: 'error',
          content: `行为准则禁止此操作（${rule?.ruleId ?? 'unknown'}：${rule?.description ?? ''}）`,
          recoverable: false,
        };
      }

      // ── 幂等缓存检查（DUR-005）──
      if (cfg.enableIdempotency && idempotency !== 'NO') {
        const idemKey = makeIdempotencyKey(input.toolName, input.arguments, loopId);
        const lookup = lookupIdempotency(idemKey);
        if (lookup.ok && lookup.value.hit) {
          logger.info('幂等缓存命中，跳过重复执行', {
            source: 'ToolSafetyGate', tool: input.toolName, idemKey: idemKey.slice(0, 16),
          });
          return {
            status: 'success',
            content: JSON.stringify({ idempotent: true, cachedResult: lookup.value.result }),
            recoverable: false,
          };
        }
      }

      // ── DANGEROUS + IRREVERSIBLE → ApprovalGate（**阻塞式**）──
      // 语义（2026-10-01 需求）：先阻塞，等 L0 级最高权限审查确认 / 用户点击确认；
      // 自动审批（白名单）则无需用户确认，仅播放"审查中"动画后自动通过；确认后放开阻塞并执行。
      // ★ 审批人构成（2026-10-04 修复"层级自审"）：
      //   设计意图是 **L0 治理三权**（Regulator / Auditor / Arbitrator）审查 + 用户确认；
      //   而此前 defaults 里放的是 `prime_director`（L1 入口级）—— 正是发起危险调用的层级，
      //   等于"自己这级批自己"，构成自审。现改为：**用户 + L0 治理角色**，并剔除请求方自身角色。
      if (dangerLevel === 'DANGEROUS' && reversibility === 'IRREVERSIBLE') {
        // ★ 按**请求方层级**构造决策池（2026-10-04，对齐产品规则）：
        //   L2（worker/reviewer/assembly_node）属 L1 自治域 → 用户 / L1 / L0 **任意两方**即可；
        //   L1（prime_director/partner）自身或治理侧 → 只能 **用户 + L0**（L1 不得自审）。
        const pool = buildApprovalDeciders(ctx.agentRole);
        const deciders = buildIrreversibleDeciders(ctx.agentRole, cfg.approverRoles, pool.deciders);
        // ★ 按需创建 / 按需扩容（2026-10-04，用户裁定"L0 按需求创建并按需求扩容"）：
        //   决策池中的**治理角色必须有真实 Agent 实例**，这样裁决才能归属真实 Agent 身份，
        //   而不必依赖"人类代理"路径。失败不阻断审批创建（仍有代理兜底 + 治理留痕）。
        try {
          const ensured = ensureAgentsForRoles(
            deciders.map(d => String(d.role)),
            { traceId, reason: `不可逆操作审批决策池（${input.toolName}）` },
          );
          logger.info('审批决策池角色已确保存在', {
            source: 'toolSafetyGate/approval',
            toolName: input.toolName,
            roles: [...ensured.keys()],
            agents: [...ensured.values()],
          });
        } catch (e) {
          logger.warn('审批决策池角色按需创建失败（继续创建审批，靠代理兜底）', {
            source: 'toolSafetyGate/approval',
            toolName: input.toolName,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        const approvalResult = createApproval({
          loopId,
          traceId,
          iteration,
          requestedBy: ctx.agentId,
          kind: 'irreversible_action',
          payload: { toolName: input.toolName, arguments: input.arguments },
          riskLevel: 'CRITICAL',
          timeoutSec: cfg.approvalTimeoutSec,
          defaultOnTimeout: 'reject',
          deciders,
          // 法定人数 2：不同角色须由不同身份满足（"任意两方"）
          requiredApprovals: pool.requiredApprovals,
        });

        if (!approvalResult.ok) {
          return {
            status: 'error',
            content: `审批创建失败: ${approvalResult.error}`,
            recoverable: false,
          };
        }

        const approval = approvalResult.value;
        // 关联到具体工具调用，前端才能把审批内嵌到对话中对应的工具行
        approval.toolCallId = input.toolCallId;
        approval.toolName = input.toolName;
        approval.sessionId = ctx.sessionId;
        registerApproval(approval);

        logger.warn('危险工具审批请求已创建（阻塞执行中）', {
          source: 'ToolSafetyGate',
          tool: input.toolName,
          approvalId: approval.approvalId,
          riskLevel: 'CRITICAL',
          timeoutSec: approval.timeoutSec,
        });

        publish(createEvent({
          eventType: EventType.APPROVAL_REQUESTED,
          source: 'ToolSafetyGate',
          payload: {
            approvalId: approval.approvalId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            arguments: input.arguments,
            sessionId: ctx.sessionId,
            kind: 'irreversible_action',
            riskLevel: 'CRITICAL',
            timeoutSec: approval.timeoutSec,
            loopId,
            iteration,
          },
        }));

        const shouldAutoApprove = cfg.autoApproveTools.includes(input.toolName);

        if (shouldAutoApprove) {
          // 自动审批：无需用户确认，保留可感知的"审查中"动画后自动通过
          await delay(cfg.autoApproveDelayMs);
          // 策略性通过：忽略多人/双角色策略（人工审批才需要满足策略）
          forceApprove(approval.approvalId, 'policy:auto-approve', 'auto_approve_policy');
          logger.info('自动审批通过（策略白名单）', {
            source: 'ToolSafetyGate', tool: input.toolName, approvalId: approval.approvalId,
          });
          publish(createEvent({
            eventType: EventType.APPROVAL_DECIDED,
            source: 'ToolSafetyGate',
            payload: {
              approvalId: approval.approvalId,
              toolCallId: input.toolCallId,
              sessionId: ctx.sessionId,
              status: 'APPROVED',
              auto: true,
              decidedBy: 'policy:auto-approve',
            },
          }));
        } else {
          // 人工确认：阻塞等待决策 / 超时（默认拒绝）
          const decided = await waitForApprovalDecision(approval.approvalId, {
            timeoutMs: approval.timeoutSec * 1000,
          });

          if (!decided || decided.status !== 'APPROVED') {
            const status = decided?.status ?? 'ABORTED';
            const reason = decided?.decisionReason ? `：${decided.decisionReason}` : '';
            logger.warn('工具审批未通过，拒绝执行', {
              source: 'ToolSafetyGate', tool: input.toolName,
              approvalId: approval.approvalId, status,
            });
            publish(createEvent({
              eventType: EventType.APPROVAL_DECIDED,
              source: 'ToolSafetyGate',
              payload: {
                approvalId: approval.approvalId,
                toolCallId: input.toolCallId,
                sessionId: ctx.sessionId,
                status,
                auto: false,
              },
            }));
            return {
              status: 'error',
              content: `工具 ${input.toolName} 的人工审批未通过（${status}）${reason}，已拒绝执行`,
              recoverable: false,
            };
          }
        }
        // 审批通过（人工或自动）→ 放开阻塞，继续执行工具
      }

      // ── EffectJournal 副作用日志（CONTROLLED 及以上）──
      if (dangerLevel !== 'SAFE') {
        const effectId = `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
        const idemKey = makeIdempotencyKey(input.toolName, input.arguments, loopId);
        const pHash = hashPayload(input.arguments);

        const intentResult = recordIntent({
          effectId,
          loopId,
          iteration,
          kind: 'tool_execute',
          idempotencyKey: idemKey,
          payloadHash: pHash,
          // FE-027：带上工具调用 ID，使统计派生能把"副作用日志"与"工具调用事件"精确配对
          toolCallId: input.toolCallId,
        });

        if (!intentResult.ok) {
          logger.error('EffectJournal INTENT 写入失败，拒绝执行（fail-closed）', {
            source: 'ToolSafetyGate', tool: input.toolName, error: intentResult.error,
          });
          // 副作用必须先写 INTENT（Docs/Agent/12 §4 强一致）：写入失败则禁止执行，不允许静默放行。
          return {
            status: 'error',
            content: `副作用日志写入失败，工具 ${input.toolName} 已拒绝执行: ${intentResult.error}`,
            recoverable: false,
          };
        }

        // 标记为 EXECUTING
        updateEffectStatus({ effectId, status: 'EXECUTING' });

        // 执行工具
        const output = await next(input);

        // 更新最终状态
        const finalStatus = output.status === 'success' ? 'SUCCEEDED' : 'FAILED';
        updateEffectStatus({
          effectId,
          status: finalStatus as 'SUCCEEDED' | 'FAILED',
          result: output.content,
          errorClass: output.status === 'error'
            ? (output.recoverable ? 'retryable' : 'non_retryable')
            : undefined,
        });

        // 幂等缓存存储（成功时）
        if (output.status === 'success' && cfg.enableIdempotency && idempotency !== 'NO') {
          storeIdempotency(
            idemKey,
            loopId,
            typeof output.content === 'string' ? output.content : JSON.stringify(output.content),
          );
        }

        return output;
      }

      // ── SAFE → 直接放行 ──
      return next(input);
    },
  };
}
