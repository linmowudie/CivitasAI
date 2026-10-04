/**
 * useApprovalPolling —— 待审批数据的共享轮询（兜底）。
 *
 * 为什么主要靠事件、轮询只兜底：
 * - Electron 模式下后端事件经 IPC 推给前端，`approvalStore.applyEvent`
 *   在 `loop:approval_requested/decided` 时即时刷新；
 * - 浏览器模式没有事件下行通道，才需要轮询兜底。
 *
 * 间隔取 30s 的原因：后端 API 限流为 30 次/分钟 × burst 1.5 = 45 次/分钟/每 IP
 * （Configs/supervision.json → supervision.rateLimit）。5s 轮询会占掉 12 次/分钟，
 * 叠加应用其他请求会触发 429，导致审批决策等写操作失败。
 *
 * 多个组件（左面板角标 + 审批视图）同时使用时只保留一个定时器（引用计数）。
 */
import { useEffect } from 'react';
import { useApprovalStore } from '@/stores/approvalStore';

let pollRefs = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function useApprovalPolling(intervalMs = 30_000): void {
  const hydrate = useApprovalStore((s) => s.hydrate);

  useEffect(() => {
    hydrate();
    pollRefs += 1;
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        void useApprovalStore.getState().hydrate();
      }, intervalMs);
    }
    return () => {
      pollRefs -= 1;
      if (pollRefs <= 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  }, [hydrate, intervalMs]);
}
