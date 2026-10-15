/**
 * 审批状态 store。
 */
import { create } from "zustand";
import { apiGet, apiPost } from "@/services/api";

export interface ApprovalDecider {
  role: string;
  weight: number;
}

export interface ApprovalQuorumGap {
  required: number;
  matched: number;
  remainingIdentities: number;
  reason: string;
}

export interface Approval {
  approvalId: string;
  loopId: string;
  iteration?: number;
  kind: string;
  riskLevel: string;
  requestedBy: string;
  payload: unknown;
  status: "PENDING" | "APPROVED" | "REJECTED" | "TIMEOUT";
  timeoutSec: number;
  requestedAt: number;
  deciders: ApprovalDecider[];
  decisionPolicy: string;
  /** 评审记录 ID（仅 kind='task_review' 的行携带） */
  reviewId?: string;
  /**
   * 只读行：评审（Maker-Checker）由注册 Reviewer Agent 裁决，
   * 人工侧没有裁决通道 → 不显示批准/拒绝按钮（REV-317）。
   */
  readOnly?: boolean;
  /** 法定人数（需要多少个**不同身份**分别满足角色）；未给定时按后端口径推导 */
  requiredApprovals?: number;
  decidedBy?: string[];
  decidedAt?: number;
  decisionReason?: string;
  /** 已记账但未达法定人数时的缺口（后端回传，前端不自行猜测） */
  quorumBlocked?: ApprovalQuorumGap;
  /** 关联的工具调用 ID（用于把审批内嵌到对话中的工具行） */
  toolCallId?: string;
  /** 关联工具名 */
  toolName?: string;
  /** 触发该审批的会话 ID */
  sessionId?: string;
  /** 是否为自动审批（策略白名单，无需用户确认） */
  autoApproved?: boolean;
}

/** CRITICAL unanimous 审批进度：已满足的角色数（按不同身份） / 法定人数 */
export interface ApprovalProgress {
  approvedCount: number;
  requiredCount: number;
  /** 仍未被任何身份满足的角色（缺口提示用） */
  remainingRoles: string[];
  isComplete: boolean;
  isRejected: boolean;
}

/** 法定人数口径（与后端 `decideApproval` 保持一致） */
export function getRequiredApprovals(a: Approval): number {
  const roles = (a.deciders ?? []).map((d) => d.role);
  return a.requiredApprovals ?? (roles.length >= 3 ? 2 : roles.length);
}

/**
 * 「必需角色中最多有多少个能被互不相同的身份满足」——与后端
 * `countDistinctRoleMatches`（Kuhn 二分匹配）同一口径（REV-264）。
 *
 * 此前前端按「出现过的角色」计数：同一身份换角色重复提交时前端显示 2/2，
 * 后端却仍是 1/2 PENDING → 界面报"已审批"而工具仍在阻塞（假指标）。
 */
function matchRoles(
  requiredRoles: string[],
  decidedBy: string[],
): { matched: number; covered: Set<string> } {
  const covered = new Set<string>();
  if (requiredRoles.length === 0) return { matched: 0, covered };

  const rolesByIdentity = new Map<string, Set<string>>();
  for (const entry of decidedBy) {
    const sep = entry.indexOf(":");
    const role = sep > 0 ? entry.slice(0, sep) : entry;
    const identity = sep > 0 ? entry.slice(sep + 1) : entry;
    if (!requiredRoles.includes(role)) continue;
    if (!rolesByIdentity.has(identity))
      rolesByIdentity.set(identity, new Set());
    rolesByIdentity.get(identity)!.add(role);
  }

  const roleToIdentity = new Map<string, string>();
  const identityToRole = new Map<string, string>();
  const tryAssign = (role: string, visited: Set<string>): boolean => {
    for (const [identity, roles] of rolesByIdentity) {
      if (!roles.has(role) || visited.has(identity)) continue;
      visited.add(identity);
      const occupied = identityToRole.get(identity);
      if (occupied === undefined || tryAssign(occupied, visited)) {
        roleToIdentity.set(role, identity);
        identityToRole.set(identity, role);
        return true;
      }
    }
    return false;
  };

  let matched = 0;
  for (const role of requiredRoles) {
    if (tryAssign(role, new Set())) matched++;
  }
  for (const role of roleToIdentity.keys()) covered.add(role);
  return { matched, covered };
}

export function countDistinctRoleMatches(
  requiredRoles: string[],
  decidedBy: string[],
): number {
  return matchRoles(requiredRoles, decidedBy).matched;
}

export function getApprovalProgress(a: Approval): ApprovalProgress | null {
  if (a.decisionPolicy !== "unanimous") return null;
  const requiredRoles = (a.deciders ?? []).map((d) => d.role);
  const { matched, covered } = matchRoles(requiredRoles, a.decidedBy ?? []);
  return {
    approvedCount: matched,
    requiredCount: Math.max(getRequiredApprovals(a), 1),
    remainingRoles: requiredRoles.filter((r) => !covered.has(r)),
    isComplete: a.status === "APPROVED",
    isRejected: a.status === "REJECTED" || a.status === "TIMEOUT",
  };
}

