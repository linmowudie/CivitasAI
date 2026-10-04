/**
 * LeftPanel —— 左侧副容器。
 * 设计规格：§3
 *
 * 结构（自顶向下）：
 *   1. 折叠按钮（左上角 tab）
 *   2. 新任务按钮
 *   3. 任务列表（按状态分组，可滚动）
 *   4. 功能列表（向上可扩展）
 */
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useUIStore } from '@/stores/uiStore';
import NewTaskButton from './NewTaskButton';
import TaskList from './TaskList';
import FeatureList from './FeatureList';

export default function LeftPanel() {
  const { leftPanelOpen, toggleLeftPanel } = useUIStore();

  if (!leftPanelOpen) {
    /* 折叠态：显示展开按钮 */
    return (
      <button
        onClick={() => toggleLeftPanel(true)}
        className="absolute left-2 top-2 z-10 w-6 h-6 flex items-center justify-center
                   rounded bg-surface-800 text-text-muted hover:text-text-primary
                   hover:bg-surface-700 transition-colors cursor-pointer"
        title="展开左侧面板"
      >
        <PanelLeftOpen size={14} />
      </button>
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface-900 border-r border-surface-700 relative">
      {/* 折叠按钮 */}
      <button
        onClick={() => toggleLeftPanel(false)}
        className="absolute left-2 top-2 z-10 w-6 h-6 flex items-center justify-center
                   rounded bg-surface-800 text-text-muted hover:text-text-primary
                   hover:bg-surface-700 transition-colors cursor-pointer"
        title="收起左侧面板"
      >
        <PanelLeftClose size={14} />
      </button>

      {/* ── 新任务按钮 ── */}
      <div className="flex-shrink-0 px-3 pt-10 pb-2">
        <NewTaskButton />
      </div>

      {/* 分隔线 */}
      <div className="border-t border-surface-700 flex-shrink-0" />

      {/* 任务列表（可滚动区域） */}
      <TaskList />

      {/* 分隔线 */}
      <div className="border-t border-surface-700 flex-shrink-0" />

      {/* 功能列表（底部） */}
      <div className="flex-shrink-0 py-2">
        <FeatureList />
      </div>
    </div>
  );
}
