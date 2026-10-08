/**
 * @module Services/A2A/types
 * @description A2A（治理型智能体间通信）**类型层**（P0a 地基）。
 *
 * 设计依据：`Docs/Dev/A2A-治理型智能体间通信协议设计.md`
 *  - §2 Agent Card（role / createTime / father / status / ability / permission）
 *  - §3 信封 v2：**继承**既有 `AgentMessage`（12 字段原样保留）+ 治理字段（§18 #1 勘误）
 *  - §16.0 作用域划分（记忆 / A2A / 隔离层三分法）
 *  - §18 自审修正（本文件已落实 #1/#2/#5/#11 等结构性条款）
 *
 * 边界：本文件**只放类型**，不含运行期逻辑（便于先冻结契约再接线）。
 */

import type { AgentMessage } from '../EventBus/eventTypes.js';
import type { AgentRole, AgentStatus } from '../../Core/AgentRuntime/types.js';
import type { DangerLevel } from '../../Infra/Security/trustLevels.js';

// ── 分层与角色 ───────────────────────────────────────────────────────

/** 执行域分层（与 `roleVocabulary.tierOfRole` 一致） */
export type AgentTier = 'owner' | 'L0' | 'L1' | 'L2';

/** A2A 消息种类（治理分类；与既有 `MessageType` 是**正交**关系） */
export type A2AKind =
  | 'handoff'    // 交接：文件/任务残局移交
  | 'query'      // 问询
  | 'answer'     // 应答
  | 'propose'    // 协商提议（L2 不允许，见 §18 #10）
  | 'accept'     // 接受
  | 'reject'     // 拒绝
  | 'notify'     // 单向通知
  | 'escalate'   // 升级到治理队列（非定向到具体 L0 agent，见 §18 #4）
  | 'retract';   // 追加式撤回（不改原消息，见 §18 #9）

/** 可见性（执行层视角；L0 与所有者恒可见全部） */
export type A2AVisibility = 'public' | 'domain' | 'private';

/** Broker 判定 */
export type BrokerVerdict =
  | 'allow'       // 通过并投递
  | 'block'       // 阻断（不投递，落库留痕）
  | 'quarantine'  // 隔离待裁（不投递正文，交 L0）
  | 'redirect';   // 改道：该走共享记忆而非 A2A（§16.0 H2 / §18 #8）

/** 反串通判据编号（C1..C8，见设计 §7.1 与 §16.4） */
export type CollusionRuleId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8';

// ── Agent Card（§2）─────────────────────────────────────────────────

/** 能力（§2.2）——`tools` **必须**来源于工具注册表（`getVisibleToolsForRole`） */
export interface AgentAbility {
  skills: string[];
  tools: string[];
  models: string[];
  languages: string[];
  maxParallel: number;
}

/** 权限（§2.3；`canWriteGovernanceKeys` 依记忆治理的键分层细化） */
export interface AgentPermission {
  tier: AgentTier;
  /** 可读数据域：`task:<id>` / `memory:shared` / `file:<root>/<glob>` / `trace:<id>` */
  dataScopes: string[];
  canDelegate: boolean;
  /** 可审批的**角色集合**（空数组 = 不可审批；与审批决策池同源） */
  canApprove: string[];
  /** 可否写共享层**普通键**（记忆治理：共享键人人可写） */
  canWriteSharedMemory: boolean;
  /** 可否写**治理键**（`regulation./verdict./rule./governance./arbitration.`，仅 L0） */
  canWriteGovernanceKeys: boolean;
  canBroadcast: boolean;
  /** 最高可执行危险级（**由可见工具的最大 dangerLevel 派生**，不靠人填） */
  dangerCeiling: DangerLevel;
  a2a: {
    canInitiate: boolean;
    maxPeers: number;
    maxMessagesPerHour: number;
    allowedKinds: A2AKind[];
  };
}

/** 父引用（§2.1：`father` 为正式字段，替代旁挂 Map —— §18 #3） */
export interface FatherRef {
  agentId: string;
  role: AgentRole;
}

/** Agent Card（治理层签发；agent 不可自改 —— §2） */
export interface AgentCard {
  cardId: string;
  agentId: string;
  cardVersion: number;
  role: AgentRole;
  createTime: number;
  updateTime: number;
  father: FatherRef | null;
  /** 祖先链（根 → … → 父），用于越级判定与域可见性 */
  lineage: string[];
  status: AgentStatus;
  health: { consecutiveFailures: number; lastActiveAt: number };
  ability: AgentAbility;
  permission: AgentPermission;
  /** 卡片规范化内容的 sha256（防篡改） */
  fingerprint: string;
  issuedBy: string;
  expiresAt: number;
  ownerUserId: string;
}

