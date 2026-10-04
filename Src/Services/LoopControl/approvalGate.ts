/**
 * @module LoopControl/approvalGate
 * @description
 * 审批门——Docs/Agent/11 §6。
 * 审批门 = 停止符的合法来源之一（ADR-0001）。
 * 队列功能真源为进程内 Map（阻塞等待依赖它）；生命周期写穿落库
 * （pending_approvals，FE-004）用于重启后回溯与「已决」历史可见（FE-005）。
 * 超时默认拒绝（禁止默认通过）。
 */

import type { Result } from '../../Infra/types.js';
import { getActiveOwner } from '../AccountScope/activeAccount.js';
import { ok, err } from '../../Infra/types.js';

import type { PendingApproval, ApprovalDecider } from './loopState.js';
import type { ApprovalKind, RiskLevel, DecisionPolicy } from './types.js';
import { persistApprovalCreated, persistApprovalUpdated, listPersistedApprovals } from './approvalPersistence.js';
// 治理层守卫（2026-10-04）：裁决审批属治理动作，仅 L0 / 人类所有者可执行
import { parseDecidedByRole } from '../Governance/governanceGuard.js';

// ── 创建审批请求 ────────────────────────────────────────────────────

export interface CreateApprovalInput {
  loopId: string;
  traceId: string;
  iteration: number;
  requestedBy: string;
  kind: ApprovalKind;
  payload: unknown;
  riskLevel: RiskLevel;
  timeoutSec?: number;
  defaultOnTimeout?: 'reject' | 'abort_loop';
  deciders: ApprovalDecider[];
  decisionPolicy?: DecisionPolicy;
  /** 法定人数：需要多少个不同角色（且不同身份）通过才放行（2026-10-04） */
  requiredApprovals?: number;
}

/**
 * 创建审批请求
 *
 * 规则：
 * - CRITICAL 级强制 unanimous 策略
 * - 超时默认拒绝（禁止默认通过）
 * - timeoutSec 保存生效时长快照（防配置热更新突变存量审批）
 */
export function createApproval(
  input: CreateApprovalInput,
  defaultTimeoutSec: number = 60,
): Result<PendingApproval> {
  if (input.deciders.length === 0) {
    return err('审批请求至少需要一个审批人');
  }

  // CRITICAL 级强制 unanimous
  const policy: DecisionPolicy = input.riskLevel === 'CRITICAL'
    ? 'unanimous'
    : (input.decisionPolicy ?? 'majority');

  // CRITICAL 级至少需要 2 个不同角色
  if (input.riskLevel === 'CRITICAL') {
    const roles = new Set(input.deciders.map(d => d.role));
    if (roles.size < 2) {
      return err('CRITICAL 级审批至少需要 2 个不同角色的审批人');
    }
  }

  const timeoutSec = input.timeoutSec ?? defaultTimeoutSec;
  const now = Date.now();

  const approval: PendingApproval = {
    approvalId: `${now}-${Math.random().toString(16).slice(2, 6)}`,
    loopId: input.loopId,
    traceId: input.traceId,
    iteration: input.iteration,
    requestedAt: now,
    requestedBy: input.requestedBy,
    kind: input.kind,
    payload: input.payload,
    riskLevel: input.riskLevel,
    timeoutSec,
    defaultOnTimeout: input.defaultOnTimeout ?? 'reject',
    deciders: input.deciders,
    decisionPolicy: policy,
    // 法定人数：显式给定时用它；否则由决定时按"角色数 ≥3 → 任意两方，否则全部"推导
    ...(input.requiredApprovals !== undefined ? { requiredApprovals: input.requiredApprovals } : {}),
    status: 'PENDING',
  };

  return ok(approval);
}

// ── 审批判定 ────────────────────────────────────────────────────────

export interface DecideInput {
  approvalId: string;
  decidedBy: string;
  approve: boolean;
  reason?: string;
}

/**
 * 审批队列（内存为主 + 落库回溯，FE-004）
 */
const approvalQueue: Map<string, PendingApproval> = new Map();

/**
 * 审批等待者：工具安全门发起审批后会**阻塞**在这里，
 * 直到人工决策 / 自动审批 / 超时 / 中断才被唤醒。
 */
