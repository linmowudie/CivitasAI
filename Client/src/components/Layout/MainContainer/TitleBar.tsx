/**
 * TitleBar —— 主容器动态标题栏。
 * 设计规格：§4.1
 */
import { useUIStore, type MainView } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';
import { useChatStore } from '@/stores/chatStore';
import WorkDirBar from './WorkDirBar';
import { MessageSquare, ListTodo, Cpu, Settings } from 'lucide-react';

const featureTitles: Record<string, { title: string; desc: string }> = {
  'approvals': { title: '人工审批', desc: '工具安全门产生的审批请求' },
  'loop-tasks': { title: 'Loop 任务管理', desc: '循环执行任务的状态与进度' },
  'harness': { title: 'Harness 工程检查', desc: '质量门禁与验证状态' },
  'memory': { title: '共享记忆', desc: 'Agent 间共享的上下文与知识' },
  'data-hub': { title: '数据中台', desc: '数据资源管理与服务' },
  'skills': { title: 'Skill 技能', desc: '已安装的 Agent 技能' },
  'mcp': { title: 'MCP 服务', desc: 'Model Context Protocol 连接' },
  'custom-tools': { title: '自定义工具', desc: '用户自定义的外部工具' },
  'profile': { title: '个人信息', desc: '账号基本资料' },
  'settings': { title: '系统设置', desc: '偏好与配置管理' },
};

function getViewInfo(mainView: MainView): { icon: React.ReactNode; title: string; desc: string } {
  switch (mainView.type) {
    case 'conversation':
      return { icon: <MessageSquare size={14} />, title: 'Agent 对话', desc: '与 Agent 进行对话' };
    case 'task': {
      const task = useTaskStore.getState().tasks.find(t => t.taskId === mainView.id);
      return {
        icon: <ListTodo size={14} />,
        title: task?.description?.slice(0, 30) ?? '任务详情',
        desc: `任务 ${mainView.id.slice(0, 12)}`,
      };
    }
    case 'feature': {
      const info = featureTitles[mainView.id];
      return {
        icon: <Settings size={14} />,
        title: info?.title ?? mainView.id,
        desc: info?.desc ?? '',
      };
    }
    case 'agent':
      return { icon: <Cpu size={14} />, title: mainView.id, desc: 'L1 Agent 对话视图' };
    default:
      return { icon: <MessageSquare size={14} />, title: '未知视图', desc: '' };
  }
}

export default function TitleBar() {
  const mainView = useUIStore((s) => s.mainView);
  const activeSessionId = useChatStore((s) => s.activeAgentSessionId);
  const info = getViewInfo(mainView);

  return (
    <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-surface-700 bg-surface-900">
      <span className="text-brand-400">{info.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-text-primary truncate">{info.title}</div>
        {info.desc && (
          <div className="text-[10px] text-text-muted truncate">{info.desc}</div>
        )}
      </div>
      {/* 当前会话工作目录（仅对话视图显示） */}
      {mainView.type === 'conversation' && activeSessionId && (
        <WorkDirBar sessionId={activeSessionId} />
      )}
    </div>
  );
}
