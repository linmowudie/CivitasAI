/**
 * TaskList —— 左侧面板任务列表。
 * 设计规格：§3.1（三栏工作界面）
 *
 * 2026-10-01 修复（FE-018 连带）：
 * 原先列表只读后台 `tasks`（`/api/tasks`），而「+ 新任务」创建的是**会话**
 * （`chat_sessions`），因此新建任务后任务栏始终「暂无任务」。
 * 现在主列表展示**会话任务**（= 用户视角的任务），点击即切换当前会话；
 * 后台任务若存在，单独归入「后台任务」分组，保留原有入口。
 *
 * 2026-10-03 新增：**任务归档**（软状态）。
 *  - 单条归档/取消归档：悬停出现归档按钮（浅色，不干扰列表）；
 *  - 「已归档 (N)」分区默认收起，展开后可取消归档恢复；
 *  - 归档不删除任何消息，任务仍可打开；归档状态会同步到服务端（`user_tasks`），
 *    因此备份/重装后归档状态可以恢复。
 */
import { useEffect, useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, ChevronRight } from 'lucide-react';
import { useTaskStore, type TaskRecord } from '@/stores/taskStore';
import { useChatStore } from '@/stores/chatStore';
import { useUIStore } from '@/stores/uiStore';

const statusColor: Record<string, string> = {
  submitted: '#3b82f6',
  running: '#f59e0b',
  completed: '#10b981',
  failed: '#ef4444',
  cancelled: '#6b7280',
};

const statusLabel: Record<string, string> = {
  submitted: '已提交',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** 相对时间（分钟/小时/天） */
function formatUpdatedAt(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export default function TaskList() {
  const { tasks, loading, hydrate } = useTaskStore();
  const {
    sessions, archivedSessions, activeAgentSessionId,
    hydrateSessions, archiveSession,
    setActiveSession, setActiveConversation, setActiveAgent,
  } = useChatStore();
  const { mainView, setMainView } = useUIStore();
  // 已归档分区默认收起（旧任务不干扰当前工作）
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    hydrateSessions();
    hydrate();
  }, []);

  const openSession = (sessionId: string) => {
    setActiveSession(sessionId);
    setActiveConversation(sessionId);
    setActiveAgent(sessionId);
    setMainView({ type: 'conversation' });
  };

  const renderSession = (
    sessionId: string,
    title: string,
    updatedAt: number,
    status: string,
    archived = false,
  ) => {
    const isActive = activeAgentSessionId === sessionId && mainView.type === 'conversation';
    const displayTitle = title && title !== 'New Chat' ? title : '新任务（未命名）';
    return (
      <div
        key={sessionId}
        className={`
          group flex items-center gap-2 pr-2 transition-colors
          ${isActive ? 'bg-brand-500/10 text-brand-400' : 'text-text-secondary hover:bg-surface-700/50 hover:text-text-primary'}
        `}
      >
        <button
          className="flex-1 min-w-0 flex items-center gap-2 px-4 py-1.5 text-xs text-left"
          onClick={() => openSession(sessionId)}
          title={`${displayTitle}\n${sessionId}${archived ? '\n（已归档）' : ''}`}
        >
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ background: archived ? '#6b7280' : status === 'active' ? '#10b981' : '#6b7280' }}
          />
          <span className="flex-1 text-left truncate">{displayTitle}</span>
          <span className="text-[10px] text-text-muted flex-shrink-0">{formatUpdatedAt(updatedAt)}</span>
        </button>
        {/* 归档 / 取消归档（悬停显示，避免列表噪音） */}
        <button
          className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-surface-600"
          title={archived ? '取消归档（恢复到任务列表）' : '归档（从列表收起，可随时恢复）'}
          onClick={(e) => {
            e.stopPropagation();
            void archiveSession(sessionId, !archived);
          }}
        >
          {archived
            ? <ArchiveRestore size={12} className="text-text-muted hover:text-brand-400" />
            : <Archive size={12} className="text-text-muted hover:text-brand-400" />}
        </button>
      </div>
    );
  };

  const renderBackendTask = (task: TaskRecord) => {
    const isActive = mainView.type === 'task' && mainView.id === task.taskId;
    return (
      <button
        key={task.taskId}
        className={`
          w-full flex items-center gap-2 px-4 py-1.5 text-xs transition-colors
          ${isActive ? 'bg-brand-500/10 text-brand-400' : 'text-text-secondary hover:bg-surface-700/50 hover:text-text-primary'}
        `}
        onClick={() => setMainView({ type: 'task', id: task.taskId })}
      >
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: statusColor[task.status] ?? '#6b7280' }}
        />
        <span className="flex-1 text-left truncate">{task.description || task.taskId.slice(0, 16)}</span>
        <span className="text-[10px] text-text-muted flex-shrink-0">{statusLabel[task.status] ?? task.status}</span>
      </button>
    );
  };

  const isEmpty = sessions.length === 0 && tasks.length === 0 && archivedSessions.length === 0 && !loading;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="px-4 py-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">任务</span>
        {loading && <span className="text-[10px] text-text-muted">加载中...</span>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {isEmpty && (
          <div className="px-4 py-3 text-[11px] text-text-muted">暂无任务，点击上方「+ 新任务」开始</div>
        )}

        {/* 会话任务（用户视角的任务） */}
        {sessions.map(s => renderSession(s.session_id, s.title, s.updated_at, s.status))}

        {/* 后台任务（/api/tasks，来自任务面板） */}
        {tasks.length > 0 && (
          <div className="mt-1 border-t border-surface-700 pt-1">
            <div className="px-4 py-1 text-[10px] font-semibold text-text-muted uppercase tracking-wider">后台任务</div>
            {tasks.map(renderBackendTask)}
          </div>
        )}

        {/* 已归档分区（默认收起；软状态，可随时恢复） */}
        {archivedSessions.length > 0 && (
          <div className="mt-1 border-t border-surface-700 pt-1">
            <button
              className="w-full px-4 py-1 flex items-center gap-1 text-[10px] font-semibold text-text-muted uppercase tracking-wider hover:text-text-primary transition-colors"
              onClick={() => setShowArchived(v => !v)}
              title={showArchived ? '收起已归档任务' : '展开已归档任务'}
            >
              {showArchived ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              <span>已归档 ({archivedSessions.length})</span>
            </button>
            {showArchived && archivedSessions.map(s =>
              renderSession(s.session_id, s.title, s.updated_at, s.status, true),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
