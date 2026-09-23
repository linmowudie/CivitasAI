/**
 * @module AgentRuntime/stateMachine
 * @description
 * Agent 状态机——Docs/02 §6.1。
 * 6 态转换规则，严格校验合法转换。
 * Loop 级状态（awaiting_approval）不影响 Agent 态。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

import type { AgentStatus, AgentEvent } from './types.js';

// ── 合法转换表（Docs/02 §6.1）──────────────────────────────────────

const VALID_TRANSITIONS: Record<AgentStatus, Record<string, AgentStatus>> = {
  creating: {
    'INIT_COMPLETE': 'ready',
  },
  ready: {
    'TASK_ASSIGNED': 'running',
    'DESTROY': 'destroyed',
  },
  running: {
    'TASK_COMPLETED': 'ready',
    'TASK_FAILED': 'ready',
    'SUSPEND': 'suspended',
    'EXPEL': 'expelled',
    'DESTROY': 'destroyed',
  },
  suspended: {
    'RESTORE': 'running',
    'EXPEL': 'expelled',
    'DESTROY': 'destroyed',
  },
  expelled: {
    'RECRUIT': 'creating',  // 重新招募（新 agent_id）
    'DESTROY': 'destroyed',
  },
  destroyed: {},
};

// ── 状态转换 ────────────────────────────────────────────────────────

/**
 * 执行状态转换。
 * @returns 新状态，或错误（非法转换）
 */
export function transition(
  currentStatus: AgentStatus,
  event: AgentEvent,
): Result<AgentStatus> {
  const transitions = VALID_TRANSITIONS[currentStatus];
  if (!transitions) {
    return err(`无效状态: ${currentStatus}`);
  }

  const nextStatus = transitions[event.type];
  if (!nextStatus) {
    return err(
      `非法状态转换: ${currentStatus} + ${event.type} → 无合法目标状态`,
    );
  }

  return ok(nextStatus);
}

/**
 * 检查转换是否合法（不执行）
 */
export function canTransition(
  currentStatus: AgentStatus,
  event: AgentEvent,
): boolean {
  const transitions = VALID_TRANSITIONS[currentStatus];
  if (!transitions) return false;
  return event.type in transitions;
}

/**
 * 获取当前状态可触发的所有事件
 */
export function getAvailableEvents(status: AgentStatus): string[] {
  const transitions = VALID_TRANSITIONS[status];
  if (!transitions) return [];
  return Object.keys(transitions);
}

/**
 * 获取状态的所有合法后继状态
 */
export function getNextStates(status: AgentStatus): AgentStatus[] {
  const transitions = VALID_TRANSITIONS[status];
  if (!transitions) return [];
  return [...new Set(Object.values(transitions))];
}
