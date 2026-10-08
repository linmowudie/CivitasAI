/**
 * @module Services/A2A/attach
 * @description A2A **启动装配**（P0a 后端）—— 把各同步/守卫挂到既有运行时上。
 *
 * 装配项：
 *  1. `cardSync.attachAgentCardSync()` —— 注册表 ↔ Agent Card 同步（§18 #2/#3）；
 *  2. `memoryGuard.attachMemoryChannelGuard()` —— 记忆侧通道守卫（§16 C7-B / RM4 / RM7）。
 *
 * 为什么集中在一处：注册表与 GlobalWorkspace 都**不静态依赖** A2A（避免 Core→Services 与
 * SharedMemory↔A2A 双向环），启动时由本模块单向注入；`main.ts` 只调用一个函数。
 */

import { attachAgentCardSync, detachAgentCardSync, reconcileAgentCards } from './cardSync.js';
import { attachMemoryChannelGuard, detachMemoryChannelGuard } from './memoryGuard.js';
import { logger } from '../../Infra/Logging/logger.js';

let attached = false;

/**
 * 装配 A2A 治理面（幂等）。
 * @param options.reconcile 是否执行回灌对账（启动路径建议 true；测试可关）
 */
export function attachA2AGovernance(options: { reconcile?: boolean } = {}): void {
  if (attached) return;
  attachAgentCardSync();
  attachMemoryChannelGuard();
  attached = true;
  if (options.reconcile ?? true) {
    try {
      const stats = reconcileAgentCards();
      if (stats.issued || stats.synced || stats.destroyed) {
        logger.info(`[A2A] 卡片回灌对账：补签 ${stats.issued}｜同步 ${stats.synced}｜标记销毁 ${stats.destroyed}`);
      }
    } catch (e) {
      // fail-safe 保留，但**必须留痕**：对账失败会造成卡片与注册表不一致（治理面问题），
      // 静默吞掉后没人知道需要人工介入。
      logger.warn('[A2A] 卡片回灌对账失败（治理面可能不一致）', {
        source: 'a2a/attach',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  logger.info('[A2A] 治理面已装配（卡片同步 + 记忆通道守卫）');
}

/** 卸载（测试/热重载/关停） */
export function detachA2AGovernance(): void {
  detachAgentCardSync();
  detachMemoryChannelGuard();
  attached = false;
}

/** 是否已装配（诊断用） */
export function isA2AGovernanceAttached(): boolean {
  return attached;
}
