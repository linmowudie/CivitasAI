/**
 * TaskView —— 任务详情视图。
 * 设计规格：§4.2.2
 */
import { useTaskStore, type TaskRecord } from '@/stores/taskStore';
import { useUIStore } from '@/stores/uiStore';

const statusColor: Record<string, string> = {
  submitted: '#3b82f6', running: '#f59e0b', completed: '#10b981',
  failed: '#ef4444', cancelled: '#6b7280',
};

export default function TaskView() {
  const mainView = useUIStore((s) => s.mainView);
  const tasks = useTaskStore((s) => s.tasks);

  if (mainView.type !== 'task') return null;

  const task = tasks.find(t => t.taskId === mainView.id);
  if (!task) {
    return <div className="p-4 text-xs text-text-muted">任务未找到</div>;
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* 任务信息卡片 */}
      <div className="p-4 rounded-lg border border-surface-700 bg-surface-800">
        <div className="flex items-center gap-2 mb-2">
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: statusColor[task.status] ?? '#6b7280' }}
          />
          <span className="text-sm font-semibold text-text-primary">{task.description || task.taskId}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px] text-text-secondary">
          <div>任务 ID: <span className="font-mono text-text-muted">{task.taskId.slice(0, 16)}</span></div>
          <div>Trace ID: <span className="font-mono text-text-muted">{task.traceId.slice(0, 16)}</span></div>
          <div>状态: {task.status}</div>
          <div>创建: {new Date(task.createdAt).toLocaleString()}</div>
        </div>
        {task.result && (
          <div className="mt-3 p-2 rounded bg-surface-900 text-[11px] text-text-secondary">
            结果: {task.result}
          </div>
        )}
      </div>

      {/* 任务操作 */}
      <div className="p-4 rounded-lg border border-surface-700 bg-surface-800">
        <div className="text-xs font-semibold text-text-secondary mb-3">任务操作</div>
        {task.status === 'running' || task.status === 'submitted' ? (
          <button
            className="px-3 py-1.5 text-xs rounded border border-danger/30 text-danger
                       hover:bg-danger/10 transition-colors"
            onClick={() => useTaskStore.getState().cancelTask(task.taskId)}
          >
            取消任务
          </button>
        ) : (
          <div className="text-[11px] text-text-muted">该任务已结束，无法操作</div>
        )}
      </div>
    </div>
  );
}
