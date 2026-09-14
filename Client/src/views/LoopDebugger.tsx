/**
 * LoopDebugger — Loop 调试器。
 * 接真实 loop 状态与指纹/策略台账事件。
 *
 * 数据源：loopStore（GET /api/loops/events）
 */
import { useState, useEffect, useMemo } from 'react';
import { Search, Fingerprint, GitBranch, Clock, AlertCircle, Zap, Wrench, ShieldCheck, Scale, ChevronRight } from 'lucide-react';
import { useLoopStore, type DomainEvent } from '@/stores/loopStore';

// 事件分类
const EVENT_CATEGORIES: Record<string, { icon: typeof Zap; color: string; label: string; bg: string }> = {
  'loop': { icon: GitBranch, color: 'text-brand-400', label: 'Loop', bg: 'bg-brand-600/10' },
  'agent': { icon: Zap, color: 'text-brand-400', label: 'Agent', bg: 'bg-brand-600/10' },
  'model': { icon: Zap, color: 'text-info', label: '模型', bg: 'bg-info/10' },
  'tool': { icon: Wrench, color: 'text-success', label: '工具', bg: 'bg-success/10' },
  'verifier': { icon: ShieldCheck, color: 'text-info', label: 'Verifier', bg: 'bg-info/10' },
  'approval': { icon: Scale, color: 'text-agent-creating', label: '审批', bg: 'bg-agent-creating/10' },
  'strategy': { icon: GitBranch, color: 'text-warning', label: '策略', bg: 'bg-warning/10' },
  'arbitration': { icon: AlertCircle, color: 'text-danger', label: '仲裁', bg: 'bg-danger/10' },
  'context': { icon: GitBranch, color: 'text-text-muted', label: '上下文', bg: 'bg-surface-700' },
  'token': { icon: Zap, color: 'text-success', label: 'Token', bg: 'bg-success/10' },
};

function getCategory(eventType: string) {
  const cat = eventType.split(':')[0];
  return EVENT_CATEGORIES[cat] ?? { icon: Zap, color: 'text-text-muted', label: cat, bg: 'bg-surface-700' };
}

function isErrorEvent(evt: DomainEvent): boolean {
  return evt.eventType.includes('error') || evt.eventType.includes('failed') || evt.eventType.includes('rejected');
}

function isStrategySwitch(evt: DomainEvent): boolean {
  return evt.eventType === 'strategy:switch';
}

function isFingerprintEvent(evt: DomainEvent): boolean {
  return evt.eventType.includes('fingerprint') || evt.eventType.includes('context:compressed');
}

