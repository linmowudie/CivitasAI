/**
 * @module Services/A2A/handoff
 * @description 交接**对账与复核**（P0a 后端内核）—— 设计 §6.2（R1/R2/R5）与 §18 #6。
 *
 * 解决的核心痛点：B 接手 A 处理过的文件时，只能看到"文件当前内容"，
 * 看不到 A 的**意图 / 已知坑 / 未决问题 / 未验证结论** ⇒ 用 B 自己的局限去猜。
 * 本模块给出三条**可执行**保障：
 *  - **R1 指纹对账**：磁盘哈希 ≠ 交接包哈希 ⇒ 冲突（交合并流程，不进自动仲裁）；
 *  - **R2 复核义务**：前任标注"未验证"的区域，继任者**必须先认领复核**才能依赖；
 *  - **§18 #6 交叉校验**：系统事实（失败尝试等）与前任 `selfLimits` 比对，
 *    前任**漏报局限**即产生 `a2a:selfreport_mismatch`，并把系统事实**自动附加**进交接包。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { publish, createEvent } from '../EventBus/eventBus.js';
import { EventType } from '../EventBus/eventTypes.js';
import { logger } from '../../Infra/Logging/logger.js';
import { getMainDb } from '../../Infra/Db/database.js';
import { recordGovernanceAction } from '../Governance/governanceAudit.js';
import {
  loadHandoff, loadHandoffReview, setHandoffReview, setHandoffVerification, type HandoffReview,
} from './a2aStore.js';
import type { HandoffArtifact, HandoffBundle, HandoffSystemFacts, SelfLimit } from './types.js';

// ── 系统事实采集（§18 #6）────────────────────────────────────────────

/**
 * 采集系统事实（**不依赖前任自述**）。
 *
 * 来源与现状：
 *  - **失败尝试**：`effect_journal`（按 `loop_id` 查 FAILED/UNKNOWN）✅ 已实现；
 *  - **被拒审批 / 被回滚编辑**：P0a 无按 loop 的可查源，需调用方注入（见 `extra`）——
 *    设计已记明该缺口，接入后本函数无需改签名。
 */
export function collectSystemFacts(params: {
  loopId?: string;
  extra?: Partial<HandoffSystemFacts>;
}): HandoffSystemFacts {
  const facts: HandoffSystemFacts = {
    failedAttempts: [], rejectedApprovals: [], revertedEdits: [],
    ...(params.extra ?? {}),
  };
  if (!params.loopId) return facts;
  try {
    const rows = getMainDb().prepare(
      `SELECT kind, error_class, COALESCE(completed_at, started_at) AS at
       FROM effect_journal WHERE loop_id = ? AND status IN ('FAILED','UNKNOWN')
       ORDER BY at DESC LIMIT 50`,
    ).all(params.loopId) as Array<{ kind?: string; error_class?: string | null; at?: number }>;
    facts.failedAttempts = rows.map(r => ({
      toolName: String(r.kind ?? 'unknown'),
      ...(r.error_class ? { errorClass: String(r.error_class) } : {}),
      at: Number(r.at ?? 0),
    }));
  } catch { /* fail-safe：采集失败不影响交接 */ }
  return facts;
}

// ── §18 #6 交叉校验 + 自动附加 ───────────────────────────────────────

export interface SelfReportCheck {
  /** 系统事实已存在、但前任 `selfLimits` 未声明的区域（**漏报**） */
  missingDeclarations: Array<{ fact: string; detail: string }>;
  /** 前任声明了、但系统事实中无对应痕迹的区域（声明无据，仅供提示） */
  unsupportedClaims: string[];
  /** 系统事实总条数（用于报告"前任漏报率"） */
  systemFactCount: number;
}

/** 判断某条系统事实是否被某条 `selfLimits` 覆盖（区域名包含工具名即视为覆盖） */
function coversLimit(limit: SelfLimit, factText: string): boolean {
  const area = limit.area.trim();
  if (!area) return false;
  return factText.includes(area) || area.includes(factText);
}

/** §18 #6：`selfLimits` × 系统事实 交叉校验 */
export function crossCheckSelfLimits(bundle: HandoffBundle): SelfReportCheck {
  const facts = bundle.systemFacts;
  const factTexts: Array<{ fact: string; detail: string }> = [
    ...facts.failedAttempts.map(f => ({ fact: f.toolName, detail: `失败尝试 ${f.toolName}${f.errorClass ? `（${f.errorClass}）` : ''}` })),
    ...facts.rejectedApprovals.map(a => ({ fact: a.approvalId, detail: `被拒审批 ${a.approvalId}` })),
    ...facts.revertedEdits.map(e => ({ fact: e.path, detail: `被回滚编辑 ${e.path}` })),
  ];
  const limits = bundle.selfLimits ?? [];
  const missingDeclarations = factTexts.filter(t => !limits.some(l => coversLimit(l, t.fact)));
  const unsupportedClaims = limits
    .filter(l => !factTexts.some(t => coversLimit(l, t.fact)))
    .map(l => l.area);
  return { missingDeclarations, unsupportedClaims, systemFactCount: factTexts.length };
}

