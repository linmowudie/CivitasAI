/**
 * @module Interface/RestApi/regulationApi
 * @description
 * 监管域动作端点（FE-060 实装）——为监管域四件（行为法典 / 广播 / 紧急干预 / 终审升级）
 * 提供真实触发面（此前整域静态不可达，仅能读历史）。
 *
 * 端点：
 *  - `GET  /api/regulation/behavior-code`     → 行为准则（版本 + 规则集）
 *  - `POST /api/regulation/rules`             → 新增行为规则（治理立法；含 tool.forbid 可执行语法）
 *  - `DELETE /api/regulation/rules/:ruleId`   → 删除行为规则
 *  - `POST /api/regulation/broadcast`         → 治理广播（写入 GlobalWorkspace）
 *  - `POST /api/regulation/intervene`         → 紧急干预
 *  - `POST /api/regulation/escalate`          → 仲裁死锁升级（监管终审）
 *  - `GET  /api/regulation/emergencies`       → 紧急干预记录
 *
 * 说明：`actorRole` 由请求体携带，服务层 `requireGovernanceRole` 校验（fail-closed）——
 * 本地单用户场景下用户以 'user'（所有者）身份执行治理动作。
 */

import { json, apiError, registerRoute } from './router.js';
import {
  getBehaviorCode, addBehaviorRule, removeBehaviorRule,
  broadcastMessage, emergencyIntervene, escalateDeadlock,
  getEmergencyRecords, getInterventions,
  type InterventionType,
} from '../../Services/Regulation/regulatoryAuthority.js';
import type { BehaviorRule, RuleCategory, RuleAction, RuleSeverity } from '../../Services/Regulation/behaviorCode.js';
import type { BroadcastType } from '../../Services/Regulation/broadcastChannel.js';
import { getBehaviorCodeMarkdown } from '../../Services/Prompts/skillsAssets.js';
import { getCase } from '../../Services/Arbitration/tribunal.js';

const RULE_CATEGORIES: RuleCategory[] = ['safety', 'communication', 'resource', 'cooperation'];
const RULE_ACTIONS: RuleAction[] = ['warn', 'restrict', 'forbid', 'report'];
const RULE_SEVERITIES: RuleSeverity[] = ['low', 'medium', 'high', 'critical'];
const BROADCAST_TYPES: BroadcastType[] = ['rule_update', 'emergency_alert', 'system_notice', 'arbitration_deadlock'];
const INTERVENTION_TYPES: InterventionType[] = ['force_terminate', 'pause_all', 'force_restart', 'rule_emergency'];

/** 治理守卫失败（角色/权限类）→ 403；参数/状态类 → 400 */
function errorStatus(message: string): number {
  return /拒绝|仅|权限|role|guard/i.test(message) ? 403 : 400;
}

/** 解析不可信的规则对象（字段缺失/非法 → 说明字符串） */
function parseRule(raw: unknown): { ok: true; rule: BehaviorRule } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'rule 必须是对象' };
  const r = raw as Record<string, unknown>;
  const ruleId = typeof r['ruleId'] === 'string' ? r['ruleId'] : '';
  const description = typeof r['description'] === 'string' ? r['description'] : '';
  const condition = typeof r['condition'] === 'string' ? r['condition'] : '';
  if (!ruleId || !description || !condition) return { ok: false, reason: 'ruleId/description/condition 必填' };
  if (!RULE_CATEGORIES.includes(r['category'] as RuleCategory)) return { ok: false, reason: `category 非法（合法：${RULE_CATEGORIES.join('/')}）` };
  if (!RULE_ACTIONS.includes(r['action'] as RuleAction)) return { ok: false, reason: `action 非法（合法：${RULE_ACTIONS.join('/')}）` };
  if (!RULE_SEVERITIES.includes(r['severity'] as RuleSeverity)) return { ok: false, reason: `severity 非法（合法：${RULE_SEVERITIES.join('/')}）` };

  return {
    ok: true,
    rule: {
      ruleId,
      category: r['category'] as RuleCategory,
      description,
      condition,
      action: r['action'] as RuleAction,
      severity: r['severity'] as RuleSeverity,
      enforceable: r['enforceable'] === true,
    },
  };
}

