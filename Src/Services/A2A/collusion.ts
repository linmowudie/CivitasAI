/**
 * @module Services/A2A/collusion
 * @description 反串通判据（P0a）—— 设计 §7.1（C1..C8）与自审收紧（§18 #7/#8/#6）。
 *
 * 判据设计原则（**防误伤**，否则会瘫痪协作）：
 *  - 每个判据都是**纯函数 + 注入数据**（可测试、无副作用）；
 *  - 高风险判据（意图/信道/代偿/通道混用）才 `block`；统计类先 `quarantine/alert`；
 *  - 全部判据**可配置阈值 + 可开关**（§19.5）。
 */

import { proposition, similarity } from '../SharedMemory/memoryGovernance.js';
import type { DangerLevel } from '../../Infra/Security/trustLevels.js';
import type { A2AKind, CollusionRuleId } from './types.js';

export type CollusionAction = 'alert' | 'quarantine' | 'block' | 'redirect';

export interface CollusionFinding {
  ruleId: CollusionRuleId;
  severity: 'low' | 'medium' | 'high' | 'critical';
  action: CollusionAction;
  evidence: Record<string, unknown>;
  /** `redirect` 时的改道建议（应写入共享记忆的键） */
  suggestion?: { channel: 'memory'; key: string };
}

/** 判据阈值（可配置；默认值见 §19.4 Q3/Q4） */
export interface CollusionThresholds {
  /** C1 互惠次数阈值（父子间**减半** —— §18 #10） */
  reciprocityThreshold: number;
  /** C2 语义相似度下限（低于即视为"与任务无关的私下协商"） */
  driftSimilarityFloor: number;
  /** C2 连续命中条数 */
  driftConsecutive: number;
  /** C8 与所指记忆内容的相似度阈值（复用语义碰撞口径） */
  duplicateSimilarity: number;
}

export const DEFAULT_THRESHOLDS: CollusionThresholds = {
  reciprocityThreshold: 3,
  driftSimilarityFloor: 0.35,
  driftConsecutive: 3,
  duplicateSimilarity: 0.85,
};

// ── C1 互惠闭环 ─────────────────────────────────────────────────────

export interface ReciprocityInput {
  fromAgentId: string;
  toAgentId: string;
  /** 窗口内 from→to 的消息数 */
  forwardCount: number;
  /** 窗口内 to→from 的消息数 */
  backwardCount: number;
  /** 关系（父子互看更敏感 → 阈值减半） */
  relationship?: 'parent_child' | 'siblings' | 'cross_domain';
}

/** C1：双向互惠达到阈值 → 告警/隔离（**先隔离后裁**，不自动冻结） */
export function detectReciprocity(
  input: ReciprocityInput, thresholds: CollusionThresholds = DEFAULT_THRESHOLDS,
): CollusionFinding | null {
  const base = thresholds.reciprocityThreshold;
  const threshold = input.relationship === 'parent_child' ? Math.max(1, Math.ceil(base / 2)) : base;
  const mutual = Math.min(input.forwardCount, input.backwardCount);
  if (mutual < threshold) return null;
  return {
    ruleId: 'C1',
    severity: 'medium',
    action: 'quarantine',
    evidence: {
      pair: [input.fromAgentId, input.toAgentId],
      forwardCount: input.forwardCount,
      backwardCount: input.backwardCount,
      threshold,
      relationship: input.relationship ?? 'unknown',
    },
  };
}

// ── C2 任务漂移 ─────────────────────────────────────────────────────

export interface TaskDriftInput {
  messageText: string;
  taskGoal: string;
  /** 本会话已连续命中次数（含本次之前的） */
  consecutiveHits?: number;
  /** 显式声明的跨任务引用（§18 #7：标注后放行，仅留痕） */
  crossTaskReference?: boolean;
  taskId?: string;
}

/** 中文/英文混合文本的双字（bigram）集合 */
function toBigrams(text: string): Set<string> {
  const cleaned = text.replace(/[\s\p{P}]+/gu, ' ').trim();
  const out = new Set<string>();
  for (const token of cleaned.split(' ').filter(Boolean)) {
    out.add(token);
    for (let i = 0; i < token.length - 1; i++) out.add(token.slice(i, i + 2));
  }
  return out;
}

/**
 * 主题重合度（**overlap coefficient**）：|A∩B| / min(|A|,|B|)。
 *
 * 为什么 C2 不用 `similarity`（Jaccard）：中文短句下 Jaccard 偏严，
 * 会把"同任务但表述更短"的消息误判为漂移（实测：'我来补充 A2A 协议的单元测试'
 * 对目标 '重构 A2A 协议并补充单元测试覆盖' 的 Jaccard 仅 ~0.3 → 误报）。
 * 客观重合度只问"这条消息的主题是否落在任务目标里"，更贴合漂移语义。
 */
