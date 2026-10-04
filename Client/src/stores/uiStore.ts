/**
 * UI 状态 store —— 三栏布局统一状态管理。
 * 设计规格：Docs/Client/02-前端改造基础/三栏自适应工作界面设计规格.md §2
 */
import { create } from 'zustand';
import { useHotReloadStore } from './hotReloadStore';

/* ── MainView 联合类型 ── */
export type MainView =
  | { type: 'conversation' }
  | { type: 'task'; id: string }
  | { type: 'feature'; id: string }
  | { type: 'agent'; id: string };

/* ── 右侧预览标签类型 ── */
export type PreviewKind = 'agent' | 'subagent' | 'plan' | 'governance' | 'terminal' | 'summary' | 'fileview' | 'filepreview';

/* ── 常量 ── */
const PANEL_MIN = 120;
const PANEL_DEFAULT = 220;

interface UIState {
  /* MainView */
  mainView: MainView;
  setMainView: (view: MainView) => void;

  /* 左侧面板 */
  leftPanelOpen: boolean;
  leftPanelWidth: number;
  toggleLeftPanel: (open?: boolean) => void;
  setLeftPanelWidth: (w: number) => void;

  /* 右侧面板 */
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  toggleRightPanel: (open?: boolean) => void;
  setRightPanelWidth: (w: number) => void;

  /* 功能列表展开状态 */
  expandedFeatures: Set<string>;
  toggleFeature: (id: string) => void;

  /* 右侧预览 */
  activePreview: PreviewKind;
  setActivePreview: (kind: PreviewKind) => void;
  visitedTabs: Set<PreviewKind>;
  markTabVisited: (kind: PreviewKind) => void;
  previewFile: string | null;
  setPreviewFile: (file: string | null) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  /* ── MainView ── */
  mainView: { type: 'conversation' },
  setMainView: (view) => {
    // 从 conversation 切走时触发 onNavigate 级热重载
    if (get().mainView.type === 'conversation' && view.type !== 'conversation') {
      useHotReloadStore.getState().flushOnNavigate();
    }
    set({ mainView: view });
  },

  /* ── 左侧面板 ── */
  leftPanelOpen: true,
  leftPanelWidth: PANEL_DEFAULT,
  toggleLeftPanel: (open) => set((s) => ({ leftPanelOpen: open ?? !s.leftPanelOpen })),
  setLeftPanelWidth: (w) => set({ leftPanelWidth: Math.max(PANEL_MIN, w) }),

  /* ── 右侧面板 ── */
  rightPanelOpen: false,
  rightPanelWidth: PANEL_DEFAULT,
  toggleRightPanel: (open) => set((s) => ({ rightPanelOpen: open ?? !s.rightPanelOpen })),
  setRightPanelWidth: (w) => set({ rightPanelWidth: Math.max(PANEL_MIN, w) }),

  /* ── 功能列表 ── */
  expandedFeatures: new Set(),
  toggleFeature: (id) =>
    set((s) => {
      const next = new Set(s.expandedFeatures);
      next.has(id) ? next.delete(id) : next.add(id);
      return { expandedFeatures: next };
    }),

  /* ── 右侧预览 ── */
  activePreview: 'agent',
  setActivePreview: (kind) => set({ activePreview: kind }),
  visitedTabs: new Set<PreviewKind>(['agent']),
  markTabVisited: (kind) =>
    set((s) => {
      const next = new Set(s.visitedTabs);
      next.add(kind);
      return { visitedTabs: next };
    }),
  previewFile: null,
  setPreviewFile: (file) => set({ previewFile: file }),
}));

/* 导出常量供其他模块使用 */
export { PANEL_MIN, PANEL_DEFAULT };
