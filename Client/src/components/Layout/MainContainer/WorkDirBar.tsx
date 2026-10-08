/**
 * WorkDirBar —— 当前会话工作目录显示与切换。
 *
 * 规则：
 * - 每个会话绑定一个工作目录，默认 `<工作空间根>/workspaces/<sessionId>/`；
 * - 工具与 shell 均以该目录为根，agent 不能越出（见 Infra/Security/workspaceGuard）；
 * - **任务一旦有对话，目录即锁定**（2026-10-08 业务规则）：中途换根会让已产生的
 *   工具结果、文件引用与模型上下文里的 `[ctx:workspace]`（仍是旧目录）失效。
 *   锁定后本组件只读显示，切换入口转移到"新任务"空态（见 NewTaskSetup）。
 * - Electron 下用原生目录选择框；浏览器下退化为路径输入。
 */
import { useState } from 'react';
import { FolderOpen, Lock, Pencil, RotateCcw } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { pickDirectory } from '@/services/directoryPicker';

interface WorkDirBarProps {
  sessionId: string;
  /** 任务已有对话 → 目录只读（接口层同样会拒绝，这里只是把状态可见化） */
  locked?: boolean;
}

export default function WorkDirBar({ sessionId, locked = false }: WorkDirBarProps) {
  const workDir = useChatStore(
    (s) => s.sessions.find((x) => x.session_id === sessionId)?.work_dir ?? null,
  );
  const setWorkDir = useChatStore((s) => s.setWorkDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!workDir) return null;

  const apply = async (next: string | null) => {
    setBusy(true);
    setError(null);
    const result = await setWorkDir(sessionId, next);
    setBusy(false);
    // 后端拒绝时如实显示原因（如"该任务已有对话，工作目录不可更改"），不吞成一句"更新失败"
    if (!result.ok) setError(result.error ?? '工作目录更新失败');
  };

  const handlePick = async () => {
    const picked = await pickDirectory(workDir);
    if (picked === null) return; // 取消
    await apply(picked.trim() === '' ? null : picked.trim());
  };

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {locked
        ? <Lock size={12} className="text-text-muted flex-shrink-0" />
        : <FolderOpen size={12} className="text-text-muted flex-shrink-0" />}
      <span
        className="text-[10px] font-mono text-text-muted truncate max-w-[320px]"
        title={locked
          ? `任务工作目录（已锁定：任务已有对话，如需更换请新建任务）\n${workDir}`
          : `任务工作目录（agent 只能在该目录内读写）\n${workDir}`}
      >
        {workDir}
      </span>
      {locked ? (
        <span className="text-[10px] text-text-muted/70">已锁定</span>
      ) : (
        <>
          <button
            onClick={() => { void handlePick(); }}
            disabled={busy}
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-text-muted
                       hover:text-text-primary hover:bg-surface-700 transition-colors disabled:opacity-50"
            title="更改工作目录"
          >
            <Pencil size={10} />
            {busy ? '处理中…' : '更改'}
          </button>
          <button
            onClick={() => { void apply(null); }}
            disabled={busy}
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-text-muted
                       hover:text-text-primary hover:bg-surface-700 transition-colors disabled:opacity-50"
            title="重置为默认工作目录"
          >
            <RotateCcw size={10} />
          </button>
        </>
      )}
      {error && <span className="text-[10px] text-danger">{error}</span>}
    </div>
  );
}
