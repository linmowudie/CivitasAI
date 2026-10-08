/**
 * ApiKeyDialog —— 「未配置 API Key」弹窗。
 *
 * 触发：后端在发消息前预检发现该模型的供应商没有可用 Key（`[MISSING_API_KEY]` 标记）。
 * 作用：不再让用户对着一轮"没有回复"发呆，而是明确说明原因并提供**一键前往设置**。
 *
 * 设计取舍：用轻量自绘弹窗（而非 window.alert），因为它要带"前往设置密钥"这个动作，
 * 并且不能阻塞渲染进程（Electron 里原生 alert 会卡住主线程观感）。
 */
import { KeyRound, X } from 'lucide-react';
import { useUIStore, type MainView } from '@/stores/uiStore';

const SETTINGS_VIEW: MainView = { type: 'feature', id: 'settings' };

export default function ApiKeyDialog() {
  const notice = useUIStore((s) => s.apiKeyNotice);
  const dismiss = useUIStore((s) => s.dismissApiKeyNotice);

  if (!notice) return null;

  const goToSettings = () => {
    // 关闭弹窗并跳到「设置」（其中挂载 ModelProviderPanel：供应商与 API Key 管理）
    useUIStore.getState().setMainView(SETTINGS_VIEW);
    dismiss();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="未配置 API Key"
      data-testid="api-key-dialog"
      onClick={dismiss}
    >
      <div
        className="w-[420px] max-w-[92vw] rounded-xl border border-surface-700 bg-surface-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-surface-700">
          <KeyRound size={16} className="text-warning" />
          <span className="flex-1 text-sm font-medium text-text-primary">未配置 API Key</span>
          <button
            type="button"
            onClick={dismiss}
            className="text-text-muted hover:text-text-primary transition-colors"
            title="关闭"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-3 text-xs leading-relaxed text-text-secondary whitespace-pre-wrap">
          {notice}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-700">
          <button
            type="button"
            onClick={dismiss}
            className="px-3 h-8 rounded-md text-xs text-text-secondary bg-surface-700 hover:bg-surface-600 transition-colors"
          >
            稍后处理
          </button>
          <button
            type="button"
            onClick={goToSettings}
            className="px-3 h-8 rounded-md text-xs text-white bg-brand-500 hover:bg-brand-600 transition-colors"
          >
            前往设置密钥
          </button>
        </div>
      </div>
    </div>
  );
}
