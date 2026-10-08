/**
 * @module Services/A2A/alertDisposition
 * @description 串通告警**处置链**（P0a 后端内核）—— 设计 §7.3 与 §19.4 Q4。
 *
 * 设计原则（fail-closed，**不做静默降级**）：
 *  - 处置本身是**治理动作**：经 `requireGovernanceRole` 校验（自动留痕 allow/deny）；
 *  - 角色与处置**强绑定**：`frozen` 需审计局（auditor）、`arbitrated` 需仲裁庭（arbitrator）、
 *    `warned/cooled` 为任一 L0；角色不符**直接拒绝**（绝不自动降级成"警告"了事）；
 *  - **执行效力**：
 *      · `cooled` → 写入**配对冷却**，Broker 第③步据此拒绝该对后续消息（真拦截，不只是标签）；
 *      · `frozen` → 调审计局 `freeze`（软销毁 + 前置监管拒执行）；
 *      · `arbitrated` → 调仲裁庭 `fileCase`（进入既有六步闭环）；
 *  - 每次处置写**治理台账**并发布 `a2a:alert_disposed`。
 */

import { publish, createEvent } from '../EventBus/eventBus.js';
import { EventType } from '../EventBus/eventTypes.js';
import { logger } from '../../Infra/Logging/logger.js';
import { requireGovernanceRole } from '../Governance/governanceGuard.js';
import { recordGovernanceAction } from '../Governance/governanceAudit.js';
import { toCanonicalRole } from '../../Infra/Roles/roleVocabulary.js';
import { freeze } from '../Audit/resourceAuditBureau.js';
import { fileCase } from '../Arbitration/tribunal.js';
import { getAlertById, setCooldown, updateAlertDisposition } from './a2aStore.js';
import type { CollusionAlert } from './types.js';
import { err, ok, type Result } from '../../Infra/types.js';

/** 默认冷却时长（10 分钟） */
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

export type AlertDisposition = CollusionAlert['disposition'];

export interface DisposeResult {
  alertId: string;
  disposition: AlertDisposition;
  /** 实际产生的副作用（可测） */
  effects: string[];
  /** 部分失败信息（不吞掉） */
  failures: string[];
}

/** 处置与角色的绑定表（**不允许静默降级**） */
const DISPOSITION_REQUIRED_ROLE: Partial<Record<AlertDisposition, string>> = {
  frozen: 'auditor',
  arbitrated: 'arbitrator',
};

/**
 * 处置一条串通告警。
 * @param params.targetAgentIds 冻结/仲裁针对的对象（默认取告警参与者）
 */
export function disposeAlert(params: {
  alertId: string;
  disposition: AlertDisposition;
  actorRole: string;
  actorId?: string;
  reason?: string;
  targetAgentIds?: string[];
  cooldownMs?: number;
  now?: number;
}): Result<DisposeResult> {
  const now = params.now ?? Date.now();
  const alert = getAlertById(params.alertId);
  if (!alert) return err(`告警 ${params.alertId} 不存在`);
  if (params.disposition === 'pending') return err('处置不得回退为 pending');

  // ★ 治理动作门（自动留痕 allow/deny）
  const guard = requireGovernanceRole(params.actorRole, 'A2A 告警处置', {
    ...(params.actorId !== undefined ? { actorId: params.actorId } : {}),
    ...(alert.taskId !== undefined ? { taskId: alert.taskId } : {}),
    targetIds: [params.alertId, ...alert.participants],
  });
  if (!guard.ok) return err(guard.error);

  // ★ 角色与处置强绑定（fail-closed，不降级）
  const requiredRole = DISPOSITION_REQUIRED_ROLE[params.disposition];
  if (requiredRole) {
    const isOwner = params.actorRole === 'user';
    const canonical = toCanonicalRole(params.actorRole);
    if (!isOwner && canonical !== requiredRole) {
      return err(
        `处置「${params.disposition}」需角色 ${requiredRole}（当前 ${params.actorRole}）—— 不做静默降级，请交由对应治理角色处置`,
      );
    }
  }

  const targets = params.targetAgentIds ?? alert.participants;
  const effects: string[] = [];
  const failures: string[] = [];

  // ── 执行效力 ─────────────────────────────────────────────────────
  if (params.disposition === 'cooled') {
    const cooldownMs = params.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const [a, b] = alert.participants;
    const until = now + cooldownMs;
    if (a && b) {
      setCooldown(a, b, until, params.reason ?? `热冷却：${alert.ruleId}`, alert.alertId);
      setCooldown(b, a, until, params.reason ?? `热冷却：${alert.ruleId}`, alert.alertId);
      effects.push(`cooldown:${a}↔${b}:${cooldownMs}ms`);
    }
  } else if (params.disposition === 'frozen') {
    for (const agentId of targets) {
      const r = freeze(agentId, params.reason ?? `串通告警 ${alert.alertId}（${alert.ruleId}）`, params.actorRole);
      if (r && typeof r === 'object' && 'ok' in r && r.ok === false) failures.push(`freeze:${agentId}:${String(r.error)}`);
      else effects.push(`frozen:${agentId}`);
    }
  } else if (params.disposition === 'arbitrated') {
    const [plaintiff, defendant] = targets;
    if (!plaintiff || !defendant) {
      failures.push('fileCase:缺少原告或被告');
    } else {
      const filed = fileCase({
        conflictId: `a2a:${alert.alertId}`,
        traceId: alert.taskId ?? alert.alertId,
        conflictType: 'contradiction',
        plaintiffAgentId: plaintiff,
        defendantAgentId: defendant,
      });
      if (!filed.ok) failures.push(`fileCase:${String(filed.error)}`);
      else effects.push(`case_filed:${filed.value.caseId}`);
    }
  }

  // ── 更新告警状态 + 留痕 + 事件 ────────────────────────────────────
  updateAlertDisposition(params.alertId, params.disposition, now);
  const outcomeLabel = failures.length > 0 ? '部分失败' : '已执行';
  recordGovernanceAction({
    action: 'a2a.alert_dispose',
    actorRole: params.actorRole,
    actorId: params.actorId ?? `governance:${params.actorRole}`,
    ...(alert.taskId ? { traceId: alert.taskId, taskId: alert.taskId } : {}),
    outcome: failures.length > 0 ? 'denied' : 'allowed',
    reason: `告警 ${alert.alertId}（${alert.ruleId}）→ ${params.disposition}｜${outcomeLabel}${params.reason ? `｜${params.reason}` : ''}`,
    targetIds: [alert.alertId, ...targets],
  });
  publish(createEvent({
    eventType: EventType.A2A_ALERT_DISPOSED,
    source: 'a2a-broker',
    ...(alert.taskId ? { traceId: alert.taskId } : {}),
    payload: {
      alertId: alert.alertId, ruleId: alert.ruleId, severity: alert.severity,
      disposition: params.disposition, actorRole: params.actorRole,
      participants: alert.participants, targets, effects, failures,
    },
  }));
  if (failures.length > 0) logger.warn(`[A2A] 告警 ${alert.alertId} 处置「${params.disposition}」存在失败：${failures.join('；')}`);

  return ok({ alertId: alert.alertId, disposition: params.disposition, effects, failures });
}