export function registerRegulationRoutes(): void {
  // ── 行为法典 ─────────────────────────────────────────────────────

  registerRoute('GET', '/api/regulation/behavior-code', async () => {
    const code = getBehaviorCode();
    // FE-071：附加 Skills/rules/behaviorCode.md 法典文档（markdown）
    const doc = getBehaviorCodeMarkdown();
    if (!code) return json({ code: null, doc, message: '行为准则未初始化（启动序列 ⑲ 未执行）' });
    return json({ code, doc });
  });

  registerRoute('POST', '/api/regulation/rules', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actorRole = typeof body['actorRole'] === 'string' ? body['actorRole'] : '';
    const parsed = parseRule(body['rule']);
    if (!parsed.ok) return apiError(parsed.reason, 400);

    const result = addBehaviorRule(parsed.rule, actorRole);
    if (!result.ok) return apiError(result.error, errorStatus(result.error));
    return json({ added: parsed.rule.ruleId, version: getBehaviorCode()?.version });
  });

  registerRoute('DELETE', '/api/regulation/rules/:ruleId', async (req) => {
    const ruleId = req.params.ruleId;
    if (!ruleId) return apiError('ruleId 必填', 400);
    const actorRole = (req.query['actorRole'] ?? '') as string;

    const result = removeBehaviorRule(ruleId, actorRole);
    if (!result.ok) return apiError(result.error, errorStatus(result.error));
    return json({ removed: ruleId });
  });

  // ── 治理广播 ─────────────────────────────────────────────────────

  registerRoute('POST', '/api/regulation/broadcast', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actorRole = typeof body['actorRole'] === 'string' ? body['actorRole'] : '';
    const type = body['type'] as BroadcastType;
    const title = typeof body['title'] === 'string' ? body['title'] : '';
    const content = typeof body['content'] === 'string' ? body['content'] : '';
    if (!BROADCAST_TYPES.includes(type)) return apiError(`type 非法（合法：${BROADCAST_TYPES.join('/')}）`, 400);
    if (!title || !content) return apiError('title/content 必填', 400);

    const result = broadcastMessage({
      type,
      title,
      content,
      priority: (body['priority'] as 'normal' | 'high' | 'critical') ?? 'normal',
      ...(Array.isArray(body['targetAgentIds']) ? { targetAgentIds: (body['targetAgentIds'] as unknown[]).map(String) } : {}),
      requiresAck: body['requiresAck'] === true,
      actorRole,
    });
    if (!result.ok) return apiError(result.error, errorStatus(result.error));
    return json({ broadcast: result.value });
  });

  // ── 紧急干预 ─────────────────────────────────────────────────────

  registerRoute('POST', '/api/regulation/intervene', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actorRole = typeof body['actorRole'] === 'string' ? body['actorRole'] : '';
    const type = body['type'] as InterventionType;
    const reason = typeof body['reason'] === 'string' ? body['reason'] : '';
    if (!INTERVENTION_TYPES.includes(type)) return apiError(`type 非法（合法：${INTERVENTION_TYPES.join('/')}）`, 400);
    if (!reason) return apiError('reason 必填', 400);

    const result = emergencyIntervene({
      type,
      reason,
      ...(Array.isArray(body['targetAgentIds']) ? { targetAgentIds: (body['targetAgentIds'] as unknown[]).map(String) } : {}),
      actorRole,
    });
    if (!result.ok) return apiError(result.error, errorStatus(result.error));
    return json({ emergency: result.value });
  });

  registerRoute('GET', '/api/regulation/emergencies', async () => {
    return json({ items: getEmergencyRecords() });
  });

  // ── 僵局升级（监管终审）────────────────────────────────────────────

  registerRoute('POST', '/api/regulation/escalate', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actorRole = typeof body['actorRole'] === 'string' ? body['actorRole'] : '';
    const caseId = typeof body['caseId'] === 'string' ? body['caseId'] : '';
    const reason = typeof body['reason'] === 'string' ? body['reason'] : 'escalation';
    if (!caseId) return apiError('caseId 必填', 400);

    const arbitrationCase = getCase(caseId);
    if (!arbitrationCase) return apiError(`案件 ${caseId} 不存在`, 404);

    const result = escalateDeadlock(
      arbitrationCase,
      (['deadlock', 'timeout', 'escalation'] as const).includes(reason as 'deadlock') ? (reason as 'deadlock' | 'timeout' | 'escalation') : 'escalation',
      actorRole,
    );
    if (!result.ok) return apiError(result.error, errorStatus(result.error));
    return json({ intervention: result.value, interventions: getInterventions() });
  });
}
