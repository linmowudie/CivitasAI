/**
 * TodoPanel —— 右侧常驻「计划」面板。
 *
 * 多 agent 语义（关键）：
 *  系统里存在**多个 agent，且部分是平级关系**，因此计划按**来源 agent 归属**展示：
 *   - 顶部是 agent 切换条（每个 agent 一个 chip，含角色与 x/y 进度），平级 agent 可逐个查看；
 *   - 当前 agent 的计划按状态渲染：completed / in_progress / pending，并显示整体进度条；
 *   - 数据实时来自 `agent:todo_updated` 事件，重启后由 `ai_events` 回放重建。
 */
import { useEffect } from 'react';
import { CheckCircle2, Circle, Loader2, ListTodo, Trash2 } from 'lucide-react';
import { useTodoStore, selectActiveGroup, type TodoItem } from '@/stores/todoStore';
import { useChatStore } from '@/stores/chatStore';

/** agent 角色 → 中文标签（未知角色原样显示） */
const ROLE_LABEL: Record<string, string> = {
  prime_director: '主控',
  arbitrator: '仲裁',
  auditor: '审计',
  partner: '协作',
  worker: '执行',
  assembly_node: '装配',
  reviewer: '评审',
};

function roleLabel(role?: string): string {
  if (!role) return 'agent';
  return ROLE_LABEL[role] ?? role;
}

function StatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') return <CheckCircle2 size={13} className="text-success flex-shrink-0 mt-0.5" />;
  if (status === 'in_progress') return <Loader2 size={13} className="text-brand-400 animate-spin flex-shrink-0 mt-0.5" />;
  return <Circle size={13} className="text-text-muted flex-shrink-0 mt-0.5" />;
}

export default function TodoPanel() {
  const sessionId = useChatStore((s) => s.activeAgentSessionId ?? s.activeSessionId);
  const { groupsBySession, selectedAgentBySession, hydrate, selectAgent, clear } = useTodoStore();
  const groups = sessionId ? groupsBySession[sessionId] ?? [] : [];
  const active = selectActiveGroup({ groupsBySession, selectedAgentBySession } as never, sessionId);

  // 切换会话/打开面板时拉取一次（事件回放已写入的部分会被库里的权威数据校正）
  useEffect(() => {
    if (sessionId) void hydrate(sessionId);
  }, [sessionId]);

  if (!sessionId) {
    return <div className="p-3 text-[11px] text-text-muted">未选中任务</div>;
  }

  const groupsWithTodos = groups.filter((g) => g.todos.length > 0);

  if (groupsWithTodos.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 px-4 text-center text-text-muted">
        <ListTodo size={28} />
        <div className="text-[11px] leading-relaxed">
          当前任务还没有计划清单。
          <br />
          Agent 使用 <span className="text-text-secondary font-mono">todo.write</span> 工具规划多步任务后，
          这里会按**来源 agent** 分组显示进度。
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* agent 切换条：平级 agent 各一个 chip（角色 + 进度） */}
      <div className="flex-shrink-0 flex flex-wrap gap-1 p-2 border-b border-surface-700">
        {groupsWithTodos.map((g) => {
          const isActive = active?.agentId === g.agentId;
          return (
            <button
              key={g.agentId}
              onClick={() => sessionId && selectAgent(sessionId, g.agentId)}
              title={`${g.agentId}\n${g.progress.completed}/${g.progress.total} 已完成`}
              className={`px-2 py-1 rounded text-[10px] border transition-colors ${
                isActive
                  ? 'border-brand-500/60 bg-brand-500/10 text-brand-400'
                  : 'border-surface-600 text-text-secondary hover:text-text-primary'
              }`}
            >
              <span className="font-medium">{roleLabel(g.agentRole)}</span>
              <span className="ml-1 text-text-muted">
                {g.progress.completed}/{g.progress.total}
              </span>
              {g.progress.inProgress > 0 && (
                <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse align-middle" />
              )}
            </button>
          );
        })}
      </div>

      {active && (
        <>
          {/* 进度总览 */}
          <div className="flex-shrink-0 px-3 py-2 border-b border-surface-700">
            <div className="flex items-center justify-between text-[10px] text-text-muted mb-1">
              <span className="font-mono truncate" title={active.agentId}>{active.agentId}</span>
              <span>
                {active.progress.completed}/{active.progress.total}
                {active.progress.inProgress > 0 && ` · ${active.progress.inProgress} 进行中`}
              </span>
            </div>
            <div className="h-1 rounded bg-surface-700 overflow-hidden">
              <div
                className="h-full bg-brand-500 transition-all"
                style={{ width: `${active.progress.total === 0 ? 0 : Math.round((active.progress.completed / active.progress.total) * 100)}%` }}
              />
            </div>
          </div>

          {/* 计划条目 */}
          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            {active.todos.map((t) => (
              <div key={t.todoId} className="flex items-start gap-2 px-1 py-1.5 text-[11px] leading-relaxed">
                <StatusIcon status={t.status} />
                <span className={t.status === 'completed' ? 'text-text-muted line-through' : 'text-text-primary'}>
                  {t.content}
                </span>
              </div>
            ))}
          </div>

          {/* 清空（仅清当前 agent 的计划） */}
          <div className="flex-shrink-0 px-2 py-1.5 border-t border-surface-700 flex justify-end">
            <button
              className="flex items-center gap-1 text-[10px] text-text-muted hover:text-danger transition-colors"
              title="清空该 agent 的计划"
              onClick={() => sessionId && void clear(sessionId, active.agentId)}
            >
              <Trash2 size={11} />
              清空该 agent 计划
            </button>
          </div>
        </>
      )}
    </div>
  );
}
