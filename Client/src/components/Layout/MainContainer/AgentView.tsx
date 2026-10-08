/**
 * AgentView —— L1 Agent 对话视图（设计规格 §4.2.4）。
 *
 * 2026-10-07 实装：此前这里是**占位视图**（"待集成 AIEventBus + Subscribe 事件驱动渲染"），
 * 所以从右侧 Agent 列表点进来只看到一页"开发中"。现在接入真实数据：
 *  - **历史事件**：`GET /api/sessions/:sessionId/ai-events`（按会话取，切换会话重新拉）
 *  - **实时事件**：全局事件缓冲 `eventStore`（由 eventBusBridge 订阅 `backend-event` 写入）
 *  - 两者合并、按 `agentId` 归属过滤、按时间排序，渲染成该 Agent 的事件时间线。
 *
 * 归属判定：后端事件里的 Agent 标识位置不统一（`data.agentId` / `data.workerAgentId` /
 * 嵌套 `data.data.agentId` …），因此对一组已知键名做浅层 + 一层嵌套匹配；
 * 完全不带 Agent 归属的事件（如 `agent:chat_message` 的用户消息）不计入单个 Agent 的时间线。
 */

import { useEffect, useMemo, useState } from 'react';
import { Activity, Clock, Cpu, Radio } from 'lucide-react';

import { useUIStore } from '@/stores/uiStore';
import { useAgentStore } from '@/stores/agentStore';
import { useChatStore } from '@/stores/chatStore';
import { useEventStore } from '@/stores/eventStore';
import { apiGet } from '@/services/api';

/** 事件里可能承载 Agent 归属的字段名（覆盖后端已出现的各种 payload） */
const AGENT_ID_KEYS = [
  'agentId', 'workerAgentId', 'fromAgentId', 'targetAgentId', 'sourceAgentId',
  'arbitratorId', 'directorAgentId', 'reviewerAgentId', 'partnerAgentId',
] as const;

interface RawEvent {
  id?: string;
  type: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

/** 取事件里所有可能的 Agent 标识（浅层 + 一层嵌套 `data.data`） */
function agentIdsOf(event: RawEvent): string[] {
  const found: string[] = [];
  const collect = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    const record = obj as Record<string, unknown>;
    for (const key of AGENT_ID_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) found.push(value);
    }
  };
  collect(event.data);
  collect(event.data?.['data']);
  return found;
}

/** 事件预览文本：优先取语义字段，否则给紧凑 JSON（截断） */
function previewOf(event: RawEvent): string {
  const candidates = ['content', 'text', 'summary', 'message', 'taskId', 'title', 'hookName', 'reason'];
  const containers = [event.data, event.data?.['data'] as Record<string, unknown> | undefined];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const key of candidates) {
      const value = (container as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) {
        return value.replace(/\s+/g, ' ').slice(0, 160);
      }
    }
  }
  try {
    const compact = JSON.stringify(event.data ?? {});
    return compact.length > 160 ? `${compact.slice(0, 160)}…` : compact;
  } catch {
    return '(无法序列化)';
  }
}

function formatTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function AgentView() {
  const mainView = useUIStore((s) => s.mainView);
  const agents = useAgentStore((s) => s.agents);
  const sessionId = useChatStore((s) => s.activeSessionId);
  const liveEvents = useEventStore((s) => s.events);

  const agentId = mainView.type === 'agent' ? mainView.id : '';
  const [history, setHistory] = useState<RawEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 历史事件：按会话加载（无会话/无 agentId 时不请求）
  useEffect(() => {
    if (!agentId || !sessionId) { setHistory([]); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiGet<{ events?: RawEvent[]; total?: number }>(`/api/sessions/${sessionId}/ai-events`)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setHistory(Array.isArray(result.data?.events) ? result.data.events : []);
        } else {
          setError(result.error.message);
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [agentId, sessionId]);

  const agent = agents.find((a) => a.agentId === agentId);

  // 合并历史 + 实时，去重后按归属过滤、按时间排序
  const timeline = useMemo(() => {
    const merged = new Map<string, RawEvent>();
    const put = (event: RawEvent, index: number): void => {
      const key = event.id ?? `${event.type}-${event.timestamp}-${index}`;
      if (!merged.has(key)) merged.set(key, event);
    };
    history.forEach(put);
    (liveEvents as unknown as RawEvent[]).forEach(put);

    return [...merged.values()]
      .filter((event) => agentIdsOf(event).includes(agentId))
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [history, liveEvents, agentId]);

  if (mainView.type !== 'agent') return null;

  const byType = timeline.reduce<Record<string, number>>((acc, event) => {
    acc[event.type] = (acc[event.type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-3 p-4 h-full min-h-0">
      {/* Agent 信息卡 */}
      <div className="p-4 rounded-lg border border-surface-700 bg-surface-800">
        <div className="flex items-center gap-2 mb-2">
          <Cpu size={14} className="text-brand-400" />
          <span className="text-sm font-semibold text-text-primary">{agentId}</span>
          {agent && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-900 text-text-secondary">
              {agent.role} · {agent.status}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-secondary">
          {agent?.model && <span>模型: {agent.model}</span>}
          {agent?.trustLevel && <span>信任等级: {agent.trustLevel}</span>}
          <span>会话: {sessionId ?? '（未选择会话）'}</span>
          <span>本视图事件: {timeline.length}</span>
        </div>
      </div>

      {/* 事件时间线 */}
      <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-surface-700 bg-surface-800 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-700 shrink-0">
          <Activity size={13} className="text-brand-400" />
          <span className="text-xs font-medium text-text-primary">Agent 事件时间线</span>
          {liveEvents.length > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-emerald-400">
              <Radio size={10} /> 实时
            </span>
          )}
          <span className="ml-auto text-[10px] text-text-muted">
            {Object.entries(byType).slice(0, 4).map(([type, n]) => `${type}×${n}`).join(' · ')}
          </span>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {loading && <div className="text-[11px] text-text-muted">正在加载该会话的事件…</div>}
          {error && <div className="text-[11px] text-amber-400">加载失败：{error}</div>}

          {!loading && !error && timeline.length === 0 && (
            <div className="text-[11px] text-text-muted leading-relaxed">
              <div>该 Agent 在当前会话暂无归属事件。</div>
              <div className="mt-1">
                说明：只展示**明确标注了本 Agent 归属**的事件（`agentId` / `workerAgentId` / `fromAgentId` 等）；
                不带 Agent 归属的会话级事件（例如用户输入、通用 hook）不计入单个 Agent 的时间线。
              </div>
            </div>
          )}

          {timeline.map((event, index) => (
            <div
              key={event.id ?? `${event.type}-${event.timestamp}-${index}`}
              className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-surface-900/60"
            >
              <Clock size={11} className="mt-0.5 shrink-0 text-text-muted" />
              <span className="text-[10px] text-text-muted shrink-0 w-[62px]">{formatTime(event.timestamp)}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-900 text-brand-300 shrink-0 max-w-[190px] truncate" title={event.type}>
                {event.type}
              </span>
              <span className="text-[11px] text-text-secondary break-all">{previewOf(event)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
