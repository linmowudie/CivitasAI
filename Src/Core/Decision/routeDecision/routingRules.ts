/**
 * @module Decision/RouteDecision/routingRules
 * @description
 * 路由规则配置——Docs/03 §3.3。
 * 从 routingRules.json 加载，提供默认值。
 */

import type { RoutingRulesConfig } from '../types.js';

// ── 默认配置 ────────────────────────────────────────────────────────

const DEFAULT_RULES: RoutingRulesConfig = {
  consortiumTokenThreshold: 50000,
  consortiumDomainThreshold: 2,
  delegationMaxCouplingScore: 0.3,
  delegationMinSubtaskCount: 2,
  assemblyLineSopRequired: true,
  directExecMaxTokens: 10000,
};

let currentRules: RoutingRulesConfig = { ...DEFAULT_RULES };

// ── 配置操作 ────────────────────────────────────────────────────────

export function getRoutingRules(): RoutingRulesConfig {
  return { ...currentRules };
}

export function updateRoutingRules(partial: Partial<RoutingRulesConfig>): void {
  currentRules = { ...currentRules, ...partial };
}

export function resetRoutingRules(): void {
  currentRules = { ...DEFAULT_RULES };
}
