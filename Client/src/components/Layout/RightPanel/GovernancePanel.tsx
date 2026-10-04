/**
 * @module components/Layout/RightPanel/GovernancePanel
 * @description 治理记录面板（2026-10-04 新增，配合清单 G-10）。
 *
 * 目的：把"治理层只由 L0 承担"这件事**变得可见** —— 谁、以什么身份、何时、
 * 做了什么治理动作、结果如何（放行/拒绝）、依据是什么。
 *
 * 数据：`useGovernanceStore`（实时事件 `governance:action_recorded` + 启动回填）。
 * 拒绝（越权尝试）用醒目色标出——它是有价值的治理事实，不应被埋没。
 */

import { useEffect, useMemo } from 'react';

import {
  useGovernanceStore, labelOfAction,
  type GovernanceRecordView,
} from '@/stores/governanceStore';

const OUTCOME_STYLE: Record<GovernanceRecordView['outcome'], { text: string; cls: string; label: string }> = {
  allowed: { text: '✓', cls: 'text-emerald-400', label: '放行' },
  denied: { text: '✕', cls: 'text-red-400', label: '拒绝' },
  failed: { text: '!', cls: 'text-amber-400', label: '失败' },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function GovernancePanel(): React.ReactElement {
  // ⚠️ 选择器必须返回**稳定引用**（原始类型或原数组），否则 `useSyncExternalStore` 的
  //    getSnapshot 每次都是新值 → React 报 "getSnapshot should be cached" 并陷入无限重渲染
  //    （本面板初版即因此崩溃）。因此这里只选原始字段，派生数据用 useMemo 计算。
  const allRecords = useGovernanceStore(s => s.records);
  const filter = useGovernanceStore(s => s.filterOutcome);
  const setFilter = useGovernanceStore(s => s.setFilter);
  const clear = useGovernanceStore(s => s.clear);
  const hydrate = useGovernanceStore(s => s.hydrate);
  const groupBy = useGovernanceStore(s => s.groupBy);
  const setGroupBy = useGovernanceStore(s => s.setGroupBy);

  const records = useMemo(
    () => (filter === 'all' ? allRecords : allRecords.filter(r => r.outcome === filter)),
    [allRecords, filter],
  );
  const summary = useMemo(() => {
    const denied = allRecords.filter(r => r.outcome === 'denied').length;
    return { total: allRecords.length, denied, allowed: allRecords.length - denied };
  }, [allRecords]);

  /**
   * 按 `taskId ?? traceId` 聚合（2026-10-04）。
   *
   * 用途：一次任务的完整治理链（审批 → 按需创建 L0 → 裁决 → 留痕）在时间线上是散落的，
   * 按任务聚合后可一眼看清"这个任务上发生过哪些治理动作、谁做的、结果如何"。
   */
  const groups = useMemo(() => {
    if (groupBy !== 'task') return null;
    const map = new Map<string, GovernanceRecordView[]>();
    for (const r of records) {
      const key = r.taskId ?? r.traceId ?? '（无任务标识）';
      const list = map.get(key);
      if (list) list.push(r); else map.set(key, [r]);
    }
    return [...map.entries()].sort((a, b) => {
      const at = a[1][a[1].length - 1]?.timestamp ?? 0;
      const bt = b[1][b[1].length - 1]?.timestamp ?? 0;
      return bt - at; // 最近活跃的任务在前
    });
  }, [records, groupBy]);

  // 挂载时回填一次历史（失败静默：不影响实时视图）
  useEffect(() => { void hydrate(); }, [hydrate]);

  const body = useMemo(() => {
    if (records.length === 0) {
      return (
        <div className="text-xs text-text-muted px-3 py-6 text-center leading-relaxed">
          暂无治理动作记录。<br />
          <span className="opacity-70">审批裁决、审计冻结、监管执法、仲裁裁决与治理广播都会在此留痕。</span>
        </div>
      );
    }
    const renderRecord = (r: GovernanceRecordView, showTask: boolean) => {
      const style = OUTCOME_STYLE[r.outcome];
      return (
        <div key={r.recordId} className="px-3 py-2 border-b border-surface-800/60 last:border-b-0">
          <div className="flex items-center gap-2">
            <span className={`text-[11px] font-bold ${style.cls}`} title={style.label}>{style.text}</span>
            <span className="text-xs text-text-primary font-medium truncate">{labelOfAction(r.action)}</span>
            <span className="ml-auto text-[10px] text-text-muted flex-shrink-0">{formatTime(r.timestamp)}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-800 text-text-secondary">
              {r.actorRole}
            </span>
            {r.actorId && (
              <span className="text-[10px] text-text-muted truncate max-w-[160px]" title={r.actorId}>
                {r.actorId}
              </span>
            )}
            {showTask && r.taskId && (
              <span className="text-[10px] text-text-muted" title={`task=${r.taskId}`}>
                · {r.taskId}
              </span>
            )}
          </div>
          {r.reason && (
            <div className="mt-1 text-[10px] text-text-muted leading-snug line-clamp-2" title={r.reason}>
              {r.reason}
            </div>
          )}
        </div>
      );
    };

    // 按任务聚合视图
    if (groups) {
      return groups.map(([key, list]) => (
        <div key={key} className="border-b border-surface-800">
          <div className="px-3 py-1.5 bg-surface-800/40 flex items-center gap-2 sticky top-0 z-10">
            <span className="text-[11px] text-text-secondary truncate" title={key}>{key}</span>
            <span className="ml-auto text-[10px] text-text-muted flex-shrink-0">{list.length} 条</span>
          </div>
          {list.slice().reverse().map(r => renderRecord(r, false))}
        </div>
      ));
    }

    return records.slice().reverse().map(r => renderRecord(r, true));
  }, [records, groups]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-surface-800">
        <span className="text-[11px] text-text-secondary">共 {summary.total} 条</span>
        {summary.denied > 0 && (
          <span className="text-[11px] text-red-400">· 拒绝 {summary.denied}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {(['all', 'allowed', 'denied'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                filter === f ? 'bg-surface-700 text-text-primary' : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {f === 'all' ? '全部' : f === 'allowed' ? '放行' : '拒绝'}
            </button>
          ))}
          <button
            onClick={() => setGroupBy(groupBy === 'task' ? 'timeline' : 'task')}
            className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
              groupBy === 'task' ? 'bg-surface-700 text-text-primary' : 'text-text-muted hover:text-text-secondary'
            }`}
            title="按任务聚合（taskId / traceId）与时间线切换"
          >
            {groupBy === 'task' ? '按任务' : '时间线'}
          </button>
          <button
            onClick={clear}
            className="text-[10px] px-1.5 py-0.5 rounded text-text-muted hover:text-text-secondary"
            title="仅清空本地视图（后端台账仍在）"
          >
            清空
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}