// ── 信封 v2（§3；**继承**既有 AgentMessage，不另造平行类型）────────────

/** 策略上下文（治理审计用） */
export interface A2APolicyContext {
  requesterTier: AgentTier;
  requesterCardVersion: number;
  approvalId?: string;
  governanceRecordId?: string;
}

/** 记忆引用（§16.0.2 H2：**只允许指针，禁止正文副本**） */
export interface MemoryRef {
  key: string;
  version: number;
}

/** A2A 信封 v2 */
export interface A2AEnvelope extends AgentMessage {
  schemaVersion: 2;
  kind: A2AKind;
  taskId: string;
  visibility: A2AVisibility;
  contentHash: string;
  /** 链作用域：单设备内可校验；跨设备只验 hash 集合（§18 #5） */
  prevHash: string | null;
  chainScope: 'local_device' | 'cross_device';
  capabilityRequired?: string[];
  permissionRequired?: string[];
  policyContext: A2APolicyContext;
  /** Broker 签发（agent 无法伪造） */
  signature: string;
  /** 指向共享记忆条目的指针（跨通道唯一允许的引用方式） */
  memoryRefs?: MemoryRef[];
  /** 跨域可见摘要（发送方提供 + Broker 校验；缺失则 Broker 兜底生成 —— §18 #20） */
  summary?: string;
  /** 摘要为真时表示"非权威"（引用而非事实） */
  nonAuthoritative?: boolean;
  /** 撤回声明（追加式；指向被撤回的 messageId） */
  retractsMessageId?: string;
}

// ── 交接包（§6.1；含 §18 #6 的系统侧事实）────────────────────────────

/** 前任能力边界自述（**可能漏报** → 由系统事实交叉校验） */
export interface SelfLimit {
  area: string;
  limitation: string;
  verified: boolean;
}

/** 交接产物条目（指纹用于继任者对账 R1） */
export interface HandoffArtifact {
  path: string;
  sha256: string;
  sizeBytes: number;
  lastModifiedBy: string;
  intent: string;
  toolCallId?: string;
  evidenceChain?: string[];
}

/** 系统侧事实（**不依赖前任自述**，由 EffectJournal/审批/回滚自动汇总 —— §18 #6） */
export interface HandoffSystemFacts {
  failedAttempts: Array<{ toolName: string; errorClass?: string; at: number }>;
  rejectedApprovals: Array<{ approvalId: string; reason?: string; at: number }>;
  revertedEdits: Array<{ path: string; at: number }>;
}

/** 交接包（§6.1） */
export interface HandoffBundle {
  handoffId: string;
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  createTime: number;
  artifacts: HandoffArtifact[];
  intent: { goal: string; done: string[]; remaining: string[] };
  knownPitfalls: string[];
  openQuestions: string[];
  acceptance: string[];
  selfLimits: SelfLimit[];
  /** 系统补充事实（可能与 selfLimits 不一致 → `a2a:selfreport_mismatch`） */
  systemFacts: HandoffSystemFacts;
  /**
   * 溯源信息。
   * `loopId` 为**系统事实（systemFacts）的唯一可靠关联键** —— `effect_journal` 只按 `loop_id` 索引，
   * 无 trace/task 列（实现期发现的缺口，见设计 §18 #29）。
   */
  provenance: { traceId: string; loopId?: string; eventRange: [number, number]; prevHash: string | null };
}

// ── Broker 校验结果（§5.1）────────────────────────────────────────────

/** 校验链中命中的失败步骤（①..⑧） */
export type BrokerStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface BrokerDecision {
  verdict: BrokerVerdict;
  /** 命中的步骤（`block/quarantine` 时必填） */
  step?: BrokerStep;
  reasons: string[];
  /** 命中的反串通判据 */
  rules?: CollusionRuleId[];
  /** `redirect` 时的改道建议（应写入共享记忆的键） */
  suggestion?: { channel: 'memory'; key: string };
}

// ── 串通告警（§7.1）──────────────────────────────────────────────────

export interface CollusionAlert {
  alertId: string;
  ruleId: CollusionRuleId;
  severity: 'low' | 'medium' | 'high' | 'critical';
  participants: string[];
  taskId?: string;
  evidence: Record<string, unknown>;
  disposition: 'pending' | 'warned' | 'cooled' | 'frozen' | 'arbitrated';
  raisedAt: number;
  resolvedAt?: number;
  ownerUserId: string;
}
