/**
 * @module repositories/stats
 * @description 个人数据统计：事件写入 + 按种类/按日聚合。
 *
 * 设计：直接对 usage_events 聚合（索引 (user_id, occurred_at)），
 * 数据量增大后可加物化日汇总表，接口不变。
 */

import type { Db } from '../db/pool.js';

export interface UsageEventInput {
  kind: string;
  value?: number;
  occurredAt: Date;
  meta?: Record<string, unknown> | null;
  clientEventId?: string | null;
}

export interface KindTotal {
  kind: string;
  count: number;
  value: number;
}

export interface DailyTotal {
  day: string;
  kind: string;
  count: number;
  value: number;
}

/** 批量写入事件（client_event_id 重复即忽略，保证上报幂等） */
export async function insertEvents(db: Db, userId: string, events: UsageEventInput[]): Promise<number> {
  if (events.length === 0) return 0;
  // 单条 INSERT ... VALUES (...),(...) 批量写入；冲突（同 client_event_id）直接跳过
  const values: unknown[] = [userId];
  const tuples: string[] = [];
  for (const ev of events) {
    const base = values.length;
    tuples.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    values.push(ev.kind, ev.value ?? 0, ev.occurredAt, ev.meta ? JSON.stringify(ev.meta) : null, ev.clientEventId ?? null);
  }
  return db.execute(
    `INSERT INTO usage_events (user_id, kind, value, occurred_at, meta, client_event_id)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (user_id, client_event_id) WHERE client_event_id IS NOT NULL DO NOTHING`,
    values,
  );
}

/** 按种类汇总 */
export async function summaryByKind(db: Db, userId: string, from: Date, to: Date): Promise<KindTotal[]> {
  return db.query<KindTotal>(
    `SELECT kind,
            COUNT(*)::int                       AS count,
            COALESCE(SUM(value), 0)::float8     AS value
     FROM usage_events
     WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3
     GROUP BY kind
     ORDER BY count DESC, kind ASC`,
    [userId, from, to],
  );
}

/** 按日（指定时区）汇总；kind 为空则返回全部种类 */
export async function dailyTotals(
  db: Db,
  userId: string,
  from: Date,
  to: Date,
  timezone: string,
  kind?: string,
): Promise<DailyTotal[]> {
  return db.query<DailyTotal>(
    `SELECT to_char(date_trunc('day', occurred_at AT TIME ZONE $4), 'YYYY-MM-DD') AS day,
            kind,
            COUNT(*)::int                   AS count,
            COALESCE(SUM(value), 0)::float8 AS value
     FROM usage_events
     WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3
       AND ($5::text IS NULL OR kind = $5)
     GROUP BY 1, 2
     ORDER BY 1 ASC, 2 ASC`,
    [userId, from, to, timezone, kind ?? null],
  );
}

/** 区间总计（活跃天数、事件数、数值合计） */
export async function rangeTotals(
  db: Db,
  userId: string,
  from: Date,
  to: Date,
  timezone: string,
): Promise<{ events: number; value: number; activeDays: number }> {
  const row = await db.one<{ events: number; value: number; active_days: number }>(
    `SELECT COUNT(*)::int AS events,
            COALESCE(SUM(value), 0)::float8 AS value,
            COUNT(DISTINCT date_trunc('day', occurred_at AT TIME ZONE $4))::int AS active_days
     FROM usage_events
     WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3`,
    [userId, from, to, timezone],
  );
  return { events: row?.events ?? 0, value: row?.value ?? 0, activeDays: row?.active_days ?? 0 };
}

/** 全部历史总计（不含时间过滤），用于个人中心概览 */
export async function lifetimeTotals(
  db: Db,
  userId: string,
  timezone: string,
): Promise<{ events: number; value: number; activeDays: number; firstAt: Date | null; lastAt: Date | null }> {
  const row = await db.one<{
    events: number;
    value: number;
    active_days: number;
    first_at: Date | null;
    last_at: Date | null;
  }>(
    `SELECT COUNT(*)::int AS events,
            COALESCE(SUM(value), 0)::float8 AS value,
            COUNT(DISTINCT date_trunc('day', occurred_at AT TIME ZONE $2))::int AS active_days,
            MIN(occurred_at) AS first_at,
            MAX(occurred_at) AS last_at
     FROM usage_events
     WHERE user_id = $1`,
    [userId, timezone],
  );
  return {
    events: row?.events ?? 0,
    value: row?.value ?? 0,
    activeDays: row?.active_days ?? 0,
    firstAt: row?.first_at ?? null,
    lastAt: row?.last_at ?? null,
  };
}

export async function deleteAllEvents(db: Db, userId: string): Promise<number> {
  return db.execute('DELETE FROM usage_events WHERE user_id = $1', [userId]);
}