export default function LoopDebugger() {
  const { events, hydrate } = useLoopStore();
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const [traceInput, setTraceInput] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  useEffect(() => { hydrate({ limit: 500 }); }, []);

  // 提取唯一 traceId 列表
  const traceIds = useMemo(() =>
    [...new Set(events.map(e => e.traceId).filter(Boolean))] as string[],
    [events]
  );

  // 当前选中 trace 的事件
  const filteredEvents = useMemo(() => {
    let evts = selectedTrace
      ? events.filter(e => e.traceId === selectedTrace)
      : events;
    if (categoryFilter) {
      evts = evts.filter(e => e.eventType.split(':')[0] === categoryFilter);
    }
    return evts.sort((a, b) => a.timestamp - b.timestamp);
  }, [events, selectedTrace, categoryFilter]);

  // 统计
  const stats = useMemo(() => {
    const errorCount = filteredEvents.filter(isErrorEvent).length;
    const strategySwitches = filteredEvents.filter(isStrategySwitch).length;
    const fingerprintEvents = filteredEvents.filter(isFingerprintEvent).length;
    const totalDuration = filteredEvents.length > 0
      ? filteredEvents[filteredEvents.length - 1].timestamp - filteredEvents[0].timestamp
      : 0;
    return { errorCount, strategySwitches, fingerprintEvents, totalDuration };
  }, [filteredEvents]);

  const handleSearch = () => {
    if (traceInput.trim()) {
      setSelectedTrace(traceInput.trim());
      hydrate({ traceId: traceInput.trim(), limit: 500 });
    }
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Loop 调试器</h1>
          <p className="text-xs text-text-muted mt-0.5">按 trace_id 回放 · 步骤耗时 · 策略切换 · 指纹检测</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-800 border border-surface-700">
          <Search size={14} className="text-text-muted" />
          <input
            className="bg-transparent text-xs text-text-primary outline-none w-48 font-mono placeholder:text-text-muted"
            placeholder="输入 trace_id…"
            value={traceInput}
            onChange={e => setTraceInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
        </div>
      </div>

      {/* 统计栏 */}
      <div className="flex gap-4 text-[10px] font-mono">
        <span className="text-text-muted">
          {filteredEvents.length} 事件
          {selectedTrace && <span className="text-text-secondary"> · trace: {selectedTrace.slice(0, 16)}</span>}
        </span>
        <span className="text-brand-400">耗时 {(stats.totalDuration / 1000).toFixed(1)}s</span>
        {stats.strategySwitches > 0 && <span className="text-warning">策略切换 ×{stats.strategySwitches}</span>}
        {stats.fingerprintEvents > 0 && <span className="text-info">指纹 ×{stats.fingerprintEvents}</span>}
        {stats.errorCount > 0 && <span className="text-danger">错误 ×{stats.errorCount}</span>}
      </div>

      {/* 分类过滤 */}
      <div className="flex gap-1.5 flex-wrap">
        <button
          onClick={() => setCategoryFilter(null)}
          className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${!categoryFilter ? 'bg-brand-600 text-white' : 'bg-surface-800 text-text-secondary hover:bg-surface-700'}`}
        >
          全部
        </button>
        {Object.entries(EVENT_CATEGORIES).map(([key, val]) => {
          const Icon = val.icon;
          return (
            <button
              key={key}
              onClick={() => setCategoryFilter(categoryFilter === key ? null : key)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium flex items-center gap-1.5 transition-colors ${categoryFilter === key ? 'bg-brand-600 text-white' : 'bg-surface-800 text-text-secondary hover:bg-surface-700'}`}
            >
              <Icon size={10} className={val.color} />
              {val.label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-4 gap-4">
        {/* Trace 列表 */}
        <div className="card space-y-2 overflow-y-auto" style={{ maxHeight: '65vh' }}>
          <div className="text-[10px] text-text-muted uppercase tracking-wider mb-2">活跃 Trace</div>
          {traceIds.length === 0 ? (
            <div className="text-xs text-text-muted py-8 text-center">暂无事件数据</div>
          ) : (
            traceIds.map(traceId => {
              const traceEvents = events.filter(e => e.traceId === traceId);
              const hasError = traceEvents.some(isErrorEvent);
              const duration = traceEvents.length > 1
                ? traceEvents[traceEvents.length - 1].timestamp - traceEvents[0].timestamp
                : 0;
              return (
                <div
                  key={traceId}
                  onClick={() => { setSelectedTrace(traceId); hydrate({ traceId, limit: 500 }); }}
                  className={`p-2.5 rounded-lg cursor-pointer transition-colors ${
                    selectedTrace === traceId
                      ? 'bg-brand-600/10 border border-brand-600/30'
                      : 'bg-surface-700/50 hover:bg-surface-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-mono font-medium text-text-primary truncate">{traceId.slice(0, 12)}</span>
                    <div className="flex items-center gap-1">
                      {hasError && <AlertCircle size={9} className="text-danger" />}
                      <span className="badge badge-brand text-[8px]">{traceEvents.length}</span>
                    </div>
                  </div>
                  <div className="flex gap-3 mt-1 text-[10px] text-text-muted font-mono">
                    <span>{(duration / 1000).toFixed(1)}s</span>
                    <span>{traceEvents[0]?.source}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 事件时间轴 */}
        <div className="col-span-3 card overflow-y-auto" style={{ maxHeight: '65vh' }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <GitBranch size={14} className="text-brand-400" />
              <span className="text-xs font-mono text-text-primary">
                {selectedTrace ? selectedTrace.slice(0, 16) : '全部事件'}
              </span>
            </div>
          </div>

          {filteredEvents.length === 0 ? (
            <div className="text-center py-16 text-text-muted text-sm">
              {selectedTrace ? '加载中…' : '选择 Trace 或查看全部事件'}
            </div>
          ) : (
            <div className="relative pl-4">
              <div className="absolute left-[9px] top-0 bottom-0 w-0.5 bg-surface-600" />
              <div className="space-y-2">
                {filteredEvents.map((evt, i) => {
                  const cat = getCategory(evt.eventType);
                  const Icon = cat.icon;
                  const isError = isErrorEvent(evt);
                  const isSwitch = isStrategySwitch(evt);
                  const isFp = isFingerprintEvent(evt);
                  const delta = i > 0 ? evt.timestamp - filteredEvents[i - 1].timestamp : 0;

                  return (
                    <div key={evt.eventId} className="relative flex items-start gap-3">
                      {/* 时间线节点 */}
                      <div className={`relative z-10 w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                        isError ? 'bg-danger/20 border-2 border-danger' :
                        isSwitch ? 'bg-warning/20 border-2 border-warning' :
                        isFp ? 'bg-info/20 border-2 border-info' :
                        `bg-surface-700 border-2 border-current ${cat.color}`
                      }`}>
                        <Icon size={9} />
                      </div>

                      {/* 事件内容 */}
                      <div className={`flex-1 p-3 rounded-lg ${
                        isError ? 'bg-danger/5 border border-danger/20' :
                        isSwitch ? 'bg-warning/5 border border-warning/20' :
                        isFp ? 'bg-info/5 border border-info/20' :
                        'bg-surface-700/50'
                      }`}>
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className={`text-xs font-mono font-medium ${isError ? 'text-danger' : 'text-text-primary'}`}>
                              {evt.eventType}
                            </span>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded ${cat.bg} ${cat.color}`}>
                              {cat.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-text-muted font-mono">
                            {delta > 0 && <span className="text-brand-400">+{(delta / 1000).toFixed(1)}s</span>}
                            <Clock size={9} />
                            {new Date(evt.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </div>
                        </div>
                        <div className="text-[11px] text-text-secondary font-mono truncate">
                          {JSON.stringify(evt.payload, null, 0)}
                        </div>

                        {/* 策略切换标注 */}
                        {isSwitch && (
                          <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
                            <Fingerprint size={10} className="text-warning" />
                            <span className="text-warning">
                              策略切换: {String(evt.payload?.from ?? '?')} → {String(evt.payload?.to ?? '?')}
                            </span>
                          </div>
                        )}

                        {/* 指纹/压缩标注 */}
                        {isFp && (
                          <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
                            <Fingerprint size={10} className="text-info" />
                            <span className="text-info">
                              {evt.eventType.includes('compressed') ? '上下文已压缩' : '指纹检测'}
                            </span>
                          </div>
                        )}

                        {/* 错误标注 */}
                        {isError && (
                          <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
                            <AlertCircle size={10} className="text-danger" />
                            <span className="text-danger">失败/错误</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