/**
 * 本次提交应以哪个角色投票。
 *
 * 一次点击 = 一票，且必须投给"还没有被任何身份满足"的角色：后端按**不同身份**
 * 判定法定人数（自报身份会被改写为当前账号），换角色名并不换身份，
 * 因此旧行为"一次点击补齐所有角色"（同一身份提交两次）只会永久 PENDING（REV-264）。
 * 第二票应由另一位操作者（另一账号 / 已注册治理 Agent）投出。
 */
export function getSubmitRole(a: Approval): string | null {
  const roles = (a.deciders ?? []).map((d) => d.role);
  if (roles.length <= 1) return null; // 单审批人：按身份提交（后端兼容路径）

  const decided = a.decidedBy ?? [];
  const before = countDistinctRoleMatches(roles, decided);
  for (const role of roles) {
    // 以一次性探针身份试探：该角色是否仍需由"新的身份"来满足
    if (
      countDistinctRoleMatches(roles, [...decided, `${role}:__probe__`]) >
      before
    )
      return role;
  }
  // 所有角色都已被他人身份满足却仍未落定（法定人数 > 角色数）：交后端判定
  return roles[0]!;
}

interface ApprovalState {
  approvals: Approval[];
  loading: boolean;
  /** 正在提交决策的审批 ID（FE-012：提交中状态，避免按钮"看似无效"） */
  decidingId: string | null;
  /** 最近一次决策失败原因（FE-012：失败原文可见） */
  lastError: string | null;
  /** lastError 所属审批 ID（对话内多张审批卡各自只显示自己的错误） */
  lastErrorId: string | null;
  /** 队列/评审记录读取失败（与裁决失败分开，轮询不会抹掉点击失败的原因） */
  listError: string | null;
  hydrate: () => Promise<void>;
  decide: (
    approvalId: string,
    approve: boolean,
    decidedBy: string,
    reason?: string,
  ) => Promise<boolean>;
  applyEvent: (type: string) => void;
}

export const useApprovalStore = create<ApprovalState>((set, get) => ({
  approvals: [],
  loading: false,
  decidingId: null,
  lastError: null,
  lastErrorId: null,
  listError: null,

  hydrate: async () => {
    set({ loading: true });
    // ?status=all：含已决历史（FE-005）——超时/拒绝后条目不再从列表消失
    const res = await apiGet<Approval[]>("/api/approvals?status=all");
    if (!res.ok) {
      set({
        loading: false,
        listError: `审批队列读取失败：${res.error.message}`,
      });
      return;
    }
    // 评审（Maker-Checker）轨迹：与审批同栏展示，只读（REV-317）
    const reviews = await apiGet<Approval[]>("/api/reviews");
    const approvals = reviews.ok
      ? [
          ...res.data,
          ...reviews.data.filter(
            (r) => !res.data.some((a) => a.approvalId === r.approvalId),
          ),
        ]
      : res.data;
    set({
      approvals,
      loading: false,
      listError: reviews.ok
        ? null
        : `评审记录读取失败：${reviews.error.message}`,
    });
  },

  decide: async (approvalId, approve, decidedBy, reason) => {
    set({ decidingId: approvalId, lastError: null, lastErrorId: null });
    try {
      let approval = get().approvals.find((a) => a.approvalId === approvalId);
      if (!approval) {
        // 审批可能在点击时还没被轮询拉取到 → 取详情，否则拿不到决策池角色
        const detail = await apiGet<Approval>(`/api/approvals/${approvalId}`);
        if (detail.ok) {
          approval = detail.data;
          set({ approvals: [...get().approvals, detail.data] });
        }
      }

      if (!approval) {
        set({
          lastError: "审批详情获取失败，未能提交裁决",
          lastErrorId: approvalId,
        });
        return false;
      }

      if (approval.readOnly) {
        set({
          lastError:
            "评审（Maker-Checker）由已注册 Reviewer Agent 裁决，人工通道无裁决权",
          lastErrorId: approvalId,
        });
        return false;
      }

      const submitRole = getSubmitRole(approval);
      const payload = {
        approve,
        decidedBy: submitRole ? `${submitRole}:${decidedBy}` : decidedBy,
        reason,
      };

      // 一次点击 = 一个身份投一票。多角色审批的其余票必须由**另一位不同身份**
      // （其他账号 / 已注册治理 Agent）投出；未达法定人数时后端回 409 或缺口字段，
      // 两者都如实呈现，不再靠重复提交同一身份假装满足双人控制（REV-264）。
      const res = await apiPost<Approval>(
        `/api/approvals/${approvalId}/decide`,
        payload,
      );
      if (!res.ok) {
        // FE-012：失败原因暴露给 UI（限流等待/网络错误不再"静默无反应"）
        const hint = res.error.retryAfter
          ? `（限流，${res.error.retryAfter}s 后自动重试）`
          : "";
        set({
          lastError: `${res.error.message}${hint}`,
          lastErrorId: approvalId,
        });
        return false;
      }

      const data = res.data;
      set({
        approvals: get().approvals.map((a) =>
          a.approvalId === approvalId ? data : a,
        ),
      });
      return true;
    } finally {
      set({ decidingId: null });
    }
  },

  applyEvent: (type) => {
    if (
      type === "loop:approval_requested" ||
      type === "loop:approval_decided" ||
      type === "loop:approval_timeout_rejected"
    ) {
      useApprovalStore.getState().hydrate();
    }
  },
}));
