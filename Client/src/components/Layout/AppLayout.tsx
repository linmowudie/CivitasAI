/**
 * AppLayout —— 三栏自适应工作界面布局。
 *
 * 设计规格：Docs/Client/02-前端改造基础/三栏自适应工作界面设计规格.md
 *
 * 结构：
 *   ┌────────────┬─┬──────────────────────────┬─┬────────────────┐
 *   │ 左侧副容器 │││      主容器               │││  右侧副容器     │
 *   │ (可拖拽)   │││   (flex: 1, min-w 400)   │││  (可拖拽)       │
 *   └────────────┘│└──────────────────────────┘│└────────────────┘
 *
 * 替代原侧边导航 + 主内容区二栏结构。
 * 左侧：任务列表 + 功能列表（驱动 mainView）
 * 中间：按 mainView 切换视图（conversation/task/feature/agent）
 * 右侧：预览标签（L1 Agent / SubAgent / 终端 / 概要 / 文件查看 / 文件预览）
 */
import { Routes, Route, Navigate } from 'react-router-dom';
import { useEventBus } from '@/hooks/useEventBus';
import { useUIStore } from '@/stores/uiStore';
import { useResizablePanels } from './hooks/useResizablePanels';
import LeftPanel from './LeftPanel';
import MainContainer from './MainContainer';
import RightPanel from './RightPanel';
import OfflineBanner from './OfflineBanner';

/* 非三栏工作区的独立视图（保留路由兼容） */
import Dashboard from '@/views/Dashboard';
import AgentMonitor from '@/views/AgentMonitor';
import TaskPanel from '@/views/TaskPanel';
import ApprovalQueue from '@/views/ApprovalQueue';
import LoopDebugger from '@/views/LoopDebugger';
import ArbitrationView from '@/views/ArbitrationView';
import TraceReplay from '@/views/TraceReplay';
import TokenLedger from '@/views/TokenLedger';
import SystemConfig from '@/views/SystemConfig';
import WorkingModes from '@/views/WorkingModes';

/**
 * 三栏工作区布局（用于 /chat 及 mainView 驱动的视图）
 */
function WorkspaceLayout() {
  const { leftPanelOpen, rightPanelOpen } = useUIStore();
  const { containerRef, leftPanelWidth, rightPanelWidth, startDrag, HANDLE_WIDTH } = useResizablePanels();

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 flex overflow-hidden relative"
    >
      {/* ── 左侧副容器 ── */}
      {leftPanelOpen ? (
        <>
          <div
            style={{ width: leftPanelWidth, flexShrink: 0 }}
            className="h-full min-h-0 overflow-hidden"
          >
            <LeftPanel />
          </div>
          {/* 左拖拽手柄 */}
          <div
            className="flex-shrink-0 cursor-col-resize hover:bg-brand-500/20 transition-colors"
            style={{ width: HANDLE_WIDTH }}
            onMouseDown={(e) => startDrag('left', e)}
          />
        </>
      ) : (
        /* 收起态：保留左上角展开角标（Canvas L765-779），否则面板无法恢复 */
        <LeftPanel />
      )}

      {/* ── 主容器 ── */}
      <MainContainer />

      {/* ── 右拖拽手柄 ── */}
      {rightPanelOpen ? (
        <>
          <div
            className="flex-shrink-0 cursor-col-resize hover:bg-brand-500/20 transition-colors"
            style={{ width: HANDLE_WIDTH }}
            onMouseDown={(e) => startDrag('right', e)}
          />
          <div
            style={{ width: rightPanelWidth, flexShrink: 0 }}
            className="h-full min-h-0 overflow-hidden"
          >
            <RightPanel />
          </div>
        </>
      ) : (
        /* 收起态：保留右上角展开角标（Canvas L781-795），否则第三栏无法打开 */
        <RightPanel />
      )}
    </div>
  );
}

/**
 * 独立全屏视图布局（用于非工作区路由）
 */
function StandaloneView({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {children}
    </div>
  );
}

export default function AppLayout() {
  /* 全局事件总线连接（仅挂载一次） */
  useEventBus();

  return (
    <div className="flex h-full overflow-hidden bg-surface-950">
      {/* ── 工作区卡片（圆角边框容器） ── */}
      <div className="flex-1 flex flex-col p-1">
        <div className="flex-1 flex flex-col border border-surface-700 rounded-xl overflow-hidden relative">
          <OfflineBanner />

          <Routes>
            {/* 默认路由重定向到三栏工作区 */}
            <Route path="/" element={<Navigate to="/chat" replace />} />

            {/* 三栏工作区路由 */}
            <Route path="/chat" element={<WorkspaceLayout />} />
            <Route path="/workspace" element={<WorkspaceLayout />} />

            {/* 独立视图路由（保留兼容，使用简化布局） */}
            <Route path="/dashboard" element={<StandaloneView><Dashboard /></StandaloneView>} />
            <Route path="/agents" element={<StandaloneView><AgentMonitor /></StandaloneView>} />
            <Route path="/tasks" element={<StandaloneView><TaskPanel /></StandaloneView>} />
            <Route path="/working-modes" element={<StandaloneView><WorkingModes /></StandaloneView>} />
            <Route path="/approvals" element={<StandaloneView><ApprovalQueue /></StandaloneView>} />
            <Route path="/loop-debug" element={<StandaloneView><LoopDebugger /></StandaloneView>} />
            <Route path="/arbitration" element={<StandaloneView><ArbitrationView /></StandaloneView>} />
            <Route path="/trace" element={<StandaloneView><TraceReplay /></StandaloneView>} />
            <Route path="/token-ledger" element={<StandaloneView><TokenLedger /></StandaloneView>} />
            <Route path="/system-config" element={<StandaloneView><SystemConfig /></StandaloneView>} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
