/**
 * @module Audit/freezeManager
 * @description
 * 冻结管理器——Docs/Agent/06 §2.4。
 * 对异常 Agent 执行钱包冻结/解冻。
 * 冻结通过 TokenEconomy 执行，WALLET_FROZEN 由 TokenEconomy 发布。
 */

import { EventType } from "../EventBus/eventTypes.js";
import { createEvent, publish } from "../EventBus/eventBus.js";
import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";
import { requireGovernanceRole } from "../Governance/governanceGuard.js";
import { freezeWallet, unfreezeWallet } from "../TokenEconomy/walletManager.js";
import { getMainDb } from "../../Infra/Db/database.js";
import { getActiveOwner } from "../AccountScope/activeAccount.js";
import { logger } from "../../Infra/Logging/logger.js";

// ── 冻结记录 ────────────────────────────────────────────────────────

export interface FreezeRecord {
  freezeId: string;
  agentId: string;
  reason: string;
  /** 执行冻结的治理角色（落库留痕；自动到期解冻时为 'auto'） */
  actorRole?: string;
  frozenAt: number;
  autoUnfreezeAt?: number;
  unfrozenAt?: number;
  unfrozenBy?: string;
  status: "frozen" | "unfrozen" | "expired";
}

// ── 内部状态 ────────────────────────────────────────────────────────

const freezeRecords: Map<string, FreezeRecord> = new Map();
const frozenAgents: Set<string> = new Set();
let freezeCounter = 0;
let autoUnfreezeSec = 300; // 默认 5 分钟

// ── 配置 ────────────────────────────────────────────────────────────

export function setAutoUnfreezeSec(sec: number): void {
  autoUnfreezeSec = sec;
}

// ── 持久化（SUP-SEC-FREEZEPERSIST，设计 §3.3）────────────────────────
//
// 背景：冻结状态此前只在进程内 Map 里 —— 重启后 `isFrozen` 全 false，
// 被冻结 Agent 自动恢复行动能力，等同绕过审计执法。
// 现在写穿落库（`agent_freezes`，按属主隔离）；落库失败**不阻断**冻结动作
// （留痕降级不打断治理），但必须告警 —— 否则"冻结了但没落库"会静默发生。

function canPersist(): boolean {
  try {
    getMainDb();
    return true;
  } catch {
    return false;
  }
}