const approvalWaiters = new Map<string, (approval: PendingApproval | null) => void>();

/** 状态落定（非 PENDING）时唤醒等待者 */
function notifyWaiter(approval: PendingApproval): void {
  if (approval.status === 'PENDING') return;
  const waiter = approvalWaiters.get(approval.approvalId);
  if (waiter) {
    approvalWaiters.delete(approval.approvalId);
    waiter({ ...approval });
  }
}

/**
 * 阻塞等待审批决策。
 *
 * 返回：
 * - 已决（APPROVED/REJECTED/TIMEOUT）→ 该审批记录
 * - 中断（signal aborted）或审批不存在 → null
 *
 * 超时按"默认拒绝"处理（禁止默认通过），并就地落 TIMEOUT 状态。
 */
export function waitForApprovalDecision(
  approvalId: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PendingApproval | null> {
  const approval = approvalQueue.get(approvalId);
  if (!approval) return Promise.resolve(null);
  if (approval.status !== 'PENDING') return Promise.resolve({ ...approval });

  const timeoutMs = options.timeoutMs ?? approval.timeoutSec * 1000;

  return new Promise<PendingApproval | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: PendingApproval | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      approvalWaiters.delete(approvalId);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const onAbort = () => finish(null);

    timer = setTimeout(() => {
      const current = approvalQueue.get(approvalId);
      if (current && current.status === 'PENDING') {
        current.status = 'TIMEOUT';
        current.decidedAt = Date.now();
        current.decisionReason = `超时 (${current.timeoutSec}s)`;
        persistApprovalUpdated(current);
      }
      finish(current ? { ...current } : null);
    }, timeoutMs);

    approvalWaiters.set(approvalId, finish);

    if (options.signal) {
      if (options.signal.aborted) { onAbort(); return; }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 注册审批请求到队列
 */
export function registerApproval(approval: PendingApproval): void {
  // 打上当前属主（账号隔离）：审批队列是内存态，必须按账号过滤
  const owned: PendingApproval = { ...approval, owner: approval.owner ?? getActiveOwner() };
  approvalQueue.set(owned.approvalId, owned);
  // 落库（FE-004，fail-safe）：重启后仍可回溯；失败不影响内存队列
  persistApprovalCreated(owned);
}

/**
 * 处理审批决定
 *
 * FE-003 加固：同一 decider 身份只计一次；unanimous 策略按「已满足的角色」判定，
 * `decidedBy` 需携带角色（`role:identity`，或与角色名相同的身份）——
 * 重复提交同一身份不再累计满足多角色要求。
 */
export function decideApproval(input: DecideInput): Result<PendingApproval> {
  const approval = approvalQueue.get(input.approvalId);
  if (!approval) return err(`审批 ${input.approvalId} 不存在`);
  if (approval.status !== 'PENDING') {
    return err(`审批 ${input.approvalId} 已决 (${approval.status})`);
  }

  // ★ 治理层校验（2026-10-04，按层级相对规则）：
  //   - 裁决者必须是本审批**既定审批人**之一（决策池已按请求方层级构造：
  //     L2 请求 → 用户/L1/L0 任一可参与；L1 请求 → 仅用户 + L0，杜绝 L1 自审）；
  //   - **法定人数**：`requiredApprovals`（默认 2，即"任意两方"），且不同角色须由不同身份满足。
  //   此前 `decidedBy` 完全由调用方自报且不校验角色 —— 任何角色都能以 `auditor:xxx` 名义裁决。
  const actorRole = parseDecidedByRole(input.decidedBy);
  const allowedRoles = approval.deciders.map(d => d.role as string);
  // 兼容单审批人路径：只有一名审批人时，允许直接以"身份"提交（历史上前端即如此），
  // 否则按 `role:identity` 解析并要求角色在决策池内（多审批人 = 治理/双人控制场景，必须显式角色）。
  const effectiveRole = allowedRoles.length === 1
    ? (allowedRoles.includes(actorRole) ? actorRole : allowedRoles[0]!)
    : actorRole;
  // ★ 系统角色只可**拒绝**（fail-safe：超时/异常自动拒绝），**绝不能自动通过**。
  //   通过必须来自治理授权（或 forceApprove 的白名单自动审批路径，带 autoApproved 标记）。
  const isSystemActor = actorRole === 'system' || actorRole === 'system-timeout' || actorRole === 'timeout';
  if (isSystemActor && input.approve) {
    return err('裁决被拒绝：系统角色不得自动通过审批（只能自动拒绝）');
  }
  if (!isSystemActor && !allowedRoles.includes(effectiveRole)) {
    return err(`裁决被拒绝：角色 ${actorRole} 不在本审批的决策池中（${allowedRoles.join(' / ')}）`);
  }

  // 记录决定（去重：同一身份只计一次）
  if (!approval.decidedBy) approval.decidedBy = [];
  const identity = input.decidedBy;
  if (!approval.decidedBy.includes(identity)) {
    approval.decidedBy.push(identity);
  }
  approval.decidedAt = Date.now();
  approval.decisionReason = input.reason;

  // 根据策略判定结果
  if (approval.decisionPolicy === 'unanimous') {
    if (!input.approve) {
      approval.status = 'REJECTED';
    } else {
      // ★ 法定人数判定（2026-10-04，按层级相对规则）：
      //   "任意两方"= 达到 requiredApprovals（默认 2）且**不同角色由不同身份满足**；
      //   旧行为"全部审批人角色都要通过"仅在未指定法定人数时作为兜底。
      const requiredRoles = approval.deciders.map(d => d.role as string);
      const required = approval.requiredApprovals
        ?? (requiredRoles.length >= 3 ? 2 : requiredRoles.length);
      if (countDistinctRoleMatches(requiredRoles, approval.decidedBy) >= required) {
        approval.status = 'APPROVED';
      }
    }
  } else {
    // majority: 简单多数
    approval.status = input.approve ? 'APPROVED' : 'REJECTED';
  }

  // 状态落库（FE-004，fail-safe）→ 唤醒阻塞中的工具执行
  persistApprovalUpdated(approval);
  notifyWaiter(approval);

  return ok({ ...approval });
}

/**
 * 统计"必需角色中最多有多少个能被**互不相同的身份**满足"（Kuhn 二分匹配的匹配数）。
 *
 * 用途：`unanimous` 仍需全部满足；而"任意两方"（L2 自治域规则）只需要匹配数 ≥ 法定人数。
 */
export function countDistinctRoleMatches(requiredRoles: string[], decidedBy: string[]): number {
  if (requiredRoles.length === 0) return 0;

  const rolesByIdentity = new Map<string, Set<string>>();
  for (const entry of decidedBy) {
    const sep = entry.indexOf(':');
    const role = sep > 0 ? entry.slice(0, sep) : entry;
    const identity = sep > 0 ? entry.slice(sep + 1) : entry;
    if (!requiredRoles.includes(role)) continue;
    if (!rolesByIdentity.has(identity)) rolesByIdentity.set(identity, new Set());
    rolesByIdentity.get(identity)!.add(role);
  }

  const roleToIdentity = new Map<string, string>();
  const identityToRole = new Map<string, string>();
  const tryAssign = (role: string, visited: Set<string>): boolean => {
    for (const [identity, roles] of rolesByIdentity) {
      if (!roles.has(role) || visited.has(identity)) continue;
      visited.add(identity);
      const occupiedRole = identityToRole.get(identity);
      if (occupiedRole === undefined || tryAssign(occupiedRole, visited)) {
        roleToIdentity.set(role, identity);
        identityToRole.set(identity, role);
        return true;
      }
    }
    return false;
  };

  let matched = 0;
  for (const role of requiredRoles) {
    if (tryAssign(role, new Set<string>())) matched++;
  }
  return matched;
}

/**
 * 判定必需角色是否由**互不相同的身份**分别满足（= 全部匹配，用于 unanimous 兜底路径）。
 *
 * 语义：
 *  - `decidedBy` 条目形如 `role:identity`（无冒号时视为 `role` 且 identity 同名，兼容旧数据）；
 *  - 每个必需角色需要至少一个提交它的身份；
 *  - **同一身份不得同时顶替多个必需角色**（这是修复"单人自批"红线的关键）。
 *
 * 实现：角色↔身份构成二分图，用增广路径（Kuhn 算法）求最大匹配；
 * 规模极小（必需角色通常 1~3 个），实现简单且不会成为瓶颈。
 */
export function rolesSatisfiedByDistinctIdentities(
  requiredRoles: string[],
  decidedBy: string[],
): boolean {
  if (requiredRoles.length === 0) return false;
  return countDistinctRoleMatches(requiredRoles, decidedBy) >= requiredRoles.length;
}

/**
 * 策略性通过（自动审批）。
 *
 * 与 `decideApproval` 的区别：**忽略多人/双角色策略**，直接落 APPROVED 并唤醒阻塞的工具执行。
 * 仅用于策略白名单命中的自动审批（已记 `autoApproved` 标记，便于审计区分）。
 */
export function forceApprove(
  approvalId: string,
  decidedBy: string,
  reason: string,
): Result<PendingApproval> {
  const approval = approvalQueue.get(approvalId);
  if (!approval) return err(`审批 ${approvalId} 不存在`);
  if (approval.status !== 'PENDING') {
    return err(`审批 ${approvalId} 已决 (${approval.status})`);
  }

  approval.status = 'APPROVED';
  approval.decidedAt = Date.now();
  approval.decidedBy = [...(approval.decidedBy ?? []), decidedBy];
  approval.decisionReason = reason;
  approval.autoApproved = true;

  persistApprovalUpdated(approval);
  notifyWaiter(approval);
  return ok({ ...approval });
}

/**
 * 检查超时审批——扫描 PENDING 状态的审批
 */
export function checkTimeoutApprovals(now: number = Date.now()): PendingApproval[] {
  const timedOut: PendingApproval[] = [];

  for (const [, approval] of approvalQueue) {
    if (approval.status !== 'PENDING') continue;
    const expiresAt = approval.requestedAt + approval.timeoutSec * 1000;
    if (now >= expiresAt) {
      // 超时 → 默认拒绝（禁止默认通过）
      approval.status = 'TIMEOUT';
      approval.decidedAt = now;
      approval.decisionReason = `超时 (${approval.timeoutSec}s)`;
      persistApprovalUpdated(approval);
      notifyWaiter(approval);
      timedOut.push(approval);
    }
  }

  return timedOut;
}

/**
 * 获取审批请求
 */
export function getApproval(approvalId: string): PendingApproval | undefined {
  const approval = approvalQueue.get(approvalId);
  if (!approval) return undefined;
  // 账号隔离：非当前属主的审批对外不可见
  return (approval.owner ?? 'local') === getActiveOwner() ? approval : undefined;
}

/**
 * 获取 Loop 的所有审批请求
 */
export function getApprovalsByLoop(loopId: string): PendingApproval[] {
  return [...approvalQueue.values()].filter(a => a.loopId === loopId);
}

/**
 * 获取所有待审批
 */
export function getPendingApprovals(): PendingApproval[] {
  const owner = getActiveOwner();
  return [...approvalQueue.values()].filter(a => a.status === 'PENDING' && (a.owner ?? 'local') === owner);
}

/**
 * 获取最近审批（待处理 + 已决，含落库历史）——FE-005。
 *
 * 超时/拒绝后条目不再从列表消失：内存队列（本进程内已决）+ 落库历史
 * （跨重启回溯）按 approvalId 合并，内存态优先（更新鲜）。
 */
export function getRecentApprovals(limit = 100): PendingApproval[] {
  const owner = getActiveOwner();
  const merged = new Map<string, PendingApproval>();

  for (const row of listPersistedApprovals(owner, limit)) {
    merged.set(row.approvalId, row);
  }
  for (const approval of approvalQueue.values()) {
    if ((approval.owner ?? 'local') === owner) {
      merged.set(approval.approvalId, { ...approval });
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.requestedAt - a.requestedAt)
    .slice(0, limit);
}

/**
 * 清空队列（测试用）
 */
export function clearApprovalQueue(): void {
  // 唤醒所有等待者（返回 null = 中断），避免测试/重启后挂起的 Promise 泄漏
  for (const [, waiter] of approvalWaiters) waiter(null);
  approvalWaiters.clear();
  approvalQueue.clear();
}
