/**
 * NewTaskButton —— 左侧面板顶部新任务按钮。
 * 设计规格：§3.1
 *
 * 行为（2026-10-01 修复"假新任务"）：
 * 点击后**真正创建会话**（POST /api/sessions，后端同时为该会话创建默认工作目录
 * `<项目根>/Data/workspaces/<sessionId>/`），并把它设为当前会话、切到对话视图。
 * 原实现只做 `setMainView({type:'conversation'})`，消息会继续留在旧会话里。
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useUIStore } from '@/stores/uiStore';
import { useChatStore } from '@/stores/chatStore';

export default function NewTaskButton() {
  const setMainView = useUIStore((s) => s.setMainView);
  const createSession = useChatStore((s) => s.createSession);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    const sessionId = await createSession();
    setCreating(false);

    if (!sessionId) {
      setError('创建任务失败，请检查后端服务');
      return;
    }
    setMainView({ type: 'conversation' });
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        className="mx-3 py-2 rounded-md border border-surface-700 bg-surface-800
                   text-xs font-medium text-brand-400
                   hover:bg-surface-700 hover:border-brand-500/30 transition-colors
                   disabled:opacity-60 disabled:cursor-not-allowed
                   flex items-center justify-center gap-1.5"
        onClick={handleClick}
        disabled={creating}
      >
        {creating && <Loader2 size={12} className="animate-spin" />}
        {creating ? '创建中…' : '+ 新任务'}
      </button>
      {error && (
        <span className="mx-3 text-[10px] text-danger">{error}</span>
      )}
    </div>
  );
}
