/**
 * @module Arbitration/capsuleAssembler
 * @description
 * 胶囊组装器——Docs/05 §3.2。
 * 按需拉取证据，组装轻量级裁决上下文。
 * 最小信息原则：仲裁者绝不加载全局上下文，只看到"案卷"。
 */

import type { ContextCapsule, OperationRecord } from './types.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

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
 * Phase 0-2：使用内存证据源；Phase 3 拉取真实向量库/DB 数据。
 */
export function assembleCapsule(params: {
  conflictId: string;
  newMemoryId: string;
  oldMemoryId: string;
  plaintiffAgentId: string;
  defendantAgentId: string;
  taskId: string;
  tokenBudget?: number;
}): Result<ContextCapsule> {
  if (!evidenceSource) {
    // 无证据源时使用简化组装
    return ok(createSimpleCapsule(params));
  }

  const src = evidenceSource;

  // [2a] 拉取证据
  const newContent = src.getMemoryContent(params.newMemoryId) ?? '(证据缺失)';
  const oldContent = src.getMemoryContent(params.oldMemoryId) ?? '(证据缺失)';
  const newMeta = src.getMemoryMetadata(params.newMemoryId);
  const oldMeta = src.getMemoryMetadata(params.oldMemoryId);

  // [2b] 拉取环境上下文
  const taskCtx = src.getTaskContext(params.taskId) ?? {
    description: '(任务上下文缺失)',
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
  plaintiffAgentId: string;
  defendantAgentId: string;
  tokenBudget?: number;
}): ContextCapsule {
  return {
    capsuleId: `capsule-simple-${++capsuleCounter}`,
    conflictId: params.conflictId,
    evidence: {
      newMemory: { content: '(简化模式)', metadata: {}, agentId: params.plaintiffAgentId },
      oldMemory: { content: '(简化模式)', metadata: {}, agentId: params.defendantAgentId },
    },
    taskContext: { parentTaskDescription: '(简化模式)', constraints: [] },
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
