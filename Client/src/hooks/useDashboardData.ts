/**
 * useDashboardData hook——大屏数据聚合。
 * 定时轮询 dashboard + WS 增量。
 */
import { useEffect } from "react";
import { useSystemStore } from "@/stores/systemStore";
import { useAgentStore } from "@/stores/agentStore";
import { useTaskStore } from "@/stores/taskStore";
import { useUiNumber } from "@/config/uiSettings";

export function useDashboardData() {
  const dashboard = useSystemStore((s) => s.dashboard);
  const lastUpdated = useSystemStore((s) => s.lastUpdated);
  const agents = useAgentStore((s) => s.agents);
  const tasks = useTaskStore((s) => s.tasks);

  // ui.dashboardPollIntervalSec 的真实消费方（设置面板改这里即刻生效）
  const pollMs = useUiNumber("dashboardPollIntervalSec", 5) * 1000;

  useEffect(() => {
    useSystemStore.getState().hydrate();
    useAgentStore.getState().hydrate();
    useTaskStore.getState().hydrate();

    const timer = setInterval(() => {
      useSystemStore.getState().hydrate();
    }, pollMs);

    return () => clearInterval(timer);
  }, [pollMs]);

  return { dashboard, agents, tasks, lastUpdated };
}
