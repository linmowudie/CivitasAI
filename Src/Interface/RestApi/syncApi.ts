/**
 * @module Interface/RestApi/syncApi
 * @description
 * 供「账号同步」使用的本地端点（2026-10-02）。
 *
 * `GET /api/sync/stats-events` —— 从**本地库派生**个人统计事件，
 * 客户端拿到后直接 `POST /v1/stats/events` 上行。三项指标：
 *
 * | kind | 来源 | 幂等键 | 口径 |
 * |---|---|---|---|
 * | `chat.turn` | `chat_messages`（role=assistant） | `msg:<message_id>` | 每次助手回复算一轮，value=1 |
 * | `token.consumed` | `token_transactions` | `tx:<transaction_id>` | value=交易金额（Token 数） |
 * | `tool.call` | `ai_events`（全部工具调用）+ `effect_journal`（配对保留历史键） | `eff:<effect_id>` 或 `tool:<event_id>` | 覆盖**全部**工具调用（含安全只读工具），配对后不重复计数 |
 *
 * 说明（FE-027 已修复）：`tool.call` 现覆盖全部工具调用。幂等键策略——
 * 若一次调用同时存在于工具事件与副作用日志，沿用历史键 `eff:<effect_id>`（不新增键 → 全量重传也不会重复计数）；
 * 仅当没有对应副作用记录时才使用新键 `tool:<event_id>`。
 */

import { json, registerRoute } from './router.js';
import { getActiveOwner } from '../../Services/AccountScope/activeAccount.js';
import { getDatabases, isDatabaseInitialized } from '../../Infra/Db/database.js';
import { logger } from '../../Infra/Logging/logger.js';

export interface DerivedStatEvent {
  kind: string;
  value: number;
  /** epoch ms */
  occurredAt: number;
  /** 幂等键（服务端按 (user_id, clientEventId) 去重） */
  clientEventId: string;
  meta?: Record<string, unknown>;
}

export interface DerivedStatsResult {
  events: DerivedStatEvent[];
  counts: { chatTurn: number; tokenConsumed: number; toolCall: number };
  /** 本次查询使用的起点（epoch ms） */
  since: number;
  /** 建议的下一页起点（= 本批最大 occurredAt），无数据时等于 since */
  nextSince: number;
  /** 是否因为 limit 截断 */
  truncated: boolean;
}

const DEFAULT_SINCE = 0;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
/** 工具事件与副作用记录的时间近似配对窗口（旧数据无 tool_call_id 时的兜底） */
const PAIRING_WINDOW_MS = 180_000;
/** 读取 effect 时的回看余量（effect 可能早于 since 开始、在窗口内完成） */
const PAIRING_LOOKBACK_MS = 300_000;

/**
 * 派生统计事件（纯函数式：只读库，不做写入）。
 *
 * @param since 只取 occurredAt > since 的记录
 * @param limit 单次最多返回条数（超出时 truncated=true，客户端可带 nextSince 继续）
 * @param now   注入当前时间（测试用）
 */
