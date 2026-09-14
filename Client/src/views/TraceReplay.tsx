/**
 * TraceReplay — 链路回放（LangSmith 形态）。
 * 左侧 trace 列表 | 中间时间线 + span 树 | 右侧 span 详情（输入输出原文）。
 *
 * 数据源：loopStore（GET /api/loops/events?traceId=）
 */
import { useState, useEffect, useMemo } from 'react';
import { Search, GitBranch, Clock, ChevronRight, ChevronDown, AlertCircle, Zap, Wrench, ShieldCheck, Scale } from 'lucide-react';
import { useLoopStore, type DomainEvent } from '@/stores/loopStore';

// span 类型映射
const SPAN_KIND: Record<string, { icon: typeof Zap; color: string; label: string }> = {
  'agent': { icon: Zap, color: 'text-brand-400', label: 'Agent' },
  'model': { icon: Zap, color: 'text-info', label: '模型调用' },
  'tool': { icon: Wrench, color: 'text-success', label: '工具调用' },
  'verifier': { icon: ShieldCheck, color: 'text-info', label: 'Verifier' },
  'approval': { icon: Scale, color: 'text-agent-creating', label: '审批' },
  'strategy': { icon: GitBranch, color: 'text-warning', label: '策略' },
  'arbitration': { icon: AlertCircle, color: 'text-danger', label: '仲裁' },
  'loop': { icon: GitBranch, color: 'text-brand-400', label: 'Loop' },
};

function getSpanKind(eventType: string) {
  const cat = eventType.split(':')[0];
  return SPAN_KIND[cat] ?? { icon: Zap, color: 'text-text-muted', label: cat };
}

function isErrorEvent(evt: DomainEvent): boolean {
  return evt.eventType.includes('error') || evt.eventType.includes('failed') || evt.eventType.includes('rejected');
}

