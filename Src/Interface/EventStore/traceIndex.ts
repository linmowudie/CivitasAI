/**
 * @module Interface/EventStore/traceIndex
 * @description
 * 追踪索引文件生成（FE-069 实装：优雅关闭④——此前“后续接入 trace index writer”空壳）。
 *
 * 把本次运行期的事件流按 trace 聚合为索引文件（`Logs/trace-index-<ts>.json`），
 * 供事后按 trace 回溯：traceId → 事件数 / 起止时间 / 来源分布。
 * 与 `ai_events` 表（组件事件持久化）互补：本文件是轻量“目录”，不重复事件内容。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getEventLog } from '../../Services/EventBus/eventBus.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

/** 单条 trace 的索引摘要 */
export interface TraceIndexEntry {
  traceId: string;
  eventCount: number;
  firstEventAt: number;
  lastEventAt: number;
  /** 主要事件来源（去重前 5 个） */
  sources: string[];
}

/** 从事件总线日志构建 trace 索引（纯函数，便于测试） */
export function buildTraceIndex(): TraceIndexEntry[] {
  const events = getEventLog();
  const byTrace = new Map<string, { count: number; first: number; last: number; sources: Set<string> }>();

  for (const event of events) {
    const traceId = event.traceId ?? '(no-trace)';
    const cur = byTrace.get(traceId);
    if (cur) {
      cur.count++;
      cur.first = Math.min(cur.first, event.timestamp);
      cur.last = Math.max(cur.last, event.timestamp);
      cur.sources.add(event.source);
    } else {
      byTrace.set(traceId, {
        count: 1,
        first: event.timestamp,
        last: event.timestamp,
        sources: new Set([event.source]),
      });
    }
  }

  return [...byTrace.entries()]
    .map(([traceId, v]) => ({
      traceId,
      eventCount: v.count,
      firstEventAt: v.first,
      lastEventAt: v.last,
      sources: [...v.sources].slice(0, 5),
    }))
    .sort((a, b) => b.lastEventAt - a.lastEventAt);
}

/**
 * 写入 trace 索引文件到指定日志目录。
 * @returns 生成的文件绝对/相对路径
 */
export function writeTraceIndex(logDir: string): Result<string> {
  try {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const entries = buildTraceIndex();
    const file = join(logDir, `trace-index-${Date.now()}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        generatedAt: Date.now(),
        traceCount: entries.length,
        eventCount: entries.reduce((n, e) => n + e.eventCount, 0),
        traces: entries,
      }, null, 2),
      'utf-8',
    );
    return ok(file);
  } catch (e) {
    return err(`trace 索引写入失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}
