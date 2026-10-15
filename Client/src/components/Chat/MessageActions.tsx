/**
 * MessageActions——助手消息的操作行。
 *
 * P0-4 收口口径：**只保留真有去处的动作**。原先的四个按钮里只有复制能落地：
 * - 赞/踩（已移除）：后端没有任何反馈落库通道（`Src/Interface` 无 feedback 路由，
 *   消息表无对应列），原先只在组件内存里变色 → 刷新即消失，是假反馈；
 * - 重新生成（已移除）：没有"删除末条回复"的接口，重发只会在历史里多出一条重复
 *   user 消息并留下两条助手回复 → 污染上下文与审计链。
 *   要恢复它，需要先有 `DELETE /api/messages/:id`（或等价的截断接口）。
 */
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import type { ChatMessage } from '@/stores/chatStore';

interface MessageActionsProps {
  msg: ChatMessage;
}

/**
 * 复制正文。
 *
 * `navigator.clipboard` 只在**安全上下文**可用：Electron 与 http://localhost 算，
 * 浏览器形态经局域网 http 访问时是 undefined（本项目支持 allowRemoteAccess）。
 * 那时退回临时 textarea + execCommand，至少按钮不会"点了没反应"。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒（浏览器可能要求用户手势上下文）→ 走兜底
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export default function MessageActions({ msg }: MessageActionsProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  if (msg.role !== 'assistant' || msg.status === 'streaming') return null;

  const handleCopy = async () => {
    const ok = await copyText(msg.content);
    // 失败也要说清楚：静默失败正是这次收口要消灭的那类假动作
    setState(ok ? 'copied' : 'failed');
    setTimeout(() => setState('idle'), 2000);
  };

  return (
    <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <button
        type="button"
        onClick={() => { void handleCopy(); }}
        className={`flex items-center gap-1 p-1 rounded hover:bg-surface-700 transition-colors ${
          state === 'failed' ? 'text-danger' : 'text-text-muted hover:text-text-secondary'
        }`}
        title={state === 'failed' ? '复制失败：浏览器拒绝了剪贴板权限' : '复制回复内容'}
        aria-label="复制回复内容"
      >
        {state === 'copied'
          ? <><Check size={12} className="text-success" /><span className="text-[10px] text-success">已复制</span></>
          : <Copy size={12} />}
      </button>
    </div>
  );
}