export default function TraceReplay() {
  const { events, hydrate } = useLoopStore();
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<DomainEvent | null>(null);
  const [traceSearch, setTraceSearch] = useState('');

  useEffect(() => { hydrate({ limit: 500 }); }, []);

  // 提取唯一 trace 列表
  const traceList = useMemo(() => {
    const map = new Map<string, { traceId: string; events: DomainEvent[]; firstEvent: number; lastEvent: number }>();
    for (const evt of events) {
      if (!evt.traceId) continue;
      const entry = map.get(evt.traceId);
      if (entry) {
        entry.events.push(evt);
        entry.lastEvent = Math.max(entry.lastEvent, evt.timestamp);
      } else {
        map.set(evt.traceId, { traceId: evt.traceId, events: [evt], firstEvent: evt.timestamp, lastEvent: evt.timestamp });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.firstEvent - a.firstEvent);
  }, [events]);

  // 过滤后的 trace 列表
  const filteredTraces = traceList.filter(t =>
    !traceSearch || t.traceId.includes(traceSearch)
  );

  // 当前选中 trace 的事件
  const traceEvents = useMemo(() => {
    if (!selectedTrace) return [];
    return events.filter(e => e.traceId === selectedTrace).sort((a, b) => a.timestamp - b.timestamp);
  }, [events, selectedTrace]);

  const handleSelectTrace = (traceId: string) => {
    setSelectedTrace(traceId);
    setSelectedSpan(null);
    hydrate({ traceId, limit: 500 });
  };

  const handleSelectSpan = (evt: DomainEvent) => {
    setSelectedSpan(evt);
  };

  // 总耗时
  const totalDuration = traceEvents.length > 0
    ? traceEvents[traceEvents.length - 1].timestamp - traceEvents[0].timestamp
    : 0;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">链路回放</h1>
          <p className="text-xs text-text-muted mt-0.5">Trace 列表 · 时间线 Span 树 · 详情面板</p>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4" style={{ minHeight: '70vh' }}>
        {/* ── 左栏：Trace 列表 ──────────────────── */}
        <div className="col-span-3 card overflow-y-auto">
          <div className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Trace 列表</div>

          {/* 搜索 */}
          <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-surface-800 border border-surface-700 mb-3">
            <Search size={12} className="text-text-muted" />
            <input
              className="bg-transparent text-xs text-text-primary outline-none w-full font-mono placeholder:text-text-muted"
              placeholder="搜索 trace_id…"
              value={traceSearch}
              onChange={e => setTraceSearch(e.target.value)}
            />
          </div>

          {filteredTraces.length === 0 ? (
            <div className="text-xs text-text-muted py-8 text-center">暂无 Trace 数据</div>
          ) : (
            <div className="space-y-1.5">
              {filteredTraces.map(t => {
                const hasError = t.events.some(isErrorEvent);
                const duration = t.lastEvent - t.firstEvent;
                return (
                  <div
                    key={t.traceId}
                    onClick={() => handleSelectTrace(t.traceId)}
                    className={`p-2.5 rounded-lg cursor-pointer transition-colors ${
                      selectedTrace === t.traceId
                        ? 'bg-brand-600/10 border border-brand-600/30'
                        : 'bg-surface-700/50 hover:bg-surface-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-mono font-medium text-text-primary truncate">
                        {t.traceId.slice(0, 12)}
                      </span>
                      {hasError && <AlertCircle size={10} className="text-danger shrink-0" />}
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-text-muted font-mono">
                      <span>{t.events.length} 事件</span>
                      <span>·</span>
                      <span>{(duration / 1000).toFixed(1)}s</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── 中栏：时间线 + Span 树 ──────────────── */}
        <div className="col-span-5 card overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <GitBranch size={14} className="text-brand-400" />
              <span className="text-xs font-mono text-text-primary">
                {selectedTrace ? selectedTrace.slice(0, 16) : '选择 Trace'}
              </span>
            </div>
            {traceEvents.length > 0 && (
              <span className="text-[10px] text-text-muted font-mono">
                总耗时 {(totalDuration / 1000).toFixed(1)}s
              </span>
            )}
          </div>

          {!selectedTrace ? (
            <div className="text-center py-16 text-text-muted text-sm">← 选择一条 Trace 开始回放</div>
          ) : traceEvents.length === 0 ? (
            <div className="text-center py-16 text-text-muted text-sm">加载中…</div>
          ) : (
            <div className="relative pl-4">
              {/* 时间轴线 */}
              <div className="absolute left-[9px] top-0 bottom-0 w-0.5 bg-surface-600" />

              <div className="space-y-2">
                {traceEvents.map((evt, i) => {
                  const kind = getSpanKind(evt.eventType);
                  const Icon = kind.icon;
                  const isError = isErrorEvent(evt);
                  const isSelected = selectedSpan?.eventId === evt.eventId;
                  const delta = i > 0 ? evt.timestamp - traceEvents[i - 1].timestamp : 0;

                  return (
                    <div
                      key={evt.eventId}
                      onClick={() => handleSelectSpan(evt)}
                      className={`relative flex items-start gap-3 cursor-pointer rounded-lg p-2 transition-colors ${
                        isSelected ? 'bg-brand-600/10' : 'hover:bg-surface-700/50'
                      }`}
                    >
                      {/* 时间线节点 */}
                      <div className={`relative z-10 w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                        isError ? 'bg-danger/20 border-2 border-danger' :
                        `bg-surface-700 border-2 border-current ${kind.color}`
                      }`}>
                        <Icon size={9} />
                      </div>

                      {/* Span 内容 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className={`text-xs font-mono font-medium ${isError ? 'text-danger' : 'text-text-primary'}`}>
                            {evt.eventType}
                          </span>
                          <div className="flex items-center gap-2 text-[10px] text-text-muted font-mono">
                            {delta > 0 && <span className="text-brand-400">+{(delta / 1000).toFixed(1)}s</span>}
                            <Clock size={9} />
                            {new Date(evt.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </div>
                        </div>
                        <div className="text-[10px] text-text-muted">{kind.label} · {evt.source}</div>
                      </div>

                      <ChevronRight size={12} className="text-text-muted shrink-0 mt-1" />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ── 右栏：Span 详情 ──────────────────── */}
        <div className="col-span-4 card overflow-y-auto">
          <div className="text-[10px] text-text-muted uppercase tracking-wider mb-3">Span 详情</div>

          {!selectedSpan ? (
            <div className="text-center py-16 text-text-muted text-sm">← 选择一个 Span 查看详情</div>
          ) : (
            <div className="space-y-4">
              {/* 基本信息 */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {(() => { const Icon = getSpanKind(selectedSpan.eventType).icon; return <Icon size={14} className={getSpanKind(selectedSpan.eventType).color} />; })()}
                  <span className="text-sm font-mono font-semibold text-text-primary">{selectedSpan.eventType}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                  <div className="p-2 rounded bg-surface-800">
                    <div className="text-text-muted">Event ID</div>
                    <div className="text-text-primary truncate">{selectedSpan.eventId}</div>
                  </div>
                  <div className="p-2 rounded bg-surface-800">
                    <div className="text-text-muted">Trace ID</div>
                    <div className="text-text-primary truncate">{selectedSpan.traceId?.slice(0, 12)}</div>
                  </div>
                  <div className="p-2 rounded bg-surface-800">
                    <div className="text-text-muted">时间</div>
                    <div className="text-text-primary">{new Date(selectedSpan.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as any)}</div>
                  </div>
                  <div className="p-2 rounded bg-surface-800">
                    <div className="text-text-muted">来源</div>
                    <div className="text-text-primary">{selectedSpan.source}</div>
                  </div>
                </div>
              </div>

              {/* Payload 详情 */}
              <div>
                <div className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Payload</div>
                <pre className="p-3 rounded-lg bg-surface-800 text-[11px] text-text-secondary font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
                  {JSON.stringify(selectedSpan.payload, null, 2)}
                </pre>
              </div>

              {/* 错误标记 */}
              {isErrorEvent(selectedSpan) && (
                <div className="p-3 rounded-lg bg-danger/10 border border-danger/20">
                  <div className="flex items-center gap-2 text-danger text-xs font-semibold mb-1">
                    <AlertCircle size={14} />
                    失败 Span
                  </div>
                  <p className="text-[11px] text-text-secondary">此事件标记为错误/失败/拒绝状态，请检查 payload 中的错误信息。</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
