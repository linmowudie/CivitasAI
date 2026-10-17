/**
 * @module Arbitration/arbitrationWiring
 * @description
 * 仲裁事件接线（FE-062 实装）——把 GlobalWorkspace 语义冲突（`CONFLICT_DETECTED`）
 * 自动升级为仲裁六步闭环（此前 `executeFullArbitration` 0 生产调用，案件只能展示不能裁决）。
 *
 * 链路（闭环全貌）：
 *   GW 写入语义冲突 → 阻止写入 + `CONFLICT_DETECTED`
 *   → 本接线：立案 → 胶囊 → 裁决 → 停职 → 恢复 → 沉淀（executeFullArbitration）
 *   → 裁决 `new_wins` 时**应用裁决**：废弃冲突旧条目 + 以仲裁者身份落定新内容。
 *
 * 设计边界：
 *  - 仅处理 GlobalWorkspace 语义冲突（payload 含 newContent/existingContent）；
 *    文件冲突（conflictPrecheck 来源）无记忆原文，不自动仲裁（交合并流程处理）；
 *  - 同 key 冲突去重（conflictId = `gw:<key>`，未结案不重复立案）；
 *  - 全链 fail-soft（订阅回调异常不传播）。
 */

import type { Subscription } from "../EventBus/eventTypes.js";
import { EventType } from "../EventBus/eventTypes.js";
import { subscribe } from "../EventBus/eventBus.js";
import { logger } from "../../Infra/Logging/logger.js";
import {
  getEntryById,
  discardEntry,
  write as writeWorkspace,
} from "../SharedMemory/globalWorkspace.js";
import {
  executeFullArbitration,
  getCaseByConflictId,
  settleStaleCases,
} from "./tribunal.js";

let subscription: Subscription | null = null;
/** 兜底清扫定时器（不干等：超时未裁的案件由清扫器保守结案） */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** 兜底参数：自立案起 120s 未裁定 ⇒ 保守默认结案；每 30s 清扫一次 */
export const STALE_CASE_DEADLINE_MS = 120_000;
export const STALE_CASE_SWEEP_INTERVAL_MS = 30_000;

/**
 * 注册 `CONFLICT_DETECTED` → 仲裁六步闭环接线（幂等；main.ts 启动时调用）。
 */
export function initArbitrationWiring(): void {
  if (subscription) return;

  subscription = subscribe(EventType.CONFLICT_DETECTED, (event) => {
    try {
      const p = event.payload;
      const key = typeof p["key"] === "string" ? p["key"] : undefined;
      const newContent =
        typeof p["newContent"] === "string" ? p["newContent"] : undefined;
      const existingContent =
        typeof p["existingContent"] === "string"
          ? p["existingContent"]
          : undefined;

      // 仅处理 GlobalWorkspace 语义冲突（文件冲突等其他来源不自动仲裁）
      if (!key || !newContent || !existingContent) return;

      const conflictId = `gw:${key}`;
      const existingCase = getCaseByConflictId(conflictId);
      if (existingCase && existingCase.status !== "completed") {
        logger.debug("语义冲突已有进行中案件，跳过自动立案", {
          source: "Arbitration/arbitrationWiring",
          conflictId,
          caseId: existingCase.caseId,
        });
        return;
      }

      // 解析双方归属：newEntryId 形如 'pending:<agentId>'；existing 从条目查
      const newEntryId =
        typeof p["newEntryId"] === "string" ? p["newEntryId"] : "";
      const plaintiffAgentId = newEntryId.startsWith("pending:")
        ? newEntryId.slice("pending:".length)
        : "agent-writer-unknown";
      const existingEntryId =
        typeof p["existingEntryId"] === "string"
          ? p["existingEntryId"]
          : undefined;
      const existingEntry = existingEntryId
        ? getEntryById(existingEntryId)
        : undefined;
      const defendantAgentId = existingEntry?.agentId ?? "agent-writer-unknown";

      const traceId =
        (typeof p["traceId"] === "string" ? p["traceId"] : undefined) ??
        event.traceId ??
        `trace-arb-auto-${Date.now()}`;

      // 六步闭环
      const result = executeFullArbitration({
        conflictId,
        traceId,
        conflictType: "semantic_opposition",
        plaintiffAgentId,
        defendantAgentId,
        newMemoryContent: newContent,
        oldMemoryContent: existingContent,
        taskDescription: `GlobalWorkspace 键「${key}」的语义冲突自动仲裁（${String(p["reason"] ?? "冲突检测")}）`,
        restorerAgentId: plaintiffAgentId,
      });

      if (!result.ok) {
        logger.warn("语义冲突自动仲裁失败", {
          source: "Arbitration/arbitrationWiring",
          conflictId,
          error: result.error,
        });
        return;
      }

      logger.info("语义冲突已自动仲裁", {
        source: "Arbitration/arbitrationWiring",
        conflictId,
        caseId: result.value.caseId,
        status: result.value.status,
        verdict: result.value.finalVerdict?.verdict,
      });

      // 裁决应用（闭环最后一环）：new_wins → 废弃冲突旧条目 + 以仲裁者身份落定新内容
      if (result.value.finalVerdict?.verdict === "new_wins") {
        if (existingEntry) {
          discardEntry(existingEntry.entryId, "arbitrator");
        }
        const applied = writeWorkspace({
          key,
          content: newContent,
          contentType: "fact",
          assertion: "observed",
          traceId,
          agentId: "arbitrator:tribunal",
          actorRole: "arbitrator",
        });
        if (applied.ok) {
          logger.info("仲裁裁决已应用（冲突键落定新内容）", {
            source: "Arbitration/arbitrationWiring",
            key,
            caseId: result.value.caseId,
          });
        } else {
          logger.warn("仲裁裁决应用失败（新内容未落定）", {
            source: "Arbitration/arbitrationWiring",
            key,
            error: applied.error,
          });
        }
      }
    } catch (e) {
      logger.warn("仲裁接线处理异常（已忽略）", {
        source: "Arbitration/arbitrationWiring",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  logger.info("仲裁事件接线已注册（CONFLICT_DETECTED → 六步闭环）", {
    source: "Arbitration/arbitrationWiring",
  });

  // 超时兜底清扫：subscribes 之外的兜底通道，保证"裁决不会一直不裁定"
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      try {
        const r = settleStaleCases({ deadlineMs: STALE_CASE_DEADLINE_MS });
        if (r.ok && r.value.settled.length > 0) {
          logger.warn("裁决超时兜底：已按保守默认结案", {
            source: "Arbitration/arbitrationWiring",
            settled: r.value.settled,
            verdict: "old_wins",
            deadlineMs: r.value.deadlineMs,
          });
        }
      } catch (e) {
        // 理由（fail-soft 清理）：兜底清扫失败不应影响业务链路，下一轮继续尝试
        logger.warn("裁决超时兜底清扫异常（忽略，下一轮重试）", {
          source: "Arbitration/arbitrationWiring",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }, STALE_CASE_SWEEP_INTERVAL_MS);
    // 不阻塞进程退出（测试/CLI 场景）
    if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  }
}

/** 注销接线（shutdown / 测试对称调用） */
export function stopArbitrationWiring(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  subscription?.unsubscribe();
  subscription = null;
}