export function topicOverlap(a: string, b: string): number {
  const A = toBigrams(proposition(a));
  const B = toBigrams(proposition(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** C2：消息与任务目标主题重合过低且连续命中 → 疑似私下协商 */
export function detectTaskDrift(
  input: TaskDriftInput, thresholds: CollusionThresholds = DEFAULT_THRESHOLDS,
): CollusionFinding | null {
  if (input.crossTaskReference) return null;                    // 显式跨任务引用：放行
  const goal = input.taskGoal?.trim();
  const text = input.messageText?.trim();
  if (!goal || !text) return null;
  const overlap = topicOverlap(text, goal);
  if (overlap >= thresholds.driftSimilarityFloor) return null;
  const hits = (input.consecutiveHits ?? 0) + 1;                // 含本次
  if (hits < thresholds.driftConsecutive) return null;
  return {
    ruleId: 'C2',
    severity: 'medium',
    action: 'quarantine',
    evidence: {
      metric: 'topic_overlap', overlap: Number(overlap.toFixed(3)),
      floor: thresholds.driftSimilarityFloor, consecutiveHits: hits, taskId: input.taskId,
    },
  };
}

// ── C7 通道混用（§16.4）─────────────────────────────────────────────

/** "结构化事实断言"特征（用于 C7 与 redirect 的组合判定） */
const FACT_ASSERTION_MARKERS = [
  '必须', '禁止', '不得', '应当', '规则', '约束', '结论', '一律', '统一',
  'must', 'shall', 'forbidden', 'rule:', 'constraint',
];

/** 点对点私语特征（用于识别"拿共享记忆当信箱"） */
const WHISPER_MARKERS = ['只告诉你', '别告诉', '私下', '私聊', '不要让', '仅你可', 'between us'];

export interface ChannelMisuseInput {
  kind: A2AKind;
  /** 收件人数量（>1 视为广播型） */
  recipientCount: number;
  payloadText: string;
  /** 是否携带记忆指针（有指针则不构成"拿 A2A 当记忆"） */
  memoryRefs?: Array<{ key: string; version: number }>;
  taskId?: string;
  /** 建议写入的记忆键（用于 redirect 指引） */
  suggestedMemoryKey?: string;
}

/**
 * C7-A（A2A→记忆越界）：**三条件同时满足**才改道 ——
 * ① 广播型/多收件人；② 含结构化事实断言；③ 未携带记忆指针。
 */
export function detectA2AAsMemory(
  input: ChannelMisuseInput, _thresholds: CollusionThresholds = DEFAULT_THRESHOLDS,
): CollusionFinding | null {
  if ((input.memoryRefs?.length ?? 0) > 0) return null;                       // 有指针：合规引用
  if (input.recipientCount <= 1) return null;                                 // 点对点告知：允许
  const hasFact = FACT_ASSERTION_MARKERS.some(m => input.payloadText.includes(m));
  if (!hasFact) return null;                                                  // 无事实断言：普通协商
  return {
    ruleId: 'C7',
    severity: 'medium',
    action: 'redirect',
    evidence: {
      reason: 'a2a_as_shared_memory',
      recipientCount: input.recipientCount,
      taskId: input.taskId,
      matchedMarkers: FACT_ASSERTION_MARKERS.filter(m => input.payloadText.includes(m)),
    },
    suggestion: {
      channel: 'memory',
      key: input.suggestedMemoryKey ?? `task.${input.taskId ?? 'unknown'}.facts`,
    },
  };
}

/**
 * C7-B（记忆→A2A 越界）：共享记忆被当作"信箱" ——
 * ① 键 ∉ 本任务命名空间；或 ② 内容含点对点私语特征。
 */
export function detectMemoryAsMailbox(params: {
  key: string; taskId?: string; content: string;
  /**
   * 跳过"键命名空间"检查（仅保留私语检查）。
   * 用途：**治理键**（`regulation./verdict./rule.` 等）按定义就是跨任务的共享事实通道，
   * 若仍套用命名空间规则会把合法治理写入全部误杀（实现期发现的缺陷，见设计 §18 #31）。
   */
  skipNamespaceCheck?: boolean;
}): CollusionFinding | null {
  const k = params.key.trim();
  const inTaskNamespace = params.skipNamespaceCheck
    ? true
    : (params.taskId
      ? (k.startsWith(`task.${params.taskId}`) || k.startsWith(`handoff.${params.taskId}`) || k.startsWith(params.taskId))
      : false);
  const whisper = WHISPER_MARKERS.find(m => params.content.includes(m));
  if (inTaskNamespace && !whisper) return null;
  return {
    ruleId: 'C7',
    severity: whisper ? 'high' : 'medium',
    action: 'block',
    evidence: {
      reason: 'memory_as_mailbox',
      key: k,
      taskNamespaceMatch: inTaskNamespace,
      whisperMarker: whisper ?? null,
    },
  };
}

// ── C8 双源漂移（§16.0.2 H2）─────────────────────────────────────────

export interface DuplicateSourceInput {
  payloadText: string;
  memoryRefs?: Array<{ key: string; version: number }>;
  /** 读取记忆条目正文（注入，避免与 GlobalWorkspace 查询形状耦合） */
  lookupMemory: (key: string) => string | undefined;
}

/** C8：消息正文与 `memoryRefs` 所指记忆**高度相似**（≥0.85）却仍带正文副本 → 双源漂移 */
export function detectDuplicateSource(
  input: DuplicateSourceInput, thresholds: CollusionThresholds = DEFAULT_THRESHOLDS,
): CollusionFinding | null {
  const refs = input.memoryRefs ?? [];
  if (refs.length === 0 || !input.payloadText?.trim()) return null;
  for (const ref of refs) {
    const stored = input.lookupMemory(ref.key);
    if (!stored) continue;
    const sim = similarity(proposition(input.payloadText), proposition(stored));
    if (sim >= thresholds.duplicateSimilarity) {
      return {
        ruleId: 'C8',
        severity: 'low',
        action: 'quarantine',
        evidence: { reason: 'duplicate_source', key: ref.key, version: ref.version, similarity: Number(sim.toFixed(3)) },
      };
    }
  }
  return null;
}

// ── C3 绕审意图（§18 #7：意图 + 审计对象 **双条件**）───────────────

/** 绕审意图词（必须**同时**出现"审计对象"词才判定，避免误伤"审计规则要求记录"这类正常表述） */
const AUDIT_EVASION_MARKERS = [
  '别记录', '不要记录', '不记录', '别留痕', '不留痕', '删除日志', '删掉日志', '清掉日志',
  '不走审批', '绕过审批', '跳过审批', '别让审计看到', '别让监管看到', '逃过审查', '避开监管',
  'skip audit', 'bypass approval', 'delete log', 'off the record',
];

/** 审计/监管对象词 */
// 注意：**不得**把「记录」「留痕」放进对象词 —— 它们出现在意图词（「别记录」「别留痕」）内部，会造成自匹配假阳性。
const AUDIT_OBJECT_MARKERS = ['日志', '审计', '台账', '审批', '巡检', '监管', 'log', 'audit'];

/**
 * C3：**意图词 + 审计对象词同时出现** → 阻断（不依赖单一词表，防误伤）。
 * `targetsSelfAction` 为调用方提供的补充信号（该文本描述的是发送方自己的动作）。
 */
export function detectAuditEvasion(params: { text: string; targetsSelfAction?: boolean }): CollusionFinding | null {
  const text = params.text ?? '';
  const intent = AUDIT_EVASION_MARKERS.find(m => text.includes(m));
  if (!intent) return null;
  const target = AUDIT_OBJECT_MARKERS.find(m => text.includes(m));
  if (!target) return null;
  return {
    ruleId: 'C3',
    severity: 'critical',
    action: 'block',
    evidence: { reason: 'audit_evasion_intent', intentMarker: intent, auditObject: target, targetsSelfAction: params.targetsSelfAction ?? null },
  };
}

// ── C4 隐蔽信道（§18 #7：组合条件）──────────────────────────────────

/**
 * C4：文件旁路 / 共享内存旁路 → 阻断；**高熵仅作组合条件**（还需"非结构化内容"）→ 告警，
 * 避免把正常 base64 / 哈希 / 压缩串误判为信道。
 */
export function detectCovertChannel(params: {
  filePaths?: string[];
  taskWorkspacePrefix?: string;
  memoryKeys?: string[];
  taskId?: string;
  /** 载荷熵（bits/char，可由调用方估算） */
  payloadEntropy?: number;
  /** 内容是否结构化（JSON/代码等） */
  structuredContent?: boolean;
}): CollusionFinding | null {
  const { taskWorkspacePrefix, taskId } = params;
  const badFile = (params.filePaths ?? []).find(p => Boolean(taskWorkspacePrefix) && !p.startsWith(taskWorkspacePrefix!));
  if (badFile) {
    return {
      ruleId: 'C4', severity: 'high', action: 'block',
      evidence: { reason: 'file_outside_task_workspace', path: badFile, prefix: taskWorkspacePrefix },
    };
  }
  const badKey = (params.memoryKeys ?? []).find(k => Boolean(taskId)
    && !(k.startsWith(`task.${taskId}`) || k.startsWith(`handoff.${taskId}`) || k.startsWith(taskId!)));
  if (badKey) {
    return {
      ruleId: 'C4', severity: 'high', action: 'block',
      evidence: { reason: 'memory_key_outside_task_namespace', key: badKey, taskId },
    };
  }
  if (params.payloadEntropy !== undefined && params.payloadEntropy >= 4.2 && params.structuredContent === false) {
    return {
      ruleId: 'C4', severity: 'medium', action: 'alert',
      evidence: { reason: 'high_entropy_unstructured', entropy: params.payloadEntropy },
    };
  }
  return null;
}

// ── C5 频率异常（σ 或 任务规模）──────────────────────────────────────

export function detectFrequencyAnomaly(params: {
  /** 同一对 agent 的历史窗口计数（用于 σ 估计） */
  pairHistory?: number[];
  currentCount: number;
  sigma?: number;
  /** 由任务规模推出的上限（消息数 > 迭代数 × k） */
  expectedMax?: number;
}): CollusionFinding | null {
  if (params.expectedMax !== undefined && params.currentCount > params.expectedMax) {
    return {
      ruleId: 'C5', severity: 'low', action: 'alert',
      evidence: { reason: 'exceeds_task_scale', currentCount: params.currentCount, expectedMax: params.expectedMax },
    };
  }
  const hist = (params.pairHistory ?? []).filter(n => Number.isFinite(n));
  if (hist.length < 3) return null;
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length);
  const k = params.sigma ?? 3;
  if (sd > 0 && params.currentCount > mean + k * sd) {
    return {
      ruleId: 'C5', severity: 'medium', action: 'alert',
      evidence: { reason: 'sigma_exceeded', mean: Number(mean.toFixed(2)), sd: Number(sd.toFixed(2)), currentCount: params.currentCount, k },
    };
  }
  return null;
}

// ── C6 权限代偿（§18 #7：执行者权限交叉校验）────────────────────────

const DANGER_ORDER: readonly DangerLevel[] = ['SAFE', 'CONTROLLED', 'DANGEROUS', 'FORBIDDEN'];

/**
 * C6：**受益人 ≠ 执行者** 且（动作危险级超出执行者上限 **或** 所需数据域执行者不具备）
 * → 阻断（堵"一人无权、两人合谋"）。
 */
export function detectPrivilegeProxy(params: {
  executorAgentId: string;
  /** 谁受益（若与执行者相同则不构成代偿） */
  beneficiaryAgentId?: string;
  actionDangerLevel?: DangerLevel;
  executorDangerCeiling?: DangerLevel;
  requiredScopes?: string[];
  executorScopes?: string[];
}): CollusionFinding | null {
  const proxy = Boolean(params.beneficiaryAgentId) && params.beneficiaryAgentId !== params.executorAgentId;
  if (!proxy) return null;
  const { actionDangerLevel, executorDangerCeiling } = params;
  if (actionDangerLevel && executorDangerCeiling
    && DANGER_ORDER.indexOf(actionDangerLevel) > DANGER_ORDER.indexOf(executorDangerCeiling)) {
    return {
      ruleId: 'C6', severity: 'critical', action: 'block',
      evidence: {
        reason: 'danger_over_ceiling', action: actionDangerLevel, ceiling: executorDangerCeiling,
        executor: params.executorAgentId, beneficiary: params.beneficiaryAgentId,
      },
    };
  }
  const scopes = params.executorScopes ?? [];
  const missing = (params.requiredScopes ?? []).filter(s => !scopes.some(x => x === '*' || x === s || (x.endsWith('*') && s.startsWith(x.slice(0, -1)))));
  if (missing.length > 0) {
    return {
      ruleId: 'C6', severity: 'high', action: 'block',
      evidence: { reason: 'scope_not_held', missing, executor: params.executorAgentId, beneficiary: params.beneficiaryAgentId },
    };
  }
  return null;
}

/** 汇总判定：按动作强度取最高（block > quarantine > redirect > alert） */
export function strongestFinding(findings: Array<CollusionFinding | null>): CollusionFinding | null {
  const order: Record<CollusionAction, number> = { alert: 0, redirect: 1, quarantine: 2, block: 3 };
  let best: CollusionFinding | null = null;
  for (const f of findings) {
    if (!f) continue;
    if (!best || order[f.action] > order[best.action]) best = f;
  }
  return best;
}

/** 供 Broker 生成告警 ID（时间戳 + 规则，足够唯一且可读） */
export function makeAlertId(ruleId: CollusionRuleId, now = Date.now()): string {
  return `alert-${ruleId}-${now}-${Math.random().toString(36).slice(2, 8)}`;
}
