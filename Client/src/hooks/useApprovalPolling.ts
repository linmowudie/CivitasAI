/**
 * useApprovalPolling —— 待审批数据的共享轮询（兜底）。
 *
 * 为什么主要靠事件、轮询只兜底：
 * - Electron 模式下后端事件经 IPC 推给前端，`approvalStore.applyEvent`
 *   在 `loop:approval_requested/decided` 时即时刷新；
 * - 浏览器模式没有事件下行通道，才需要轮询兜底。
 *
 * 间隔来自 `ui.approvalQueueRefreshSec`（设置面板可调，真实消费方就是这里）。
 * 预算约束写在 schema 的 constraint 上：后端限流为 30 次/分钟 × burst 1.5
 * （Configs/supervision.json → supervision.rateLimit），轮询调得过低会挤占写操作配额。
 *
 * 多个组件（左面板角标 + 审批视图）同时使用时只保留一个定时器（引用计数）。
 */
import { useEffect } from "react";
import { useApprovalStore } from "@/stores/approvalStore";
import { useUiNumber } from "@/config/uiSettings";

let pollRefs = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function useApprovalPolling(intervalMs?: number): void {
  const hydrate = useApprovalStore((s) => s.hydrate);
  const configuredMs = useUiNumber("approvalQueueRefreshSec", 30) * 1000;
  const interval = intervalMs ?? configuredMs;

  useEffect(() => {
    hydrate();
    pollRefs += 1;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      void useApprovalStore.getState().hydrate();
    }, interval);
    return () => {
      pollRefs -= 1;
      if (pollRefs <= 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  }, [hydrate, interval]);
}
