/**
 * @module Scripts/traceAnalysis
 * @description
 * Trace 分析脚本——Docs/14 §S14。
 * 分析事件日志中的 trace_id 链路完整性、耗时分布、Token 消耗。
 * 用法：npx tsx Scripts/traceAnalysis.ts [--traceId=xxx] [--limit=50]
 */

import { getEventLog } from '../Src/Services/EventBus/eventBus.js';
import { EventType } from '../Src/Services/EventBus/eventTypes.js';

// ── 分析结果 ────────────────────────────────────────────────────────

interface TraceAnalysis {
  traceId: string;
  eventCount: number;
  firstEventAt: number;
  lastEventAt: number;
  durationMs: number;
  eventTypes: string[];
  hasStart: boolean;
  hasCompletion: boolean;
  isComplete: boolean;
}

interface AnalysisSummary {
  totalTraces: number;
  completeTraces: number;
  incompleteTraces: number;
  avgDurationMs: number;
  maxDurationMs: number;
  minDurationMs: number;
}

// ── 分析函数 ────────────────────────────────────────────────────────

function analyzeTrace(traceId: string, events: ReturnType<typeof getEventLog>): TraceAnalysis {
  const traceEvents = events.filter(e => e.traceId === traceId);
  const timestamps = traceEvents.map(e => e.timestamp);
  const eventTypes = traceEvents.map(e => e.eventType);

  const firstEventAt = Math.min(...timestamps);
  const lastEventAt = Math.max(...timestamps);

  const hasStart = eventTypes.includes(EventType.TASK_RECEIVED) ||
    eventTypes.includes(EventType.LOOP_STARTED);
  const hasCompletion = eventTypes.includes(EventType.TASK_COMPLETED) ||
    eventTypes.includes(EventType.LOOP_COMPLETED) ||
    eventTypes.includes(EventType.LOOP_ABORTED);

  return {
    traceId,
    eventCount: traceEvents.length,
    firstEventAt,
    lastEventAt,
    durationMs: lastEventAt - firstEventAt,
    eventTypes: [...new Set(eventTypes)],
    hasStart,
    hasCompletion,
    isComplete: hasStart && hasCompletion,
  };
}

function summarizeTraces(analyses: TraceAnalysis[]): AnalysisSummary {
  const durations = analyses.filter(a => a.isComplete).map(a => a.durationMs);

  return {
    totalTraces: analyses.length,
    completeTraces: analyses.filter(a => a.isComplete).length,
    incompleteTraces: analyses.filter(a => !a.isComplete).length,
    avgDurationMs: durations.length > 0 ? durations.reduce((s, d) => s + d, 0) / durations.length : 0,
    maxDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
    minDurationMs: durations.length > 0 ? Math.min(...durations) : 0,
  };
}

// ── 主函数 ──────────────────────────────────────────────────────────

export function runTraceAnalysis(options: { traceId?: string; limit?: number } = {}): {
  summary: AnalysisSummary;
  traces: TraceAnalysis[];
} {
  const events = getEventLog({ limit: options.limit ?? 1000 });

  // 提取唯一 traceId
  const traceIds = [...new Set(events.filter(e => e.traceId).map(e => e.traceId!))];

  // 过滤
  const filtered = options.traceId
    ? traceIds.filter(id => id === options.traceId)
    : traceIds;

  // 分析每个 trace
  const analyses = filtered.map(id => analyzeTrace(id, events));

  // 汇总
  const summary = summarizeTraces(analyses);

  return { summary, traces: analyses };
}

// ── CLI 入口 ────────────────────────────────────────────────────────

if (process.argv[1]?.includes('traceAnalysis')) {
  const args = process.argv.slice(2);
  const options: { traceId?: string; limit?: number } = {};

  for (const arg of args) {
    if (arg.startsWith('--traceId=')) options.traceId = arg.split('=')[1];
    if (arg.startsWith('--limit=')) options.limit = parseInt(arg.split('=')[1], 10);
  }

  const result = runTraceAnalysis(options);
  console.log('=== Trace Analysis ===');
  console.log(JSON.stringify(result, null, 2));
}
