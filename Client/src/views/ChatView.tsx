/**
 * ChatView — 对话视图（简化版）
 *
 * 对齐 Canvas 原型：主容器内容区直接渲染 turn-based 对话流。
 * 无 Agent 卡片网格、无 ConversationSidebar、无自带 header。
 * 标题由 MainContainer.TitleBar 统一显示。
 *
 * 结构：
 *   <AIEventBus>
 *     <MessageList />   ← 对话区（唯一滚动区）
 *     <Composer />      ← 底部输入框
 *   </AIEventBus>
 */
import { useState, useEffect, useCallback } from 'react';
import { useChatStore, type WorkingMode } from '@/stores/chatStore';
import { usePrefsStore } from '@/stores/prefsStore';
import { send } from '@/services/eventBusBridge';
import { AIEventBus } from '@/ai-components/AIEventBus';
import MessageList from '@/components/Chat/MessageList';
import Composer from '@/components/Chat/Composer';

export default function ChatView() {
  const {
    messages, streamingMessageId,
    activeConversationId, activeAgentSessionId,
    selectedModel, selectedWorkingMode, availableModels,
    hydrateSessions, hydrateMessages,
    sendMessage, beginStream, stopStream,
    fetchModels, setSelectedModel, setSelectedWorkingMode,
  } = useChatStore();
  const setPref = usePrefsStore((s) => s.setPref);

  const [chatKey, setChatKey] = useState(0);

  // 偏好变更同时记入 prefsStore（供账号上传；模型/工作方式属于可同步偏好）
  const handleSelectModel = useCallback((model: string) => {
    setSelectedModel(model);
    setPref('selectedModel', model);
  }, [setSelectedModel, setPref]);

  const handleSelectWorkingMode = useCallback((mode: WorkingMode) => {
    setSelectedWorkingMode(mode);
    setPref('selectedWorkingMode', mode);
  }, [setSelectedWorkingMode, setPref]);

  // ── 初始化 ──
  useEffect(() => { hydrateSessions(); fetchModels(); }, []);
  useEffect(() => {
    if (activeAgentSessionId) hydrateMessages(activeAgentSessionId);
  }, [activeAgentSessionId]);

  // ── 发送消息 ──
  const handleSend = useCallback(async (content: string, model?: string, workingMode?: WorkingMode) => {
    if (!activeAgentSessionId) return;
    await sendMessage(activeAgentSessionId, content);
    const streamMsgId = beginStream(activeAgentSessionId, model ?? selectedModel);
    send({
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
      send({ type: 'stop_generation', payload: { messageId: streamingMessageId } });
    }
  }, [streamingMessageId]);

  // ── 派生数据 ──
  const activeMessages = messages[activeAgentSessionId ?? ''] ?? [];
  const isStreaming = streamingMessageId !== null;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {activeAgentSessionId ? (
        <AIEventBus sessionId={activeAgentSessionId}>
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
            availableModels={availableModels}
            selectedModel={selectedModel}
            selectedWorkingMode={selectedWorkingMode}
            onSelectModel={handleSelectModel}
            onSelectWorkingMode={handleSelectWorkingMode}
          />
        </AIEventBus>
      ) : (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          选择一个对话开始
        </div>
      )}
    </div>
  );
}
