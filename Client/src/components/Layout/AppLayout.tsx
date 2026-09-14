/**
 * AppLayout——侧边导航 + 离线横幅 + 底部状态栏 + 主内容区。
 * F1.6：从 App.tsx 抽出布局骨架。
 */
import { Routes, Route, NavLink } from 'react-router-dom';
import {
  MessageSquare, LayoutDashboard, Cpu, ListTodo, ShieldCheck, Bug,
  Scale, GitBranch, Activity, Wallet, Settings,
} from 'lucide-react';
import ChatView from '@/views/ChatView';
import Dashboard from '@/views/Dashboard';
import AgentMonitor from '@/views/AgentMonitor';
import TaskPanel from '@/views/TaskPanel';
import ApprovalQueue from '@/views/ApprovalQueue';
import LoopDebugger from '@/views/LoopDebugger';
import ArbitrationView from '@/views/ArbitrationView';
import TraceReplay from '@/views/TraceReplay';
import TokenLedger from '@/views/TokenLedger';
import SystemConfig from '@/views/SystemConfig';
import OfflineBanner from './OfflineBanner';
import StatusBar from './StatusBar';
import { useWebSocket } from '@/hooks/useWebSocket';

const navItems = [
  { to: '/chat', icon: MessageSquare, label: 'Agent 对话' },
  { to: '/', icon: LayoutDashboard, label: '总控大屏' },
  { to: '/agents', icon: Cpu, label: 'Agent 监控' },
  { to: '/tasks', icon: ListTodo, label: '任务面板' },
  { to: '/approvals', icon: ShieldCheck, label: '审批队列' },
  { to: '/loop-debug', icon: Bug, label: 'Loop 调试' },
  { to: '/arbitration', icon: Scale, label: '仲裁中心' },
  { to: '/trace', icon: GitBranch, label: '链路回放' },
  { to: '/token-ledger', icon: Wallet, label: 'Token 账本' },
  { to: '/system-config', icon: Settings, label: '系统配置' },
];

export default function AppLayout() {
  // 全局 WS 连接（仅挂载一次）
  useWebSocket();

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── 侧边导航 ──────────────────────────────────── */}
      <aside className="w-[200px] flex-shrink-0 flex flex-col border-r border-surface-700 bg-surface-900">
        {/* Logo */}
        <div className="px-4 py-5 flex items-center gap-2.5 border-b border-surface-700">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center">
            <Activity size={16} className="text-white" />
          </div>
          <div>
            <div className="text-sm font-bold text-text-primary tracking-tight">Civitas-AI</div>
            <div className="text-[10px] text-text-muted font-mono">智体城邦 v0.1.0</div>
          </div>
        </div>

        {/* 导航项 */}
        <nav className="flex-1 px-2 py-3 flex flex-col gap-0.5">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `nav-item ${isActive ? 'active' : ''}`
              }
            >
              <item.icon size={16} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* ── 主内容区 ──────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <OfflineBanner />
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/chat" element={<ChatView />} />
            <Route path="/agents" element={<AgentMonitor />} />
            <Route path="/tasks" element={<TaskPanel />} />
            <Route path="/approvals" element={<ApprovalQueue />} />
            <Route path="/loop-debug" element={<LoopDebugger />} />
            <Route path="/arbitration" element={<ArbitrationView />} />
            <Route path="/trace" element={<TraceReplay />} />
            <Route path="/token-ledger" element={<TokenLedger />} />
            <Route path="/system-config" element={<SystemConfig />} />
          </Routes>
        </main>
        <StatusBar />
      </div>
    </div>
  );
}
