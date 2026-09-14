/**
 * Checkpoint 类型定义（Docs/13 §5.2 / Docs/10 §8.2 #2）
 *
 * 每轮 iteration 末尾的快照，用于崩溃恢复。
 */

// ===== 辅助类型 =====

/** 产出文件指纹 */
export interface ArtifactEntry {
  readonly path: string;
  /** SHA-256 */
  readonly hash: string;
  readonly sizeBytes: number;
}

/** LoopState 快照（简化版，完整定义在 Docs/12 §4.2） */
export interface LoopStateSnapshot {
  readonly iteration: number;
  readonly phase: string;
  readonly completedSteps: number;
  readonly failedAttempts: number;
  readonly [key: string]: unknown;
}

// ===== 核心类型 =====

/** 检查点记录（Docs/13 §5.2） */
export interface Checkpoint {
  /** = {loopId}#{iteration}#{ts} */
  readonly checkpointId: string;
  readonly loopId: string;
  readonly iteration: number;
  readonly stateSnapshot: LoopStateSnapshot;
  readonly artifactManifest: ArtifactEntry[];
  /** 未完成的副作用 ID 列表 */
  readonly pendingEffects: string[];
  /** Agent 自评下一步（辅助恢复） */
  readonly nextStepHint?: string;
  /** epoch ms */
  readonly createdAt: number;
}

/** 创建 Checkpoint 的输入参数 */
export interface CreateCheckpointInput {
  readonly loopId: string;
  readonly iteration: number;
  readonly stateSnapshot: LoopStateSnapshot;
  readonly artifactManifest: ArtifactEntry[];
  readonly pendingEffects: string[];
  readonly nextStepHint?: string;
}

/** Checkpoint 数据库行（snake_case） */
export interface CheckpointRow {
  readonly checkpoint_id: string;
  readonly loop_id: string;
  readonly iteration: number;
  readonly state_snapshot_json: string;
  readonly artifact_manifest_json: string;
  readonly pending_effects_json: string;
  readonly next_step_hint: string | null;
  readonly created_at: number;
}
