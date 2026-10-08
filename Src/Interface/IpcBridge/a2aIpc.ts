/**
 * @module Interface/IpcBridge/a2aIpc
 * @description A2A **同步编排的主进程侧**（P0c）—— 设计 §15.3。
 *
 * 只暴露"本地 ↔ 客户端"三件事，**不做任何网络调用**（网络在渲染进程的 `a2aSync`）：
 *  - `a2a:sync-list`  → 待上行消息（`synced_at IS NULL`）
 *  - `a2a:sync-mark`  → 标记已上行（幂等重试安全）
 *  - `a2a:sync-apply` → 应用拉回消息（**本机优先**，已有则跳过）
 *  - `a2a:sync-stats` → 未上行计数（诊断）
 *
 * 注册方式：`ipcBridge.registerIpcHandlers` 内调用 `registerA2ASyncIpc(ipcMain)`。
 */

import { logger } from '../../Infra/Logging/logger.js';
import {
  applyPulledMessages, countUnsyncedMessages, listUnsyncedMessages, markMessagesSynced,
} from '../../Services/A2A/a2aStore.js';

/** 供 IPC 传输的最小行形状（避免把内部字段全抛到渲染进程） */
function toIpcRow(row: ReturnType<typeof listUnsyncedMessages>[number]) {
  return {
    messageId: row.envelope.messageId,
    taskId: row.envelope.taskId,
    traceId: row.envelope.traceId,
    kind: row.envelope.kind,
    sourceAgentId: row.envelope.sourceAgentId,
    targetAgentId: row.envelope.targetAgentId,
    parentMessageId: row.envelope.parentMessageId ?? null,
    correlationId: row.envelope.correlationId ?? null,
    visibility: row.envelope.visibility,
    contentHash: row.envelope.contentHash,
    prevHash: row.envelope.prevHash ?? null,
    payload: row.envelope.payload,
    summary: row.summary ?? row.envelope.summary ?? null,
    verdict: row.verdict,
    priority: row.envelope.priority,
    memoryRefs: row.envelope.memoryRefs ?? [],
    createdAt: row.createdAt,
  };
}

export function registerA2ASyncIpc(ipcMain: {
  handle: (channel: string, listener: (...args: unknown[]) => unknown) => void;
}): void {
  try {
    ipcMain.handle('a2a:sync-list', (_e: unknown, rawLimit?: unknown) => {
      const limit = typeof rawLimit === 'number' ? rawLimit : 200;
      return listUnsyncedMessages(limit).map(toIpcRow);
    });

    ipcMain.handle('a2a:sync-mark', (_e: unknown, rawIds?: unknown) => {
      const ids = Array.isArray(rawIds) ? rawIds.filter((x): x is string => typeof x === 'string') : [];
      return { marked: markMessagesSynced(ids) };
    });

    ipcMain.handle('a2a:sync-apply', (_e: unknown, rawItems?: unknown) => {
      const items = Array.isArray(rawItems) ? rawItems : [];
      const normalized = items
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
        .map(x => ({
          messageId: String(x['messageId'] ?? ''),
          taskId: String(x['taskId'] ?? ''),
          kind: String(x['kind'] ?? 'notify'),
          sourceAgentId: String(x['sourceAgentId'] ?? ''),
          targetAgentId: String(x['targetAgentId'] ?? ''),
          visibility: String(x['visibility'] ?? 'domain'),
          contentHash: String(x['contentHash'] ?? ''),
          prevHash: x['prevHash'] === null || x['prevHash'] === undefined ? null : String(x['prevHash']),
          payload: x['payload'] ?? {},
          verdict: String(x['verdict'] ?? 'allow'),
          summary: x['summary'] === undefined || x['summary'] === null ? null : String(x['summary']),
          createdAt: Number(x['createdAt'] ?? 0),
        }))
        .filter(x => x.messageId && x.taskId);
      return applyPulledMessages(normalized);
    });

    ipcMain.handle('a2a:sync-stats', () => ({ unsynced: countUnsyncedMessages() }));
  } catch (e) {
    // fail-safe：IPC 注册失败不得影响启动（与 ipcBridge 其余处理一致）
    logger.warn(`[A2A] 同步 IPC 注册失败：${String(e)}`, { source: 'a2aIpc' });
  }
}
