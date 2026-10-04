/**
 * @module Arbitration/capsuleAssembler
 * @description
 * 胶囊组装器——Docs/Agent/05 §3.2。
 * 按需拉取证据，组装轻量级裁决上下文。
 * 最小信息原则：仲裁者绝不加载全局上下文，只看到"案卷"。
 */

import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

import type { ContextCapsule, OperationRecord } from './types.js';

// ── 证据拉取接口 ────────────────────────────────────────────────────

export interface EvidenceSource {
  getMemoryContent(memoryId: string): string | undefined;
  getMemoryMetadata(memoryId: string): Record<string, unknown>;
  getAgentOps(agentId: string, limit: number): OperationRecord[];
  getTaskContext(taskId: string): { description: string; constraints: string[] } | undefined;
}

// ── 内部状态 ────────────────────────────────────────────────────────

let evidenceSource: EvidenceSource | null = null;
let capsuleCounter = 0;

// ── 初始化 ──────────────────────────────────────────────────────────

export function initCapsuleAssembler(source: EvidenceSource): void {
  evidenceSource = source;
}

// ── 组装 ────────────────────────────────────────────────────────────

/**
 * 组装上下文胶囊。
 *
 * 证据优先级（FE-062 收敛）：
 *  - 内存证据源存在且提供 memoryId 内容 → 拉取真实证据 + Agent 历史；
 *  - 否则使用**内容直传**（tribunal 入口路径：案件已持有新旧记忆原文）；
 *  - 均无 → 简化占位（'简化模式'）。
 *
 * 注：本模块为胶囊组装的唯一实现（tribunal.assembleCapsule 委托此处，消除双实现漂移）。
 */
export function assembleCapsule(params: {
  conflictId: string;
  newMemoryId?: string;
  oldMemoryId?: string;
  /** 内容直传（无证据源时使用；tribunal 入口路径） */
  newMemoryContent?: string;
  oldMemoryContent?: string;
  plaintiffAgentId: string;
  defendantAgentId: string;
  taskId?: string;
  taskDescription?: string;
  tokenBudget?: number;
}): Result<ContextCapsule> {
  if (!evidenceSource) {
    // 无证据源：内容直传（tribunal 路径）或简化占位
    return ok(createSimpleCapsule(params));
  }

  const src = evidenceSource;

  // [2a] 拉取证据（memoryId 可用时）；否则回退直传内容
  const newContent = (params.newMemoryId ? src.getMemoryContent(params.newMemoryId) : undefined)
    ?? params.newMemoryContent ?? '(证据缺失)';
  const oldContent = (params.oldMemoryId ? src.getMemoryContent(params.oldMemoryId) : undefined)
    ?? params.oldMemoryContent ?? '(证据缺失)';
  const newMeta = params.newMemoryId ? src.getMemoryMetadata(params.newMemoryId) : {};
  const oldMeta = params.oldMemoryId ? src.getMemoryMetadata(params.oldMemoryId) : {};

  // [2b] 拉取环境上下文
  const taskCtx = (params.taskId ? src.getTaskContext(params.taskId) : undefined) ?? {
    description: params.taskDescription ?? '(任务上下文缺失)',
    constraints: [],
  };

  // [2c] 拉取 Agent 历史记录（最近 5 条）
  const plaintiffOps = src.getAgentOps(params.plaintiffAgentId, 5);
  const defendantOps = src.getAgentOps(params.defendantAgentId, 5);

  // [2d] 组装胶囊
  const capsule: ContextCapsule = {
    capsuleId: `capsule-${++capsuleCounter}`,
    conflictId: params.conflictId,
    evidence: {
      newMemory: {
        content: newContent,
        metadata: newMeta,
        agentId: params.plaintiffAgentId,
      },
      oldMemory: {
        content: oldContent,
        metadata: oldMeta,
        agentId: params.defendantAgentId,
      },
    },
    taskContext: {
      parentTaskDescription: taskCtx.description,
      constraints: taskCtx.constraints,
    },
    agentHistory: {
      plaintiffOps,
      defendantOps,
    },
    tokenBudget: params.tokenBudget ?? 5000,
    createdAt: Date.now(),
  };

  return ok(capsule);
}

// ── 简化组装（无证据源时）────────────────────────────────────────────

function createSimpleCapsule(params: {
  conflictId: string;
  newMemoryContent?: string;
  oldMemoryContent?: string;
  plaintiffAgentId: string;
  defendantAgentId: string;
  taskDescription?: string;
  tokenBudget?: number;
}): ContextCapsule {
  return {
    capsuleId: `capsule-simple-${++capsuleCounter}`,
    conflictId: params.conflictId,
    evidence: {
      newMemory: {
        content: params.newMemoryContent ?? '(简化模式)',
        metadata: { source: params.plaintiffAgentId },
        agentId: params.plaintiffAgentId,
      },
      oldMemory: {
        content: params.oldMemoryContent ?? '(简化模式)',
        metadata: { source: params.defendantAgentId },
        agentId: params.defendantAgentId,
      },
    },
    taskContext: {
      parentTaskDescription: params.taskDescription ?? '(简化模式)',
      constraints: [],
    },
    agentHistory: { plaintiffOps: [], defendantOps: [] },
    tokenBudget: params.tokenBudget ?? 5000,
    createdAt: Date.now(),
  };
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetCapsuleAssembler(): void {
  evidenceSource = null;
  capsuleCounter = 0;
}