/** 写入/更新一条冻结记录（UPSERT；状态机整体覆盖） */
function persistFreezeRecord(record: FreezeRecord): void {
  if (!canPersist()) return;
  try {
    getMainDb()
      .prepare(
        `
      INSERT OR REPLACE INTO agent_freezes (
        freeze_id, agent_id, reason, actor_role, frozen_at, auto_unfreeze_at,
        unfrozen_at, unfrozen_by, status, owner_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        record.freezeId,
        record.agentId,
        record.reason,
        record.actorRole ?? "unknown",
        record.frozenAt,
        record.autoUnfreezeAt ?? null,
        record.unfrozenAt ?? null,
        record.unfrozenBy ?? null,
        record.status,
        getActiveOwner(),
        Date.now(),
      );
  } catch (e) {
    logger.warn("冻结状态落库失败（内存态仍生效）", {
      source: "freezeManager/persistFreezeRecord",
      freezeId: record.freezeId,
      agentId: record.agentId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * 启动期回灌：把当前属主**仍处于 frozen** 的记录装回内存，恢复 ID 计数器。
 *
 * 设计语义：跨重启存活 = 重启后 `isFrozen(agentId)` 仍为 true。
 * 已到自动解冻时间的记录由 `checkAutoUnfreeze()` 在回灌后立即清理（不漏判）。
 */
export function hydrateFreezeState(): Result<number> {
  if (!canPersist()) return ok(0);
  try {
    const owner = getActiveOwner();
    const rows = getMainDb()
      .prepare(
        `SELECT freeze_id, agent_id, reason, actor_role, frozen_at, auto_unfreeze_at,
              unfrozen_at, unfrozen_by, status
         FROM agent_freezes
        WHERE owner_user_id = ? AND status = 'frozen'
        ORDER BY frozen_at ASC`,
      )
      .all(owner) as Record<string, unknown>[];
    let restored = 0;
    for (const row of rows) {
      const record: FreezeRecord = {
        freezeId: String(row["freeze_id"]),
        agentId: String(row["agent_id"]),
        reason: String(row["reason"]),
        actorRole: String(row["actor_role"] ?? "unknown"),
        frozenAt: Number(row["frozen_at"]),
        ...(row["auto_unfreeze_at"] !== null &&
        row["auto_unfreeze_at"] !== undefined
          ? { autoUnfreezeAt: Number(row["auto_unfreeze_at"]) }
          : {}),
        status: "frozen",
      };
      freezeRecords.set(record.freezeId, record);
      frozenAgents.add(record.agentId);
      restored++;
      const m = /^freeze-(\d+)$/.exec(record.freezeId);
      if (m) freezeCounter = Math.max(freezeCounter, Number(m[1]));
    }
    if (restored > 0) checkAutoUnfreeze();
    return ok(restored);
  } catch (e) {
    logger.warn("冻结状态回灌失败（本次运行无冻结记忆）", {
      source: "freezeManager/hydrateFreezeState",
      error: e instanceof Error ? e.message : String(e),
    });
    return err(
      `冻结状态回灌失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ── 冻结 ────────────────────────────────────────────────────────────

/**
 * 冻结 Agent（**治理动作**：仅 L0 治理角色或人类所有者可执行）。
 *
 * @param actorRole 执行者角色；非治理角色一律拒绝（fail-closed）
 */
export function freezeAgent(
  agentId: string,
  reason: string,
  actorRole: string,
): Result<FreezeRecord> {
  const guard = requireGovernanceRole(actorRole, "冻结 Agent（审计执法）");
  if (!guard.ok) return err(guard.error);

  if (frozenAgents.has(agentId)) {
    return err(`Agent ${agentId} 已被冻结`);
  }

  const now = Date.now();
  const record: FreezeRecord = {
    freezeId: `freeze-${++freezeCounter}`,
    agentId,
    reason,
    actorRole,
    frozenAt: now,
    autoUnfreezeAt: now + autoUnfreezeSec * 1000,
    status: "frozen",
  };

  freezeRecords.set(record.freezeId, record);
  frozenAgents.add(agentId);
  // 落库：跨重启存活（SUP-SEC-FREEZEPERSIST）
  persistFreezeRecord(record);

  // 冻结必须**联动钱包**：否则冻结期 token 仍可扣（矩阵 cell SUP-SEC-FREEZEWALLET 的缺口）。
  // `debit()` 已按 `status !== 'active'` 拒绝扣减，故这里只需把钱包置为 frozen。
  // Agent 可能尚未建钱包（未消耗过 Token）——此时不是错误：没有钱包就没有可扣减的余额。
  freezeWallet(agentId, `审计冻结: ${reason}`, `freeze:${record.freezeId}`);

  // 发布 WALLET_FROZEN 事件（由审计局发起）
  publish(
    createEvent({
      eventType: EventType.WALLET_FROZEN,
      source: "Audit/freezeManager",
      payload: {
        freezeId: record.freezeId,
        agentId,
        reason,
        initiator: "AuditBureau",
        actedByRole: actorRole,
      },
    }),
  );

  return ok(record);
}

// ── 解冻 ────────────────────────────────────────────────────────────

/**
 * 解冻 Agent（**治理动作**：仅 L0 治理角色或人类所有者可执行）。
 *
 * 注意：**系统到期自动解冻**不走此函数（见内部 `applyUnfreeze`）——
 * 自动解冻是"解除限制"的 fail-safe 行为，不是治理裁决。
 */
export function unfreezeAgent(
  agentId: string,
  by: string,
  actorRole: string,
): Result<void> {
  const guard = requireGovernanceRole(actorRole, "解冻 Agent（审计执法）");
  if (!guard.ok) return err(guard.error);
  return applyUnfreeze(agentId, by);
}

/** 内部解冻实现（不做角色校验；仅供治理入口与系统自动到期路径复用） */
function applyUnfreeze(agentId: string, by: string): Result<void> {
  if (!frozenAgents.has(agentId)) {
    return err(`Agent ${agentId} 未被冻结`);
  }

  frozenAgents.delete(agentId);

  // 同步解冻钱包（与 freezeAgent 的联动对称）：否则解冻后钱包仍是 frozen，Agent 永远扣不了费。
  unfreezeWallet(agentId, `unfreeze:${by}`);

  // 更新记录
  for (const record of freezeRecords.values()) {
    if (record.agentId === agentId && record.status === "frozen") {
      record.status = "unfrozen";
      record.unfrozenAt = Date.now();
      record.unfrozenBy = by;
      // 状态落库：重启后不得复活为 frozen
      persistFreezeRecord(record);
    }
  }

  // 发布 WALLET_UNFROZEN 事件
  publish(
    createEvent({
      eventType: EventType.WALLET_UNFROZEN,
      source: "Audit/freezeManager",
      payload: {
        agentId,
        unfrozenBy: by,
      },
    }),
  );

  return ok(undefined);
}

// ── 检查自动解冻 ────────────────────────────────────────────────────

export function checkAutoUnfreeze(): string[] {
  const now = Date.now();
  const expired: string[] = [];

  for (const record of freezeRecords.values()) {
    if (
      record.status === "frozen" &&
      record.autoUnfreezeAt &&
      now >= record.autoUnfreezeAt
    ) {
      record.status = "expired";
      record.unfrozenAt = now;
      record.unfrozenBy = "auto";
      frozenAgents.delete(record.agentId);
      // 自动到期解冻同样必须解冻钱包（fail-safe：解除限制比持续冻结更安全）
      unfreezeWallet(record.agentId, "auto");
      persistFreezeRecord(record);
      expired.push(record.agentId);

      publish(
        createEvent({
          eventType: EventType.WALLET_UNFROZEN,
          source: "Audit/freezeManager",
          payload: {
            agentId: record.agentId,
            unfrozenBy: "auto",
            freezeId: record.freezeId,
          },
        }),
      );
    }
  }

  return expired;
}

// ── 查询 ────────────────────────────────────────────────────────────

export function isFrozen(agentId: string): boolean {
  return frozenAgents.has(agentId);
}

export function getFreezeRecord(agentId: string): FreezeRecord | undefined {
  for (const r of freezeRecords.values()) {
    if (r.agentId === agentId && r.status === "frozen") return { ...r };
  }
  return undefined;
}

export function getAllFrozenAgents(): string[] {
  return [...frozenAgents];
}

export function getFreezeHistory(): FreezeRecord[] {
  return [...freezeRecords.values()].map((r) => ({ ...r }));
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetFreezeManager(): void {
  freezeRecords.clear();
  frozenAgents.clear();
  freezeCounter = 0;
  autoUnfreezeSec = 300;
}
