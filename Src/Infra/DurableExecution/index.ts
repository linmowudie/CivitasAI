/**
 * Infra/DurableExecution 模块导出桶
 */

// Effect Journal
export { initEffectJournal, hashPayload, recordIntent, markExecuting, markSucceeded, markFailed, resolveTimedOutEffects, getUnknownEffects, getPendingEffects, findByIdepotencyKey, getPendingCount } from './effectJournal.js';

// Checkpoint Store
export { createCheckpoint, loadLatestCheckpoint, loadCheckpoint, listCheckpoints, pruneCheckpoints, makeCheckpointId } from './checkpointStore.js';

// Idempotency Store
export { initIdempotencyStore, makeIdempotencyKey, lookup, store, purgeExpired, getCacheSize } from './idempotencyStore.js';

// Recovery
export { initRecoveryScanner, scanAndProposeRecovery, getHumanRequiredPlans, getAutoResumePlans } from './recoveryScanner.js';
export { executeRecovery, resume, validateRecoveryPlan } from './recoveryExecutor.js';

// Types
export type { EffectRecord, EffectKind, EffectStatus, ErrorClass, CreateEffectInput } from './effectJournal.js';
export type { Checkpoint, CreateCheckpointInput } from './checkpointStore.js';
export type { IdempotencyRecord, IdempotencyLookup } from './idempotencyStore.js';
export type { RecoveryPlan, RecoveryStrategy } from './recoveryScanner.js';
export type { ResumeResult } from './recoveryExecutor.js';
export { RecoveryError } from './schemas/RecoveryPlan.js';
