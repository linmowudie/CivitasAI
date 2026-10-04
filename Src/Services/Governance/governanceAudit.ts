/**
 * @module Governance/governanceAudit
 * @description 治理动作的**统一留痕**（2026-10-04 新增，落地灵感源《一些思考2》§1.2）。
 *
 * 灵感源原文（§1.2 核心设计理念）：
 *  > **全链路可追溯**：所有上下文变更强制携带元数据
 *  > （**全局唯一 ID、时间戳、来源 Agent 标识、任务标识**），确保数据血缘清晰。
 *
 * 落地方式：
 *  - 统一记录类型 `GovernanceRecord`，**四类元数据强制字段**：
 *    `recordId`（全局唯一 ID）、`timestamp`、`actorRole`/`actorId`（来源）、`traceId`/`taskId`（任务标识）；
 *  - 统一事件 `governance:action_recorded` 发布到事件总线（前端/审计台可实时订阅）；
 *  - 内存台账支持查询（`listGovernanceRecords` / `getGovernanceRecord`），后续可落库。
 *
 * 设计要点：
 *  - **放行与拒绝都留痕**（拒绝同样是有价值的治理事实：谁试图越权、被哪条规则拦下）；
 *  - 留痕失败**不得阻断治理动作本身**（借鉴"监管失效不阻断主流程"），但必须打日志。
 */

import { publish } from '../EventBus/eventBus.js';
import { createEvent } from '../EventBus/eventBus.js';
import { EventType } from '../EventBus/eventTypes.js';
import { logger } from '../../Infra/Logging/logger.js';
import { getMainDb } from '../../Infra/Db/database.js';
import { getActiveOwner } from '../AccountScope/activeAccount.js';
import { ok } from '../../Infra/types.js';
import type { Result } from '../../Infra/types.js';

/** 治理动作标识（域.动作） */
export type GovernanceAction =
  | 'approval.decide'
  | 'audit.freeze'
  | 'audit.unfreeze'
  | 'audit.investigate'
  | 'audit.patrol'
  | 'arbitration.verdict'
  | 'arbitration.suspension'
  | 'arbitration.consolidate'
  | 'regulation.intervene'
  | 'regulation.escalate'
  | 'regulation.rule_add'
  | 'regulation.rule_remove'
  | 'regulation.broadcast'
  | string;

/** 治理记录（四类元数据为强制字段，见 §1.2） */
export interface GovernanceRecord {
  /** ① 全局唯一 ID */
  readonly recordId: string;
  /** ② 时间戳 */
  readonly timestamp: number;
  /** ③ 来源 Agent / 角色 */
  readonly actorRole: string;
  readonly actorId: string;
  /** ④ 任务标识 */
  readonly traceId: string | null;
  readonly taskId: string | null;
  /** 动作与结果 */
  readonly action: GovernanceAction;
  readonly outcome: 'allowed' | 'denied' | 'failed';
  readonly reason?: string;
  readonly targetIds?: readonly string[];
}

export interface RecordGovernanceInput {
  action: GovernanceAction;
  actorRole: string;
  actorId?: string;
  traceId?: string;
  taskId?: string;
  outcome?: GovernanceRecord['outcome'];
  reason?: string;
  targetIds?: readonly string[];
}

const ledger: GovernanceRecord[] = [];
let recordCounter = 0;

/**
 * 内存台账条目的属主（FE-044，2026-10-04）。
 *
 * 背景：落库链路按 `owner_user_id` 隔离，但内存台账此前是"机器级"数组——
 * 切换账号后新账号能从内存视图里看到上一个账号的治理记录（与持久化视图不一致）。
 * 现每条内存记录登记属主，查询一律按 `getActiveOwner()` 过滤，
 * 与数据库视图口径对齐（两处一致才算真隔离）。
 */
const recordOwners: Map<string, string> = new Map();

/** 台账上限（防止长跑内存膨胀；超出丢弃最旧） */
export const MAX_GOVERNANCE_RECORDS = 2000;

// ── 持久化（2026-10-04，G-10 后续）──────────────────────────────────
//
// 此前台账仅存进程内数组 ⇒ 重启即丢，无法满足灵感源 §1.2「全链路可追溯」。
// 现写穿落库（含属主，跨账号隔离）；落库失败**不阻断**治理动作（留痕降级不打断治理），但打日志。

function canPersist(): boolean {
  try {
    getMainDb();
    return true;
  } catch {
    return false;
  }
}

