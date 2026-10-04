/**
 * @module Interface/EventStore/aiEventStore
 * @description
 * **AI 组件事件的持久化**（重启后重建组件族）。
 *
 * 背景：AI 组件族（`Client/src/ai-components`）是**事件驱动**的 —— 每个组件按
 * `eventTypes` 注册、payload 来自事件。此前事件只存在于内存总线，
 * 重启后组件全部消失（用户报的现象："对话内除对话内容，工具、思考等等组件都没有被重建"）。
 *
 * 做法：把**会话内与组件相关的事件**写入 `ai_events` 表（迁移 v23），
 * 前端在打开会话时按序回放，组件即按当时的 payload 重建。
 *
 * 为何过滤：`agent:stream_chunk` 是逐 token 增量（高频、体积大），
 * 且其最终文本已由 `chat_messages.content` 持久化，故不落库。
 */

import { getMainDb, isDatabaseInitialized } from '../../Infra/Db/database.js';
import { logger } from '../../Infra/Logging/logger.js';
import { EventType, type DomainEvent } from '../../Services/EventBus/eventTypes.js';
import { subscribeMany } from '../../Services/EventBus/eventBus.js';
import { getActiveOwner } from '../../Services/AccountScope/activeAccount.js';

/** 不落库的高频事件（逐 token 增量） */
const SKIP_TYPES = new Set(['agent:stream_chunk']);

/** 需要持久化的事件类型（组件族相关；前缀匹配见 matches） */
const PERSIST_PREFIXES = [
  'agent:', 'task:', 'tool:', 'approval:', 'memory:', 'middleware:', 'hook:',
  'delegation:', 'arbitration:', 'token:', 'chat:',
];

export interface PersistedAiEvent {
  event_id: string;
  session_id: string | null;
  owner_user_id: string;
  type: string;
  data_json: string;
  ts: number;
  seq: number | null;
}

/** 该事件是否需要持久化（供组件重建） */
export function shouldPersist(type: string): boolean {
  if (SKIP_TYPES.has(type)) return false;
  return PERSIST_PREFIXES.some((p) => type.startsWith(p));
}

/**
 * 最近一次已知的会话 ID（兜底用）。
 *
 * 部分事件（如 `agent:iteration_complete`、`agent:stream_end`）的 payload 不带会话字段，
 * 若不兜底就会以 `session_id = NULL` 落库，导致"按会话回放"取不到它们
 * （这些恰恰是重建工具卡/迭代轮次的关键事件）。
 */
let lastKnownSessionId: string | null = null;

/** 会话 ID 的候选字段（不同事件把会话放在不同位置） */
function sessionIdOf(event: DomainEvent): string | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  for (const key of ['sessionId', 'session_id', 'chatSessionId']) {
    const v = payload[key];
    if (typeof v === 'string' && v.length > 0) {
      lastKnownSessionId = v;
      return v;
    }
  }
  // 嵌套（部分事件把上下文放在 data/context 里）
  for (const nested of ['data', 'context', 'meta']) {
    const sub = payload[nested];
    if (sub && typeof sub === 'object') {
      const v = (sub as Record<string, unknown>)['sessionId'];
      if (typeof v === 'string' && v.length > 0) {
        lastKnownSessionId = v;
        return v;
      }
    }
  }
  return lastKnownSessionId;
}

let seqCounter = 0;

/**
 * 持久化一条事件（失败只告警：事件落库不应影响主流程）。
 *
 * @param ownerOverride 显式属主（一般不用；默认取当前账号作用域）
 */
export function persistAiEvent(event: DomainEvent, ownerOverride?: string): void {
  if (!isDatabaseInitialized()) return;
  if (!shouldPersist(event.eventType)) return;

  try {
    const db = getMainDb();
    const payload = event.payload ?? {};
    db.prepare(
      `INSERT OR REPLACE INTO ai_events (event_id, session_id, owner_user_id, type, data_json, ts, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.eventId,
      sessionIdOf(event),
      ownerOverride ?? getActiveOwner(),
      event.eventType,
      JSON.stringify(payload),
      event.timestamp ?? Date.now(),
      ++seqCounter,
    );
  } catch (e) {
    logger.warn('AI 组件事件落库失败（不影响运行）', {
      source: 'aiEventStore',
      type: event.eventType,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 读取某会话（当前属主）的事件流，供前端回放重建组件 */
export function listAiEvents(sessionId: string, options: { sinceTs?: number; limit?: number } = {}): PersistedAiEvent[] {
  if (!isDatabaseInitialized()) return [];
  const limit = Math.min(Math.max(options.limit ?? 2000, 1), 5000);
  try {
    const db = getMainDb();
    return db.prepare(
      `SELECT * FROM ai_events
       WHERE owner_user_id = ? AND session_id = ? AND ts >= ?
       ORDER BY ts ASC, seq ASC LIMIT ?`,
    ).all(getActiveOwner(), sessionId, options.sinceTs ?? 0, limit) as PersistedAiEvent[];
  } catch (e) {
    logger.warn('AI 组件事件读取失败', {
      source: 'aiEventStore', sessionId,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/** 统计（诊断用） */
export function countAiEvents(sessionId?: string): number {
  if (!isDatabaseInitialized()) return 0;
  try {
    const db = getMainDb();
    const row = sessionId
      ? db.prepare('SELECT COUNT(*) AS n FROM ai_events WHERE owner_user_id = ? AND session_id = ?')
        .get(getActiveOwner(), sessionId) as { n: number } | undefined
      : db.prepare('SELECT COUNT(*) AS n FROM ai_events WHERE owner_user_id = ?')
        .get(getActiveOwner()) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** 清空某会话的事件（删除会话时调用） */
export function clearSessionEvents(sessionId: string): void {
  if (!isDatabaseInitialized()) return;
  try {
    getMainDb().prepare('DELETE FROM ai_events WHERE owner_user_id = ? AND session_id = ?')
      .run(getActiveOwner(), sessionId);
  } catch {
    /* 清理失败不阻塞删除会话 */
  }
}

// ── 启动挂接：订阅事件总线并落库 ─────────────────────────────────────

let subscribed = false;

/**
 * 订阅事件总线，把**会话内与组件相关的事件**落库。
 *
 * 覆盖策略：对 `EventType` 的**全部取值**统一判断（`shouldPersist` 按前缀筛选），
 * 这样未来新增组件族事件（loop/memory/multiagent）无需改动此处列表。
 *
 * @returns 实际订阅的事件类型数量
 */
export function startAiEventPersistence(): number {
  if (subscribed) return 0;
  const types = Object.values(EventType).filter((t) => shouldPersist(t));
  subscribeMany(types, (event) => {
    persistAiEvent(event);
  });
  subscribed = true;
  logger.info('AI 组件事件持久化已启用', { source: 'aiEventStore', types: types.length });
  return types.length;
}

/** 取消订阅（测试用） */
export function stopAiEventPersistence(): void {
  subscribed = false;
}