export function deriveStatsEvents(
  since: number = DEFAULT_SINCE,
  limit: number = DEFAULT_LIMIT,
  now: number = Date.now(),
): DerivedStatsResult {
  const events: DerivedStatEvent[] = [];
  const counts = { chatTurn: 0, tokenConsumed: 0, toolCall: 0 };
  // 统计**只覆盖当前账号的数据**（否则同机换账号后，B 会把 A 的轮次/用量算进自己的统计）
  const owner = getActiveOwner();

  if (!isDatabaseInitialized()) {
    return { events, counts, since, nextSince: since, truncated: false };
  }

  let main: import('better-sqlite3').Database;
  try {
    main = getDatabases().main;
    if (!main) return { events, counts, since, nextSince: since, truncated: false };
  } catch {
    return { events, counts, since, nextSince: since, truncated: false };
  }

  /** 宽松解析事件 payload（损坏数据回退为空对象） */
  const safeParseObject = (raw: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const safeAll = <T>(sql: string, params: unknown[]): T[] => {
    try {
      return main.prepare(sql).all(...params) as T[];
    } catch (e) {
      // 表可能不存在（未迁移）——按空结果处理；但**必须留日志**：
      // 静默吞错曾掩盖了一次 schema 变更失败（统计会"静默变空"，很难发现）。
      logger.warn('统计派生查询失败（按空结果处理）', {
        source: 'syncApi',
        sql: sql.trim().split('\n')[0],
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  };

  // 每个来源多取 1 条：只有这样才能判断"是否还有更多"（若各源都正好取满 limit，
  // 合并后再比较长度会漏判截断）
  const perSourceLimit = limit + 1;

  // ① 会话轮次：助手消息（**只统计当前账号**，否则 B 会把 A 的轮次算进自己的统计）
  const messageRows = safeAll<{ message_id: string; created_at: number; model: string | null }>(
    `SELECT message_id, created_at, model FROM chat_messages
     WHERE role = 'assistant' AND owner_user_id = ? AND created_at > ? AND created_at <= ?
     ORDER BY created_at ASC LIMIT ?`,
    [owner, since, now, perSourceLimit],
  );
  for (const row of messageRows) {
    events.push({
      kind: 'chat.turn',
      value: 1,
      occurredAt: row.created_at,
      clientEventId: `msg:${row.message_id}`,
      ...(row.model ? { meta: { model: row.model } } : {}),
    });
    counts.chatTurn++;
  }

  // ② Token 消耗：交易流水（按属主）
  const txRows = safeAll<{ transaction_id: string; amount: number; created_at: number; type: string }>(
    `SELECT transaction_id, amount, created_at, type FROM token_transactions
     WHERE owner_user_id = ? AND created_at > ? AND created_at <= ?
     ORDER BY created_at ASC LIMIT ?`,
    [owner, since, now, perSourceLimit],
  );
  for (const row of txRows) {
    events.push({
      kind: 'token.consumed',
      value: Math.abs(Number(row.amount) || 0),
      occurredAt: row.created_at,
      clientEventId: `tx:${row.transaction_id}`,
      meta: { type: row.type },
    });
    counts.tokenConsumed++;
  }

  // ③ 工具调用（FE-027：覆盖**全部**工具调用，且不重复计数）
  //
  //  数据源 A：`ai_events` 的 `agent:tool_call_result` —— 每次工具调用一条，
  //            包含安全只读工具（dir.list/file.read/…），修复了此前"只统计副作用日志"的口径缺口。
  //  数据源 B：`effect_journal` —— 危险/非幂等工具的副作用记录（历史上已按 `eff:<effect_id>` 同步过）。
  //
  //  幂等键稳定性：**绝不新增键**。若一次调用同时存在于两个来源，则优先沿用历史键 `eff:<effect_id>`
  //  （精确配对靠 effect 行的 `tool_call_id`，旧数据退化为"时间近似配对"）；
  //  只有"没有对应 effect 的调用"才使用新键 `tool:<event_id>`。
  //  这样即使客户端重置水位、全量重传，也不会把同一次调用算两次。
  const effectWindowStart = Math.max(0, since - PAIRING_LOOKBACK_MS);
  const effectRows = safeAll<{
    effect_id: string; kind: string; started_at: number; status: string; iteration: number; tool_call_id: string | null;
  }>(
    `SELECT effect_id, kind, started_at, status, iteration, tool_call_id FROM effect_journal
     WHERE owner_user_id = ? AND started_at > ? AND started_at <= ?
     ORDER BY started_at ASC LIMIT ?`,
    [owner, effectWindowStart, now, perSourceLimit],
  );
  const toolEventRows = safeAll<{ event_id: string; ts: number; data_json: string }>(
    `SELECT event_id, ts, data_json FROM ai_events
     WHERE owner_user_id = ? AND type = 'agent:tool_call_result' AND ts > ? AND ts <= ?
     ORDER BY ts ASC LIMIT ?`,
    [owner, since, now, perSourceLimit],
  );

  /** 已被工具事件认领的 effect（避免同一 effect 既发 eff: 又发 tool:） */
  const claimedEffects = new Set<string>();
  /** 已被认领的 effect 匹配键（toolCallId） */
  const claimedToolCallIds = new Set<string>();

  // ① 先处理工具事件：能配到 effect 的沿用 `eff:`，否则用 `tool:`
  for (const row of toolEventRows) {
    const payload = safeParseObject(row.data_json);
    const toolCallId = typeof payload['toolCallId'] === 'string' ? payload['toolCallId'] : '';
    const toolName = typeof payload['toolName'] === 'string' ? payload['toolName'] : '';
    const status = typeof payload['status'] === 'string' ? payload['status'] : '';

    // 精确配对（tool_call_id）优先
    let matched = toolCallId
      ? effectRows.find((e) => e.tool_call_id === toolCallId && !claimedEffects.has(e.effect_id))
      : undefined;
    // 旧数据（无 tool_call_id）退化为时间近似配对：取时间最近且未被认领的 effect
    if (!matched) {
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const e of effectRows) {
        if (claimedEffects.has(e.effect_id)) continue;
        const delta = Math.abs(e.started_at - row.ts);
        if (delta <= PAIRING_WINDOW_MS && delta < bestDelta) {
          bestDelta = delta;
          matched = e;
        }
      }
    }

    if (matched) {
      claimedEffects.add(matched.effect_id);
      if (matched.tool_call_id) claimedToolCallIds.add(matched.tool_call_id);
      events.push({
        kind: 'tool.call',
        value: 1,
        occurredAt: row.ts,
        clientEventId: `eff:${matched.effect_id}`,
        meta: { toolName, status, source: 'effect+event' },
      });
    } else {
      events.push({
        kind: 'tool.call',
        value: 1,
        occurredAt: row.ts,
        clientEventId: `tool:${row.event_id}`,
        meta: { toolName, status, source: 'event' },
      });
    }
    counts.toolCall++;
  }

  // ② 未被事件覆盖的 effect（事件持久化之前的旧数据 / 事件缺失）仍按历史键上报
  for (const row of effectRows) {
    if (claimedEffects.has(row.effect_id)) continue;
    // 已被某个 toolCallId 认领（同一调用的事件已上报）→ 跳过，避免重复
    if (row.tool_call_id && claimedToolCallIds.has(row.tool_call_id)) continue;
    events.push({
      kind: 'tool.call',
      value: 1,
      occurredAt: row.started_at,
      clientEventId: `eff:${row.effect_id}`,
      meta: { effectKind: row.kind, status: row.status, source: 'effect' },
    });
    counts.toolCall++;
  }

  // 全局排序（三类合并后按时间升序），并按 limit 截断
  events.sort((a, b) => a.occurredAt - b.occurredAt || a.clientEventId.localeCompare(b.clientEventId));
  const truncated = events.length > limit;
  const sliced = truncated ? events.slice(0, limit) : events;
  const nextSince = sliced.length > 0 ? sliced[sliced.length - 1]!.occurredAt : since;

  return {
    events: sliced,
    counts: {
      chatTurn: sliced.filter((e) => e.kind === 'chat.turn').length,
      tokenConsumed: sliced.filter((e) => e.kind === 'token.consumed').length,
      toolCall: sliced.filter((e) => e.kind === 'tool.call').length,
    },
    since,
    nextSince,
    truncated,
  };
}

/** 注册同步相关本地路由 */
export function registerSyncRoutes(): void {
  registerRoute('GET', '/api/sync/stats-events', async (req) => {
    const since = Number(req.query['since'] ?? DEFAULT_SINCE) || 0;
    const limit = Math.min(Number(req.query['limit'] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
    return json(deriveStatsEvents(since, limit));
  });
}
