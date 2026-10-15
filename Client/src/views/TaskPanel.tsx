import { useState, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import { useTaskStore, type TaskRecord } from '@/stores/taskStore';
import { WORKING_MODE_OPTIONS, WORKING_MODE_LABELS, isWorkingMode } from '@/components/Chat/workingModeLabels';

const statusBadge: Record<string, string> = {
  submitted: 'badge-warning',
  running: 'badge-brand',
  completed: 'badge-success',
  failed: 'badge-danger',
  cancelled: 'badge',
};

const statusLabel: Record<string, string> = {
  submitted: '已提交', running: '执行中', completed: '已完成', failed: '已失败', cancelled: '已取消',
};

/**
 * `result` 有两种已知内部形态需要翻译，其余（聚合结果 / 失败原因）原样透出：
 * 派发态 JSON 摊给用户会被误读成"已完成"，取消标记则是纯内部字面量。
 */
function describeTaskResult(result: string): string {
  if (result === 'cancelled_by_user') return '已由用户取消（不中断已在跑的子任务）';
  try {
    const parsed = JSON.parse(result) as { status?: string; assignmentCount?: number };
    if (parsed.status === 'dispatched') {
      return typeof parsed.assignmentCount === 'number'
        ? `已派发 ${parsed.assignmentCount} 个子任务，等待编排收尾`
        : '已派发，等待编排收尾';
    }
  } catch { /* 不是 JSON：按原文展示 */ }
  return result;
}

export default function TaskPanel() {
  const { tasks, loading, hydrate, submitTask, cancelTask } = useTaskStore();
  const [filter, setFilter] = useState<'all' | 'submitted' | 'running' | 'completed' | 'failed' | 'cancelled'>('all');
  const [newDesc, setNewDesc] = useState('');
  /** '' = 自动决定：不传 routingMode，由后端复杂度评估路由 */
  const [routingMode, setRoutingMode] = useState<string>('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => { hydrate(); }, []);

  const filtered = filter === 'all' ? tasks : tasks.filter(t => t.status === filter);

  const handleSubmit = async () => {
    if (!newDesc.trim()) return;
    const result = await submitTask(newDesc.trim(), routingMode || undefined);
    if (result.ok) {
      setNewDesc('');
      setSubmitError(null);
    } else {
      // 保留输入内容，否则用户刚写的描述会随错误一起消失
      setSubmitError(result.error ?? '任务提交失败');
    }
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">任务面板</h1>
          <p className="text-xs text-text-muted mt-0.5">任务提交 · 编排执行 · 状态追踪</p>
        </div>
      </div>

      {/* 提交任务 */}
      <div className="card space-y-2">
        <div className="flex gap-2">
          <input
            className="flex-1 bg-surface-800 text-sm text-text-primary px-3 py-2 rounded-lg border border-surface-700 outline-none focus:border-brand-500 placeholder:text-text-muted"
            placeholder="描述一个任务…"
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          />
          <button className="btn btn-primary" onClick={handleSubmit} disabled={!newDesc.trim()}>
            <Plus size={14} />提交
          </button>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-text-muted" htmlFor="task-routing-mode">工作方式</label>
          <select
            id="task-routing-mode"
            className="bg-surface-800 text-xs text-text-secondary px-2 py-1.5 rounded-lg border border-surface-700 outline-none focus:border-brand-500"
            value={routingMode}
            onChange={e => setRoutingMode(e.target.value)}
          >
            <option value="">自动决定（按复杂度评估）</option>
            {WORKING_MODE_OPTIONS.map(([mode, label]) => (
              <option key={mode} value={mode}>{label}</option>
            ))}
          </select>
          {submitError && (
            <span className="text-[11px] text-danger" role="alert">{submitError}</span>
          )}
        </div>
      </div>

      {/* 过滤器 */}
      <div className="flex gap-1.5">
        {(['all', 'running', 'submitted', 'completed', 'failed'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${filter === f ? 'bg-brand-600 text-white' : 'bg-surface-800 text-text-secondary hover:bg-surface-700'}`}>
            {f === 'all' ? '全部' : statusLabel[f]}
          </button>
        ))}
      </div>

      {/* 任务列表 */}
      {filtered.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-sm text-text-secondary">{loading ? '加载中…' : '暂无任务'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(task => (
            <TaskCard key={task.taskId} task={task} onCancel={() => cancelTask(task.taskId)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, onCancel }: { task: TaskRecord; onCancel: () => void }) {
  const canCancel = task.status === 'submitted' || task.status === 'running';

  return (
    <div className="card hover:border-brand-600/30 transition-colors group">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1.5">
            <h3 className="text-sm font-semibold text-text-primary">{task.description}</h3>
            <span className={`badge text-[10px] ${statusBadge[task.status]}`}>
              {statusLabel[task.status]}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-text-muted font-mono">
            <span>{task.taskId}</span>
            <span>·</span>
            <span>{task.routingMode
              ? `工作方式 ${isWorkingMode(task.routingMode) ? WORKING_MODE_LABELS[task.routingMode] : task.routingMode}`
              : '工作方式 自动决定'}</span>
            <span>·</span>
            <span>trace: {task.traceId.slice(0, 8)}</span>
            <span>·</span>
            <span>{new Date(task.createdAt).toLocaleTimeString('zh-CN')}</span>
          </div>
        </div>
        {canCancel && (
          <button onClick={onCancel} className="btn btn-ghost text-xs opacity-0 group-hover:opacity-100 transition-opacity">
            <X size={14} />取消
          </button>
        )}
      </div>
      {task.result && (
        <div className="mt-2 text-[11px] text-text-muted font-mono truncate">{describeTaskResult(task.result)}</div>
      )}
    </div>
  );
}