/**
 * 把系统事实**自动附加**进交接包（§18 #6）：
 * 即使前任漏报，继任者也能看到"系统观察到的失败尝试"。
 */
export function augmentBundleWithSystemFacts(bundle: HandoffBundle, facts: HandoffSystemFacts, now = Date.now()): HandoffBundle {
  const merged: HandoffSystemFacts = {
    failedAttempts: [...(bundle.systemFacts?.failedAttempts ?? []), ...facts.failedAttempts],
    rejectedApprovals: [...(bundle.systemFacts?.rejectedApprovals ?? []), ...facts.rejectedApprovals],
    revertedEdits: [...(bundle.systemFacts?.revertedEdits ?? []), ...facts.revertedEdits],
  };
  const systemPitfalls = facts.failedAttempts.map(f => `[系统事实] ${f.toolName} 曾失败${f.errorClass ? `（${f.errorClass}）` : ''} —— 前任未在能力边界中声明`);
  return {
    ...bundle,
    systemFacts: merged,
    knownPitfalls: [...bundle.knownPitfalls, ...systemPitfalls.filter(p => !bundle.knownPitfalls.includes(p))],
    provenance: { ...bundle.provenance, eventRange: [bundle.provenance.eventRange[0], Math.max(bundle.provenance.eventRange[1], now)] },
  };
}

// ── R1 指纹对账 ─────────────────────────────────────────────────────

export interface ArtifactDiff {
  path: string;
  /** 交接包记录的哈希 */
  expected: string;
  /** 当前实际哈希（文件缺失为 null） */
  actual: string | null;
  reason: 'hash_mismatch' | 'missing' | 'size_mismatch';
}

export interface HandoffVerification {
  handoffId: string;
  status: 'verified' | 'conflict';
  diffs: ArtifactDiff[];
  checked: number;
  /** 前任自述与系统事实的一致性检查结果 */
  selfReport: SelfReportCheck;
  verifiedAt: number;
}

/** 计算文件 sha256（默认读取器；测试可注入避免真实 IO） */
function defaultReadArtifact(path: string): { sha256: string; sizeBytes: number } | null {
  try {
    const buf = readFileSync(path);
    return { sha256: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.byteLength };
  } catch { return null; }
}

/**
 * R1：逐产物比对指纹。
 * @param readArtifact 注入的读取器（默认读真实文件）
 */
export function verifyHandoffArtifacts(
  bundle: HandoffBundle,
  readArtifact: (path: string) => { sha256: string; sizeBytes: number } | null = defaultReadArtifact,
): { diffs: ArtifactDiff[]; checked: number; status: 'verified' | 'conflict' } {
  const diffs: ArtifactDiff[] = [];
  for (const a of bundle.artifacts as HandoffArtifact[]) {
    const actual = readArtifact(a.path);
    if (!actual) {
      diffs.push({ path: a.path, expected: a.sha256, actual: null, reason: 'missing' });
      continue;
    }
    if (actual.sha256 !== a.sha256) {
      diffs.push({ path: a.path, expected: a.sha256, actual: actual.sha256, reason: 'hash_mismatch' });
      continue;
    }
    if (a.sizeBytes !== undefined && actual.sizeBytes !== a.sizeBytes) {
      diffs.push({ path: a.path, expected: a.sha256, actual: actual.sha256, reason: 'size_mismatch' });
    }
  }
  return { diffs, checked: bundle.artifacts.length, status: diffs.length === 0 ? 'verified' : 'conflict' };
}

/**
 * R1 + §18 #6 完整对账：更新交接状态、留痕、发事件。
 *
 * ⚠️ 集成要点（读代码得到的事实）：**文件冲突不发布 `CONFLICT_DETECTED` 进仲裁** ——
 * `arbitrationWiring` 明确"文件冲突（conflictPrecheck 来源）无记忆原文，不自动仲裁，交合并流程处理"。
 * 因此本函数只发 `a2a:handoff_conflict`，把冲突交给**合并流程**，避免误启仲裁。
 */
