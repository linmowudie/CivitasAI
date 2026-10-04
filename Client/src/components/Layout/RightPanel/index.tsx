/**
 * RightPanel —— 右侧副容器。
 * 设计规格：§5
 *
 * 结构：
 *   1. 预览选项标签栏（6 种）
 *   2. 预览内容容器（PreviewCache 缓存已访问标签的 DOM）
 */
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useUIStore, type PreviewKind } from '@/stores/uiStore';
import PreviewCache from './PreviewCache';
import TodoPanel from './TodoPanel';
import { GovernancePanel } from './GovernancePanel';
import AgentPreview from './AgentPreview';

const previewOptions: { id: PreviewKind; label: string; icon: string }[] = [
  { id: 'agent', label: 'L1 Agent', icon: '◉' },
  { id: 'subagent', label: 'SubAgent', icon: '◎' },
  // 计划清单：按**来源 agent** 分组展示（多 agent 平级，可切换查看）
  { id: 'plan', label: '计划', icon: '☑' },
  // 治理记录：谁以何身份做了什么治理动作（放行/拒绝都留痕）
  { id: 'governance', label: '治理', icon: '⚖' },
  { id: 'terminal', label: '终端', icon: '▸' },
  { id: 'summary', label: '概要', icon: '☰' },
  { id: 'fileview', label: '文件查看', icon: '📂' },
  { id: 'filepreview', label: '文件预览', icon: '👁' },
];

export default function RightPanel() {
  const {
    rightPanelOpen, toggleRightPanel,
    activePreview, setActivePreview,
    visitedTabs, markTabVisited,
  } = useUIStore();

  if (!rightPanelOpen) {
    return (
      <button
        onClick={() => toggleRightPanel(true)}
        className="absolute right-2 top-2 z-10 w-6 h-6 flex items-center justify-center
                   rounded bg-surface-800 text-text-muted hover:text-text-primary
                   hover:bg-surface-700 transition-colors cursor-pointer"
        title="展开右侧面板"
      >
        <PanelRightOpen size={14} />
      </button>
    );
  }

  const handleTabClick = (kind: PreviewKind) => {
    setActivePreview(kind);
    markTabVisited(kind);
  };

  return (
    <div className="flex flex-col h-full bg-surface-900 border-l border-surface-700 relative">
      {/* 折叠按钮 */}
      <button
        onClick={() => toggleRightPanel(false)}
        className="absolute right-2 top-2 z-10 w-6 h-6 flex items-center justify-center
                   rounded bg-surface-800 text-text-muted hover:text-text-primary
                   hover:bg-surface-700 transition-colors cursor-pointer"
        title="收起右侧面板"
      >
        <PanelRightClose size={14} />
      </button>

      {/*
        预览选项标签栏：**自适应网格**。
        组件数量会持续增长（L1 Agent / SubAgent / 计划 / 终端 / 概要 / 文件…），
        平铺换行会随数量增加而挤压、难读，因此改为等宽网格：
        - 列数由 `auto-fit + minmax(下限, 1fr)` 自动决定：面板拉宽 → 列数变多，收窄 → 列数变少；
        - **不硬编码列数**；下限 `--panel-tab-min` 只是"文字可读性下限"（见 index.css），
          不是列数约束，窗口/面板尺寸变化时形状会随之变化。
      */}
      <div
        className="flex-shrink-0 grid gap-1 p-1.5 pt-8 border-b border-surface-700"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(var(--panel-tab-min), 1fr))' }}
      >
        {previewOptions.map((opt) => (
          <button
            key={opt.id}
            className={`
              flex items-center justify-center gap-1 min-w-0 px-1.5 py-1 rounded text-[10px] transition-colors
              ${activePreview === opt.id
                ? 'bg-brand-500/15 text-brand-400 border border-brand-500/30'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-700/50 border border-transparent'}
            `}
            onClick={() => handleTabClick(opt.id)}
          >
            <span className="text-[9px]">{opt.icon}</span>
            <span className="truncate">{opt.label}</span>
          </button>
        ))}
      </div>

      {/* 预览内容容器（缓存已访问标签） */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
        {visitedTabs.has('agent') && (
          <PreviewCache visible={activePreview === 'agent'}>
            <AgentPreview />
          </PreviewCache>
        )}
        {visitedTabs.has('subagent') && (
          <PreviewCache visible={activePreview === 'subagent'}>
            <div className="flex-1 p-3 text-[11px] text-text-muted text-center">
              SubAgent 预览 — 待实现
            </div>
          </PreviewCache>
        )}
        {visitedTabs.has('plan') && (
          <PreviewCache visible={activePreview === 'plan'}>
            {/* 计划面板：按来源 agent 分组（多 agent 平级，可切换查看） */}
            <TodoPanel />
          </PreviewCache>
        )}
        {visitedTabs.has('governance') && (
          <PreviewCache visible={activePreview === 'governance'}>
            {/* 治理记录：审批/审计/仲裁/监管/广播的留痕（拒绝同样可见） */}
            <GovernancePanel />
          </PreviewCache>
        )}
        {visitedTabs.has('terminal') && (
          <PreviewCache visible={activePreview === 'terminal'}>
            <div className="flex-1 p-3 font-mono text-[11px] text-text-muted bg-surface-950">
              <div>$ 终端预览 — 待实现</div>
            </div>
          </PreviewCache>
        )}
        {visitedTabs.has('summary') && (
          <PreviewCache visible={activePreview === 'summary'}>
            <div className="flex-1 p-3 text-[11px] text-text-muted text-center">
              概要预览 — 待实现
            </div>
          </PreviewCache>
        )}
        {visitedTabs.has('fileview') && (
          <PreviewCache visible={activePreview === 'fileview'}>
            <div className="flex-1 p-3 text-[11px] text-text-muted text-center">
              文件查看 — 待实现
            </div>
          </PreviewCache>
        )}
        {visitedTabs.has('filepreview') && (
          <PreviewCache visible={activePreview === 'filepreview'}>
            <div className="flex-1 p-3 text-[11px] text-text-muted text-center">
              文件预览 — 待实现
            </div>
          </PreviewCache>
        )}
      </div>
    </div>
  );
}
