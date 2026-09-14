/**
 * useDashboardData hook——大屏数据聚合。
 * 定时轮询 dashboard + WS 增量。
 */
import { useEffect } from 'react';
import { useSystemStore } from '@/stores/systemStore';
import { useAgentStore } from '@/stores/agentStore';
import { useTaskStore } from '@/stores/taskStore';

const POLL_INTERVAL = 5000; // dashboardPollIntervalSec

export function useDashboardData() {
  const dashboard = useSystemStore(s => s.dashboard);
  const lastUpdated = useSystemStore(s => s.lastUpdated);
  const agents = useAgentStore(s => s.agents);
  const tasks = useTaskStore(s => s.tasks);

  useEffect(() => {
    useSystemStore.getState().hydrate();
    useAgentStore.getState().hydrate();
    useTaskStore.getState().hydrate();

    const timer = setInterval(() => {
      useSystemStore.getState().hydrate();
    }, POLL_INTERVAL);

    return () => clearInterval(timer);
  }, []);

  return { dashboard, agents, tasks, lastUpdated };
}
