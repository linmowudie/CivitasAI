/**
 * WorkDirBar —— 当前会话工作目录显示与切换。
 *
 * 规则（2026-10-01 决策）：
 * - 每个会话绑定一个工作目录，默认 `<项目根>/Data/workspaces/<sessionId>/`；
 * - 工具与 shell 均以该目录为根，agent 不能越出（见 Infra/Security/workspaceGuard）；
 * - Electron 下用原生目录选择框；浏览器下退化为路径输入。
 */
import { useState } from 'react';
import { FolderOpen, Pencil, RotateCcw } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';

interface WorkDirBarProps {
  sessionId: string;
}

/** Electron 预加载脚本暴露的目录选择能力（浏览器下不存在） */
interface ElectronDirAPI {
  pickDirectory?: () => Promise<string | null>;
}

export default function WorkDirBar({ sessionId }: WorkDirBarProps) {
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
    const applied = await setWorkDir(sessionId, next);
    setBusy(false);
    if (!applied) setError('工作目录更新失败');
  };

  const handlePick = async () => {
    const api = (window as unknown as { electronAPI?: ElectronDirAPI }).electronAPI;
    if (api?.pickDirectory) {
      const picked = await api.pickDirectory();
      if (picked) await apply(picked);
      return;
    }
    // 浏览器降级：无原生对话框，手工输入路径
    const input = window.prompt('输入工作目录绝对路径（留空 = 重置为默认目录）', workDir);
    if (input !== null) await apply(input.trim() === '' ? null : input.trim());
  };

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <FolderOpen size={12} className="text-text-muted flex-shrink-0" />
      <span
        className="text-[10px] font-mono text-text-muted truncate max-w-[320px]"
        title={`任务工作目录（agent 只能在该目录内读写）\n${workDir}`}
      >
        {workDir}
      </span>
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
      {error && <span className="text-[10px] text-danger">{error}</span>}
    </div>
  );
}