export function verifyHandoff(
  handoffId: string,
  deps: {
    readArtifact?: (path: string) => { sha256: string; sizeBytes: number } | null;
    actorRole?: string;
    actorId?: string;
    now?: number;
  } = {},
): HandoffVerification | null {
  const bundle = loadHandoff(handoffId);
  if (!bundle) return null;
  const now = deps.now ?? Date.now();
  const { diffs, checked, status } = verifyHandoffArtifacts(bundle, deps.readArtifact);
  const selfReport = crossCheckSelfLimits(bundle);

  setHandoffVerification(handoffId, status);
  recordGovernanceAction({
    action: 'a2a.handoff_verify',
    actorRole: deps.actorRole ?? 'system',
    actorId: deps.actorId ?? 'a2a-broker',
    traceId: bundle.provenance.traceId,
    taskId: bundle.taskId,
    outcome: status === 'verified' ? 'allowed' : 'denied',
    reason: status === 'verified' ? `交接对账通过（${checked} 个产物）` : `交接对账冲突（${diffs.length}/${checked}）`,
    targetIds: [handoffId, ...diffs.map(d => d.path)],
  });

  publish(createEvent({
    eventType: status === 'verified' ? EventType.A2A_HANDOFF_VERIFIED : EventType.A2A_HANDOFF_CONFLICT,
    source: 'a2a-broker',
    traceId: bundle.provenance.traceId,
    payload: {
      handoffId, taskId: bundle.taskId, status, checked,
      diffs: diffs.map(d => ({ path: d.path, reason: d.reason })),
      selfReportMismatch: selfReport.missingDeclarations.length > 0,
      missingDeclarations: selfReport.missingDeclarations.map(d => d.detail),
    },
  }));

  if (selfReport.missingDeclarations.length > 0) {
    publish(createEvent({
      eventType: EventType.A2A_SELFREPORT_MISMATCH,
      source: 'a2a-broker',
      traceId: bundle.provenance.traceId,
      payload: {
        handoffId, taskId: bundle.taskId, fromAgentId: bundle.fromAgentId,
        systemFactCount: selfReport.systemFactCount,
        missingDeclarations: selfReport.missingDeclarations.map(d => d.detail),
        unsupportedClaims: selfReport.unsupportedClaims,
      },
    }));
    logger.warn(`[A2A] 交接 ${handoffId}：前任能力边界自述漏报 ${selfReport.missingDeclarations.length} 项（已按系统事实附加）`);
  }

  return { handoffId, status, diffs, checked, selfReport, verifiedAt: now };
}

// ── R2 复核义务 ─────────────────────────────────────────────────────

/** 某区域是否被前任标为"未验证"（继任者必须先复核才能依赖） */
export function requiresRevalidation(bundle: HandoffBundle, area: string): boolean {
  return (bundle.selfLimits ?? []).some(l => !l.verified && (l.area === area || l.area.includes(area) || area.includes(l.area)));
}

/**
 * R2：继任者能否依赖某区域的结论。
 * 规则：被标"未验证" ⇒ **必须先认领复核**（`acknowledgeSelfLimits`）才可依赖。
 */
export function canRelyOnFact(handoffId: string, area: string): { canRely: boolean; reason: string } {
  const bundle = loadHandoff(handoffId);
  if (!bundle) return { canRely: false, reason: 'handoff_not_found' };
  if (!requiresRevalidation(bundle, area)) return { canRely: true, reason: 'not_flagged_unverified' };
  const review = loadHandoffReview(handoffId);
  if (review.acknowledgedAreas.includes(area)) return { canRely: true, reason: 'revalidation_acknowledged' };
  return { canRely: false, reason: 'requires_revalidation' };
}

/** R2：继任者认领复核（记录到交接复核记录 + 治理留痕） */
export function acknowledgeSelfLimits(
  handoffId: string,
  areas: string[],
  meta: { reviewerAgentId?: string; now?: number } = {},
): HandoffReview | null {
  const bundle = loadHandoff(handoffId);
  if (!bundle) return null;
  const now = meta.now ?? Date.now();
  const previous = loadHandoffReview(handoffId);
  const merged: HandoffReview = {
    acknowledgedAreas: [...new Set([...previous.acknowledgedAreas, ...areas])],
    reviewedAt: now,
    ...(meta.reviewerAgentId ?? previous.reviewerAgentId ? { reviewerAgentId: meta.reviewerAgentId ?? previous.reviewerAgentId } : {}),
  };
  setHandoffReview(handoffId, merged);
  recordGovernanceAction({
    action: 'a2a.handoff_review',
    actorRole: 'system',
    actorId: meta.reviewerAgentId ?? 'a2a-broker',
    traceId: bundle.provenance.traceId,
    taskId: bundle.taskId,
    outcome: 'allowed',
    reason: `继任者认领复核：${areas.join('、') || '（空）'}`,
    targetIds: [handoffId],
  });
  return merged;
}
