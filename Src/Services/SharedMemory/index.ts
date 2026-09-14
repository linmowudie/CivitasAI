/**
 * @module SharedMemory/index
 * @description
 * 共享记忆系统统一导出——Docs/07。
 */

// ── VersionedEntry 类型 ─────────────────────────────────────────────
export type {
  WorkspaceEntry, WriteResult, VersionConflict, WorkspaceQuery,
  ContentType, EntryStatus, ConflictStrategy,
} from './versionedEntry.js';

// ── CausalTokens ────────────────────────────────────────────────────
export {
  mergeClocks, happensBefore, isConcurrent,
  incrementClock, clockToTokens, tokensToClock,
} from './causalTokens.js';
export type { VectorClock } from './causalTokens.js';

// ── WorkspaceLock ───────────────────────────────────────────────────
export {
  acquireLock, releaseLock, getActiveLocks, resetWorkspaceLock,
} from './workspaceLock.js';
export type { LockMode, LockRequest, LockGrant, LockRejected } from './workspaceLock.js';

// ── WriteGuard ──────────────────────────────────────────────────────
export {
  interceptWrite, isForbiddenKey, isEligibleForLongTerm,
} from './writeGuard.js';

// ── GlobalWorkspace ─────────────────────────────────────────────────
export {
  write, read, discardEntry, getByTrace,
  getEntryCount, getKeyCount, resetGlobalWorkspace,
} from './globalWorkspace.js';

// ── LongTermMemory ──────────────────────────────────────────────────
export {
  writeMemory, searchMemory, getMemory,
  deprecateMemory, contradictMemory, getMemoryCount,
  resetLongTermMemory,
} from './longTermMemory.js';
export type { LongTermMemoryEntry, MemoryCategory, MemoryStatus } from './longTermMemory.js';

// ── MemoryConsolidator ──────────────────────────────────────────────
export {
  consolidateFromTrace, resetMemoryConsolidator,
} from './memoryConsolidator.js';
