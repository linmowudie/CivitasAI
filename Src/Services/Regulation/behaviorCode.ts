/**
 * @module Regulation/behaviorCode
 * @description
 * 行为准则管理器——Docs/Agent/06 §1.3。
 * 加载/更新/发布《智能体行为准则》。
 * Phase 0-2：内置默认准则；Phase 3 支持动态更新。
 */

import { EventType } from '../EventBus/eventTypes.js';
import { createEvent, publish } from '../EventBus/eventBus.js';
import { requireGovernanceRole } from '../Governance/governanceGuard.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 类型定义 ────────────────────────────────────────────────────────

export type RuleCategory = 'safety' | 'communication' | 'resource' | 'cooperation';
export type RuleAction = 'warn' | 'restrict' | 'forbid' | 'report';
export type RuleSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface BehaviorRule {
  ruleId: string;
  category: RuleCategory;
  description: string;
  condition: string;
  action: RuleAction;
  severity: RuleSeverity;
  enforceable: boolean;
}

export interface BehaviorCode {
  version: string;
  rules: BehaviorRule[];
  effectiveAt: number;
  publishedAt: number;
}

// ── 内部状态 ────────────────────────────────────────────────────────

let currentCode: BehaviorCode | null = null;
const history: BehaviorCode[] = [];

// ── 默认准则（Docs/Agent/06 §1.3 Phase 1 最小集）─────────────────────────

const DEFAULT_RULES: BehaviorRule[] = [
  {
    ruleId: 'safety-001',
    category: 'safety',
    description: '禁止 Agent 越权访问其他 Agent 私有上下文',
    condition: 'agent.access(other_agent.private_context)',
    action: 'forbid',
    severity: 'critical',
    enforceable: true,
  },
  {
    ruleId: 'safety-002',
    category: 'safety',
    description: '禁止通过 Prompt 注入篡改仲裁/审计逻辑',
    condition: 'agent.prompt_injection(target=arbitration|audit)',
    action: 'forbid',
    severity: 'critical',
    enforceable: true,
  },
  {
    ruleId: 'cooperation-001',
    category: 'cooperation',
    description: 'Worker 连续 3 次交付失败须被开除',
    condition: 'agent.consecutive_failures >= 3',
    action: 'report',
    severity: 'high',
    enforceable: true,
  },
  {
    ruleId: 'communication-001',
    category: 'communication',
    description: '重大异常须上报监管局',
    condition: 'agent.encounter(critical_anomaly)',
    action: 'report',
    severity: 'high',
    enforceable: true,
  },
  {
    ruleId: 'resource-001',
    category: 'resource',
    description: 'Token 消耗超预算须申请补充',
    condition: 'agent.token_consumed > agent.token_budget',
    action: 'warn',
    severity: 'medium',
    enforceable: false,
  },
];

// ── 初始化 ──────────────────────────────────────────────────────────