/** 写穿一条记录到 `governance_records`（含属主） */
function persistRecord(record: GovernanceRecord, owner: string): void {
  if (!canPersist()) return;
  try {
    getMainDb().prepare(`
      INSERT OR REPLACE INTO governance_records (
        record_id, timestamp, actor_role, actor_id, trace_id, task_id,
        action, outcome, reason, target_ids_json, owner_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.recordId, record.timestamp, record.actorRole, record.actorId,
      record.traceId, record.taskId, record.action, record.outcome,
      record.reason ?? null,
      record.targetIds ? JSON.stringify(record.targetIds) : null,
      owner, Date.now(),
    );
  } catch (e) {
    logger.warn('治理留痕落库失败（内存台账仍生效）', {
      source: 'governanceAudit/persistRecord',
      recordId: record.recordId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 行 → 记录 */
function rowToRecord(row: Record<string, unknown>): GovernanceRecord {
  const targets = row['target_ids_json'] ? JSON.parse(row['target_ids_json'] as string) : undefined;
  return {
    recordId: String(row['record_id']),
    timestamp: Number(row['timestamp']),
    actorRole: String(row['actor_role']),
    actorId: String(row['actor_id']),
    traceId: (row['trace_id'] as string | null) ?? null,
    taskId: (row['task_id'] as string | null) ?? null,
    action: String(row['action']),
    outcome: row['outcome'] as GovernanceRecord['outcome'],
    ...(row['reason'] ? { reason: String(row['reason']) } : {}),
    ...(targets ? { targetIds: targets as readonly string[] } : {}),
  };
}

/** 从库中按属主加载记录（不改变内存状态） */
export function loadPersistedGovernanceRecords(owner: string = getActiveOwner()): GovernanceRecord[] {
  if (!canPersist()) return [];
  try {
    const rows = getMainDb().prepare(
      'SELECT * FROM governance_records WHERE owner_user_id = ? ORDER BY timestamp ASC',
    ).all(owner) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  } catch (e) {
    logger.warn('治理台账读取失败（降级为内存视图）', {
      source: 'governanceAudit/loadPersistedGovernanceRecords',
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/** 启动期回灌：把当前属主的持久化记录装回内存台账 */
export function hydrateGovernanceLedger(): Result<number> {
  const owner = getActiveOwner();
  const persisted = loadPersistedGovernanceRecords(owner);
  const known = new Set(ledger.map(r => r.recordId));
  for (const rec of persisted) {
    if (!known.has(rec.recordId)) {
      ledger.push(rec);
      recordOwners.set(rec.recordId, owner);
    }
  }
  // 恢复计数器（`gov-<ts36>-<n>`）
  for (const r of persisted) {
    const m = /^gov-[^-]+-(\d+)$/.exec(r.recordId);
    if (m) recordCounter = Math.max(recordCounter, Number(m[1]));
  }
  return ok(persisted.length);
}

/**
 * 记录一次治理动作（放行 / 拒绝 / 失败）。
 *
 * @returns 产生的记录；即使发布事件失败也会返回记录（留痕不阻断治理动作）
 */
export function recordGovernanceAction(input: RecordGovernanceInput): GovernanceRecord {
  const record: GovernanceRecord = {
    recordId: `gov-${Date.now().toString(36)}-${++recordCounter}`,
    timestamp: Date.now(),
    actorRole: input.actorRole,
    actorId: input.actorId ?? `governance:${input.actorRole}`,
    traceId: input.traceId ?? null,
    taskId: input.taskId ?? null,
    action: input.action,
    outcome: input.outcome ?? 'allowed',
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.targetIds !== undefined ? { targetIds: input.targetIds } : {}),
  };

  ledger.push(record);
  if (ledger.length > MAX_GOVERNANCE_RECORDS) {
    const dropped = ledger.splice(0, ledger.length - MAX_GOVERNANCE_RECORDS);
    for (const d of dropped) recordOwners.delete(d.recordId);
  }
  const owner = getActiveOwner();
  recordOwners.set(record.recordId, owner);
  persistRecord(record, owner);

  try {
    publish(createEvent({
      eventType: EventType.GOVERNANCE_ACTION_RECORDED,
      source: 'Governance/governanceAudit',
      payload: {
        // §1.2 四类元数据
        recordId: record.recordId,
        timestamp: record.timestamp,
        actorRole: record.actorRole,
        actorId: record.actorId,
        traceId: record.traceId,
        taskId: record.taskId,
        // 动作语义
        action: record.action,
        outcome: record.outcome,
        reason: record.reason,
        targetIds: record.targetIds,
      },
    }));
  } catch (e) {
    logger.warn('治理留痕事件发布失败（治理动作本身不受影响）', {
      source: 'governanceAudit/recordGovernanceAction',
      recordId: record.recordId,
      action: record.action,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return record;
}

/** 查询台账（可按动作、角色、结果过滤；仅返回当前属主的记录） */
export function listGovernanceRecords(filter: {
  action?: string;
  actorRole?: string;
  outcome?: GovernanceRecord['outcome'];
  limit?: number;
} = {}): GovernanceRecord[] {
  // ★ 合并持久化记录（按属主）：重启后仍可查询历史（灵感源 §1.2 全链路可追溯）
  // ★ FE-044：内存台账同样按属主过滤（此前内存视图跨账号可见，与落库视图不一致）
  const owner = getActiveOwner();
  const seen = new Set<string>();
  let out = ledger.filter(r => {
    if (recordOwners.get(r.recordId) !== owner) return false;
    seen.add(r.recordId);
    return true;
  });
  for (const persisted of loadPersistedGovernanceRecords(owner)) {
    if (!seen.has(persisted.recordId)) out.push(persisted);
  }
  if (filter.action) out = out.filter(r => r.action === filter.action);
  if (filter.actorRole) out = out.filter(r => r.actorRole === filter.actorRole);
  if (filter.outcome) out = out.filter(r => r.outcome === filter.outcome);
  if (filter.limit !== undefined) out = out.slice(-filter.limit);
  return out;
}

/** 按 recordId 取单条（仅当前属主可见） */
export function getGovernanceRecord(recordId: string): GovernanceRecord | undefined {
  const rec = ledger.find(r => r.recordId === recordId);
  if (!rec) return undefined;
  return recordOwners.get(rec.recordId) === getActiveOwner() ? rec : undefined;
}

/** 台账规模（诊断） */
export function governanceRecordCount(): number {
  return ledger.length;
}

/** 清空台账（测试用） */
export function resetGovernanceLedger(): void {
  ledger.length = 0;
  recordCounter = 0;
  recordOwners.clear();
}
