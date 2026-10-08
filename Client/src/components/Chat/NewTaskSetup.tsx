/**
 * NewTaskSetup —— 新任务空态的"开工设置"区。
 *
 * 业务规则（2026-10-08 用户明确）：
 * - 点"新任务"后、**发送第一条消息之前**，用户要能一眼看到并设置三件事：
 *   ① 工作目录 ② 模型 ③ 工作模式；
 * - 一旦该任务产生对话，工作目录即锁定（接口层 409 拒绝），
 *   因此目录选择入口只出现在这里（空态），TitleBar 的 WorkDirBar 转为只读。
 */
import { useState } from 'react';
import { FolderOpen, Lock, Pencil, RotateCcw, Bot, Zap } from 'lucide-react';
import { useChatStore, type WorkingMode } from '@/stores/chatStore';
import { pickDirectory } from '@/services/directoryPicker';
import { WORKING_MODE_OPTIONS } from './workingModeLabels';

interface NewTaskSetupProps {
  sessionId: string;
}

export default function NewTaskSetup({ sessionId }: NewTaskSetupProps) {
  const workDir = useChatStore(
    (s) => s.sessions.find((x) => x.session_id === sessionId)?.work_dir ?? null,
  );
  const setWorkDir = useChatStore((s) => s.setWorkDir);
  const availableModels = useChatStore((s) => s.availableModels);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const selectedWorkingMode = useChatStore((s) => s.selectedWorkingMode);
  const setSelectedWorkingMode = useChatStore((s) => s.setSelectedWorkingMode);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (next: string | null) => {
    setBusy(true);
    setError(null);
    const result = await setWorkDir(sessionId, next);
    setBusy(false);
    if (!result.ok) setError(result.error ?? '工作目录更新失败');
  };

  const handlePick = async () => {
    const picked = await pickDirectory(workDir);
    if (picked === null) return;
    await apply(picked.trim() === '' ? null : picked.trim());
  };

  const rowClass = 'flex items-center gap-2 py-1.5';
  const labelClass = 'flex items-center gap-1.5 w-20 flex-shrink-0 text-[11px] text-text-muted';
  const controlClass = 'h-7 px-2 rounded-md bg-surface-700 border border-surface-600 text-text-secondary text-xs outline-none focus:border-brand-500 cursor-pointer';

  return (
    <div
      className="rounded-xl border border-surface-700 bg-surface-800/60 px-4 py-3 mb-3"
      data-testid="new-task-setup"
    >
      <div className="text-xs font-medium text-text-primary mb-1">开始一个新任务</div>
      <div className="text-[10px] text-text-muted mb-2">
        选定工作目录、模型与工作模式后发送第一条消息；<span className="text-text-secondary">发送后工作目录将锁定</span>。
      </div>

      {/* ① 工作目录 */}
      <div className={rowClass}>
        <span className={labelClass}>
          <FolderOpen size={11} />
          工作目录
        </span>
        <span className="flex-1 min-w-0 text-[10px] font-mono text-text-muted truncate" title={workDir ?? ''}>
          {workDir ?? '（默认目录）'}
        </span>
        <button
          type="button"
          onClick={() => { void handlePick(); }}
          disabled={busy}
          className="flex items-center gap-0.5 px-2 h-7 rounded-md text-[11px] text-text-secondary
                     bg-surface-700 hover:bg-surface-600 transition-colors disabled:opacity-50"
          title="选择工作目录（agent 只能在该目录内读写）"
        >
          <Pencil size={10} />
          {busy ? '处理中…' : '选择目录'}
        </button>
        <button
          type="button"
          onClick={() => { void apply(null); }}
          disabled={busy}
          className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted
                     hover:text-text-primary hover:bg-surface-700 transition-colors disabled:opacity-50"
          title="重置为默认工作目录"
        >
          <RotateCcw size={10} />
        </button>
      </div>

      {/* ② 模型 */}
      <div className={rowClass}>
        <span className={labelClass}>
          <Bot size={11} />
          模型
        </span>
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className={`${controlClass} flex-1 min-w-0`}
          title={selectedModel || '选择模型'}
          aria-label="选择模型"
        >
          <option value="">默认模型</option>
          {availableModels.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {/* ③ 工作模式 */}
      <div className={rowClass}>
        <span className={labelClass}>
          <Zap size={11} />
          工作模式
        </span>
        <select
          value={selectedWorkingMode}
          onChange={(e) => setSelectedWorkingMode(e.target.value as WorkingMode)}
          className={`${controlClass} flex-1 min-w-0`}
          title="工作模式"
          aria-label="选择工作模式"
        >
          {WORKING_MODE_OPTIONS.map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-1 mt-1 text-[10px] text-text-muted/80">
        <Lock size={10} />
        发送第一条消息后，本任务的目录不可再更改（需换目录请新建任务）
      </div>
      {error && <div className="mt-1 text-[10px] text-danger">{error}</div>}
    </div>
  );
}
