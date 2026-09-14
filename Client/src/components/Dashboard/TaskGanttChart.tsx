/**
 * TaskGanttChart — 任务/子任务时间线甘特图。
 * 回答的问题：任务从提交到完成经历了多长时间？各阶段耗时分布如何？
 *
 * 数据源：taskStore.tasks（task:assigned/task:progress/task:completed 事件增量）
 * 无数据时显示"暂无"而非空坐标系。
 */
import { useEffect, useMemo } from 'react';
import { useTaskStore, type TaskRecord } from '@/stores/taskStore';

interface TaskGanttChartProps {
  question?: string;
}

const STATUS_COLORS: Record<string, string> = {
  submitted: '#f59e0b',  // 橙：等待
  running: '#3b82f6',    // 蓝：执行中
  completed: '#10b981',  // 绿：完成
  failed: '#ef4444',     // 红：失败
  cancelled: '#6b7280',  // 灰：取消
};

interface GanttBar {
  taskId: string;
  description: string;
  status: string;
  startTime: number;
  endTime: number;
  duration: number;
  x: number;
  width: number;
}

export default function TaskGanttChart({ question = '任务从提交到完成经历了多长时间？各阶段耗时分布如何？' }: TaskGanttChartProps) {
  const tasks = useTaskStore(s => s.tasks);
  const hydrate = useTaskStore(s => s.hydrate);

  useEffect(() => {
    hydrate();
  }, []);

  // 计算甘特图数据
  const { bars, timeRange, hasData } = useMemo(() => {
    if (tasks.length === 0) return { bars: [], timeRange: { start: 0, end: 0 }, hasData: false };

    // 只展示最近 10 个任务
    const recentTasks = tasks.slice(-10);

    // 计算时间范围
    const times = recentTasks.flatMap(t => [t.createdAt, t.completedAt ?? Date.now()]);
    const start = Math.min(...times);
    const end = Math.max(...times);
    const totalDuration = end - start || 1; // 避免除零

    const chartWidth = 500;
    const barHeight = 24;
    const barGap = 8;

    const bars: GanttBar[] = recentTasks.map((task, i) => {
      const taskStart = task.createdAt;
      const taskEnd = task.completedAt ?? Date.now();
      const duration = taskEnd - taskStart;

      const x = ((taskStart - start) / totalDuration) * chartWidth;
      const width = Math.max(4, (duration / totalDuration) * chartWidth);

      return {
        taskId: task.taskId,
        description: task.description,
        status: task.status,
        startTime: taskStart,
        endTime: taskEnd,
        duration,
        x,
        width,
      };
    });

    return { bars, timeRange: { start, end }, hasData: true };
  }, [tasks]);

  if (!hasData) {
    return (
      <div className="card">
        <h3 className="text-sm font-semibold text-text-primary mb-1">任务时间线</h3>
        <p className="text-[10px] text-text-muted mb-3 italic">「{question}」</p>
        <div className="flex items-center justify-center h-48 text-text-muted text-sm">
          暂无任务数据
        </div>
      </div>
    );
  }

  const chartWidth = 500;
  const chartHeight = bars.length * 32 + 20;
  const labelWidth = 120;

  // 格式化时间
  const formatTime = (ms: number) => {
    const date = new Date(ms);
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-text-primary mb-1">任务时间线</h3>
      <p className="text-[10px] text-text-muted mb-3 italic">「{question}」</p>

      <div className="overflow-x-auto">
        <svg width={chartWidth + labelWidth + 80} height={chartHeight} className="min-w-full">
          {/* 时间轴刻度 */}
          {[0, 0.25, 0.5, 0.75, 1].map(pct => {
            const time = timeRange.start + (timeRange.end - timeRange.start) * pct;
            const x = labelWidth + pct * chartWidth;
            return (
              <g key={pct}>
                <line x1={x} y1={10} x2={x} y2={chartHeight - 10} stroke="currentColor" strokeOpacity={0.1} />
                <text x={x} y={8} textAnchor="middle" className="text-[8px] fill-text-muted">
                  {formatTime(time)}
                </text>
              </g>
            );
          })}

          {/* 任务条 */}
          {bars.map((bar, i) => {
            const y = 20 + i * 32;
            const color = STATUS_COLORS[bar.status] ?? STATUS_COLORS.submitted;

            return (
              <g key={bar.taskId}>
                {/* 任务标签 */}
                <text
                  x={labelWidth - 8}
                  y={y + 14}
                  textAnchor="end"
                  className="text-[10px] fill-text-secondary"
                >
                  {bar.description.length > 12 ? bar.description.slice(0, 12) + '…' : bar.description}
                </text>

                {/* 任务条 */}
                <rect
                  x={labelWidth + bar.x}
                  y={y + 4}
                  width={bar.width}
                  height={20}
                  fill={color}
                  fillOpacity={0.7}
                  rx={3}
                />

                {/* 耗时标签 */}
                <text
                  x={labelWidth + bar.x + bar.width + 4}
                  y={y + 16}
                  className="text-[9px] fill-text-muted"
                >
                  {formatDuration(bar.duration)}
                </text>

                {/* 状态指示 */}
                <circle
                  cx={labelWidth + bar.x + 8}
                  cy={y + 14}
                  r={3}
                  fill="white"
                  fillOpacity={0.8}
                />
              </g>
            );
          })}
        </svg>
      </div>

      {/* 统计 */}
      <div className="mt-3 flex items-center gap-4 text-[10px] text-text-muted font-mono">
        <span>共 {tasks.length} 任务</span>
        <span>·</span>
        <span>{tasks.filter(t => t.status === 'completed').length} 完成</span>
        <span>·</span>
        <span>{tasks.filter(t => t.status === 'running').length} 进行中</span>
      </div>
    </div>
  );
}
