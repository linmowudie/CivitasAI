/**
 * MainContainer —— 主容器（标题栏 + 内容区 + 条件输入框）。
 * 设计规格：§4
 *
 * 结构：
 *   标题栏 (flexShrink: 0) — 动态标题，根据 mainView.type 切换
 *   内容区 (flex: 1, overflowY: auto) — 按 mainView 渲染对应视图
 *   底部输入框 (flexShrink: 0) — 仅 conversation 视图显示（由 ChatView 自行管理）
 */
import { useUIStore } from '@/stores/uiStore';
import TitleBar from './TitleBar';
import TaskView from './TaskView';
import FeatureView from './FeatureView';
import AgentView from './AgentView';
import ChatView from '@/views/ChatView';

export default function MainContainer() {
  const mainView = useUIStore((s) => s.mainView);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* 标题栏 */}
      <TitleBar />

      {/*
        内容区
        - conversation：ChatView 自行管理滚动（仅对话区滚动、输入框常驻底部），
          因此这里必须是 flex 列容器，ChatView 的 flex-1 / min-h-0 才会生效。
        - 其他视图：沿用「由外层滚动」的滚动容器。
        见 Canvas L848-871：内容区 flex:1 + 对话框作为兄弟节点常驻底部。
      */}
      {mainView.type === 'conversation' ? (
        <ChatView />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {mainView.type === 'task' && <TaskView />}
          {mainView.type === 'feature' && <FeatureView />}
          {mainView.type === 'agent' && <AgentView />}
        </div>
      )}
    </div>
  );
}
