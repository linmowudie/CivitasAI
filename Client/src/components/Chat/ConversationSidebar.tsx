/**
 * ConversationSidebar — 右侧纵向对话列表
 *
 * 长条型纵向排列，点击切换当前对话。
 * 每项展示：对话标题、Agent 数量徽章、相对时间。
 */
import { MessageSquare, Users } from 'lucide-react';
import type { Conversation } from '@/stores/chatStore';

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}小时前`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

interface Props {
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelect: (conversationId: string) => void;
  onNewConversation: () => void;
}

export default function ConversationSidebar({
  conversations, activeConversationId, onSelect, onNewConversation,
}: Props) {
  return (
    <div className="conv-sidebar">
      {/* ── 头部 ── */}
      <div className="conv-sidebar-header">
        <div className="flex items-center gap-2">
          <MessageSquare size={14} className="text-brand-400" />
          <span className="text-xs font-bold text-text-primary">对话</span>
          <span className="text-[10px] font-mono text-text-muted">{conversations.length}</span>
        </div>
        <button className="btn-new-chat" title="新建对话" onClick={onNewConversation}>
          <span className="text-lg leading-none">+</span>
        </button>
      </div>

      {/* ── 列表 ── */}
      <div className="conv-sidebar-list">
        {conversations.length === 0 && (
          <div className="conv-sidebar-empty">
            <p>暂无对话</p>
            <p className="text-[10px] text-text-muted">点击上方 + 新建</p>
          </div>
        )}
        {conversations.map(conv => (
          <div
            key={conv.conversation_id}
            className={`conv-sidebar-item ${conv.conversation_id === activeConversationId ? 'active' : ''}`}
            onClick={() => onSelect(conv.conversation_id)}
          >
            <div className="conv-sidebar-item-avatar">
              💬
            </div>
            <div className="conv-sidebar-item-body">
              <div className="conv-sidebar-item-title" title={conv.title}>
                {conv.title}
              </div>
              <div className="conv-sidebar-item-meta">
                <span className="conv-sidebar-item-agents">
                  <Users size={9} />
                  {conv.agents.length} Agent{conv.agents.length > 1 ? 's' : ''}
                </span>
                <span className="conv-sidebar-item-time">
                  {timeAgo(conv.updated_at)}
                </span>
              </div>
            </div>
            {/* 状态圆点 */}
            <span className={`conv-sidebar-status ${conv.status}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