export function initBehaviorCode(): void {
  const now = Date.now();
  currentCode = {
    version: '1.0.0',
    rules: [...DEFAULT_RULES],
    effectiveAt: now,
    publishedAt: now,
  };
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getCurrentCode(): BehaviorCode | null {
  return currentCode ? { ...currentCode, rules: [...currentCode.rules] } : null;
}

export function getRules(category?: RuleCategory): BehaviorRule[] {
  if (!currentCode) return [];
  if (category) return currentCode.rules.filter(r => r.category === category);
  return [...currentCode.rules];
}

export function getRule(ruleId: string): BehaviorRule | undefined {
  return currentCode?.rules.find(r => r.ruleId === ruleId);
}

// ── 规则校验 ────────────────────────────────────────────────────────

/**
 * 检查某行为是否违反行为准则。
 *
 * 可执行规则语法（v1，FE-060 增强）：
 *  - `tool.forbid(<name>)` / `tool.forbid(<prefix>.*)`：禁止调用指定工具（精确或前缀通配）；
 *  - 历史关键词匹配保留（safety-001/002、cooperation-001），enforceable=false 的声明式规则不强制。
 */
export function checkViolation(params: {
  agentId: string;
  action: string;
  context?: Record<string, unknown>;
}): { violated: boolean; rules: BehaviorRule[] } {
  if (!currentCode) return { violated: false, rules: [] };

  const violatedRules = currentCode.rules.filter(rule => {
    // 仅 enforceable 规则参与强制（声明式/目标态规则不阻断执行）
    if (!rule.enforceable) return false;

    // v1 可执行语法：tool.forbid(<pattern>)
    const forbidMatch = /^tool\.forbid\((.+)\)$/.exec(rule.condition.trim());
    if (forbidMatch) {
      const pattern = forbidMatch[1]?.trim() ?? '';
      if (pattern.endsWith('.*')) {
        return params.action.startsWith(pattern.slice(0, -1)); // 'shell.*' → 前缀 'shell.'
      }
      return params.action === pattern;
    }

    // 历史关键词匹配（Phase 0-2 兼容）
    if (rule.ruleId === 'safety-001' && params.action.includes('access_private')) return true;
    if (rule.ruleId === 'safety-002' && params.action.includes('prompt_injection')) return true;
    if (rule.ruleId === 'cooperation-001' && params.action.includes('consecutive_failure')) return true;
    return false;
  });

  return {
    violated: violatedRules.length > 0,
    rules: violatedRules,
  };
}

// ── 更新准则 ────────────────────────────────────────────────────────
//
// ★ FE-043（2026-10-04）：立法动作守卫下沉到本层 —— 此前只有
//   `regulatoryAuthority.addBehaviorRule/removeBehaviorRule` 代理层有守卫，
//   底层 `addRule/removeRule/updateVersion` 可被任意角色直调（清单 G-04 声称已实现，
//   实际存在旁路）。现所有入口 fail-closed，代理层不再重复守卫（避免双重留痕）。

export function addRule(rule: BehaviorRule, actorRole: string): Result<void> {
  const guard = requireGovernanceRole(actorRole, '新增行为规则（监管立法）');
  if (!guard.ok) return err(guard.error);
  if (!currentCode) return err('行为准则未初始化');
  if (currentCode.rules.some(r => r.ruleId === rule.ruleId)) {
    return err(`规则 ${rule.ruleId} 已存在`);
  }

  currentCode.rules.push(rule);
  publishRuleUpdate(rule);
  return ok(undefined);
}

export function removeRule(ruleId: string, actorRole: string): Result<void> {
  const guard = requireGovernanceRole(actorRole, '删除行为规则（监管立法）');
  if (!guard.ok) return err(guard.error);
  if (!currentCode) return err('行为准则未初始化');
  const idx = currentCode.rules.findIndex(r => r.ruleId === ruleId);
  if (idx < 0) return err(`规则 ${ruleId} 不存在`);

  currentCode.rules.splice(idx, 1);
  publishRuleUpdate({ ruleId, action: 'removed' } as any);
  return ok(undefined);
}

export function updateVersion(version: string, actorRole: string): Result<void> {
  const guard = requireGovernanceRole(actorRole, '更新行为准则版本（监管立法）');
  if (!guard.ok) return err(guard.error);
  if (!currentCode) return err('行为准则未初始化');

  const old = { ...currentCode };
  history.push(old);

  currentCode.version = version;
  currentCode.effectiveAt = Date.now();
  currentCode.publishedAt = Date.now();

  publish(createEvent({
    eventType: EventType.RULE_UPDATED,
    source: 'Regulation/behaviorCode',
    payload: { version, ruleCount: currentCode.rules.length },
  }));

  return ok(undefined);
}

function publishRuleUpdate(rule: BehaviorRule): void {
  publish(createEvent({
    eventType: EventType.RULE_UPDATED,
    source: 'Regulation/behaviorCode',
    payload: { ruleId: rule.ruleId, category: rule.category, action: rule.action },
  }));
}

// ── 历史 ────────────────────────────────────────────────────────────

export function getHistory(): BehaviorCode[] {
  return [...history];
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetBehaviorCode(): void {
  currentCode = null;
  history.length = 0;
}
