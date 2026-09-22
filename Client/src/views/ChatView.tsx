/**
 * ChatView — Agent 对话页面（卡片 + 侧栏布局）
 *
 * 布局结构：
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  顶部标题栏（全宽）                                       │
 *   ├────────────────────────────────────┬─────────────────────┤
 *   │  左侧主区域                          │  右侧对话列表       │
 *   │  ┌─ Agent 卡片横排（正方形） ─┐     │  （纵向长条）        │
 *   │  │  □  □  □  □              │     │                     │
 *   │  └──────────────────────────┘     │  💬 对话1  1 Agent   │
 *   │  ┌─ 聊天区域 ────────────────┐     │  💬 对话2  3 Agents  │
 *   │  │  消息列表                  │     │  💬 对话3  1 Agent   │
 *   │  │  输入框                    │     │  …                  │
 *   │  └──────────────────────────┘     │                     │
 *   └────────────────────────────────────┴─────────────────────┘
 *
 * 交互：
 *   1. 点击右侧对话项 → 切换当前对话，显示该对话的 Agent 卡片
 *   2. 点击 Agent 卡片 → 进入该 Agent 的聊天区域
 */
import { useState, useEffect, useCallback } from 'react';
import { Hash, Bot } from 'lucide-react';
import { useChatStore, type WorkingMode } from '@/stores/chatStore';
import { sendWs } from '@/services/ws';
import MessageList from '@/components/Chat/MessageList';
import Composer from '@/components/Chat/Composer';
import ConversationGrid from '@/components/Chat/ConversationGrid';
import ConversationSidebar from '@/components/Chat/ConversationSidebar';
import { WORKING_MODE_META } from '@/components/Chat/ConversationCard';

export default function ChatView() {
  const {
    messages, streamingMessageId,
    conversations, activeConversationId, activeAgentSessionId,
    selectedModel, selectedWorkingMode, availableModels,
    hydrateSessions, hydrateMessages, createSession, sendMessage,
    setActiveConversation, setActiveAgent, beginStream, stopStream,
    fetchModels, setSelectedModel, setSelectedWorkingMode,
  } = useChatStore();

  const [chatKey, setChatKey] = useState(0); // force remount on agent switch

  // ── 初始化 ──
  useEffect(() => { hydrateSessions(); fetchModels(); }, []);
  useEffect(() => {
    if (activeAgentSessionId) hydrateMessages(activeAgentSessionId);
  }, [activeAgentSessionId]);

  // ─ 发送消息 ──
  const handleSend = useCallback(async (content: string, model?: string, workingMode?: WorkingMode) => {
    if (!activeAgentSessionId) return;
    await sendMessage(activeAgentSessionId, content);
    const streamMsgId = beginStream(activeAgentSessionId, model ?? selectedModel);
    sendWs({
      type: 'generate_reply',
      payload: {
        sessionId: activeAgentSessionId,
        userMessage: content,
        messageId: streamMsgId,
        model: model ?? selectedModel,
        workingMode: workingMode ?? selectedWorkingMode,
      },
    });
  }, [activeAgentSessionId, selectedModel, selectedWorkingMode]);

  // ── 停止 ──
  const handleStop = useCallback(() => {
    if (streamingMessageId) {
      stopStream(streamingMessageId);
      sendWs({ type: 'stop_generation', payload: { messageId: streamingMessageId } });
    }
  }, [streamingMessageId]);

  // ── 新建对话 ──
  const handleNewConversation = async () => {
    const id = await createSession();
    if (id) {
      await hydrateSessions(); // re-derive conversations
      // 选中新建的对话
      const conv = useChatStore.getState().conversations.find(c => c.conversation_id === id);
      if (conv) {
        setActiveConversation(conv.conversation_id);
      }
    }
  };

  // ── 选中对话 ──
  const handleSelectConversation = (conversationId: string) => {
    setActiveConversation(conversationId);
    setChatKey(k => k + 1);
  };

  // ── 选中 Agent 卡片 → 进入聊天 ──
  const handleSelectAgent = (agentSessionId: string) => {
    setActiveAgent(agentSessionId);
    setChatKey(k => k + 1);
  };

  // ── 派生数据 ──
  const activeConversation = conversations.find(c => c.conversation_id === activeConversationId);
  const activeAgents = activeConversation?.agents ?? [];
  const activeMessages = messages[activeAgentSessionId ?? ''] ?? [];
  const isStreaming = streamingMessageId !== null;

  // 当前活跃 Agent 的信息
  const activeAgent = activeAgents.find(a => a.session_id === activeAgentSessionId);
  const activeMode = activeAgent?.working_mode ?? 'DIRECT';
  const activeModeMeta = WORKING_MODE_META[activeMode];

  return (
    <div className="chat-layout">
      {/* ══ 顶部标题栏（全宽） ══ */}
      <div className="chat-layout-header">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center text-sm">💬</div>
          <div className="flex-1 min-w-0">
            {activeConversation ? (
              <>
                <div className="text-sm font-semibold text-text-primary truncate">
                  {activeConversation.title}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-text-muted font-mono">
                  <span className="flex items-center gap-1" title="对话 ID">
                    <Hash size={9} />{activeConversation.conversation_id.slice(0, 16)}
                  </span>
                  {activeAgent && (
                    <>
                      <span className="flex items-center gap-1" title="Agent 编号">
                        <Bot size={9} />{activeAgent.agent_id.slice(0, 20)}
                      </span>
                      <span
                        className="badge font-mono"
                        style={{ background: `${activeModeMeta.color}20`, color: activeModeMeta.color }}
                      >
                        {activeModeMeta.label}
                      </span>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="text-sm text-text-muted">选择一个对话开始</div>
            )}
          </div>
        </div>
      </div>

      {/* ══ 下方主体：左侧内容 + 右侧对话列表 ══ */}
      <div className="chat-layout-body">
        {/* ── 左侧主区域 ── */}
        <div className="chat-main">
          {/* Agent 卡片横排区 */}
          <div className="chat-agents-section">
            <ConversationGrid
              agents={activeAgents}
              activeAgentSessionId={activeAgentSessionId}
              onSelectAgent={handleSelectAgent}
            />
          </div>

          {/* 聊天区域 */}
          {activeAgentSessionId && (
            <div className="chat-chat-section">
              <MessageList
                key={chatKey}
                messages={activeMessages}
                streamingMessageId={streamingMessageId}
                sessionId={activeAgentSessionId}
              />
              <Composer
                onSend={handleSend}
                onStop={handleStop}
                isStreaming={isStreaming}
                disabled={!activeAgentSessionId}
                availableModels={availableModels}
                selectedModel={selectedModel}
                selectedWorkingMode={selectedWorkingMode}
                onSelectModel={setSelectedModel}
                onSelectWorkingMode={setSelectedWorkingMode}
              />
            </div>
          )}
        </div>

        {/* ── 右侧对话列表 ── */}
        <ConversationSidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelect={handleSelectConversation}
          onNewConversation={handleNewConversation}
        />
      </div>
    </div>
  );
}
