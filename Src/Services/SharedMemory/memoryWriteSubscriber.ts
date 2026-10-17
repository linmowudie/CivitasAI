/**
 * @module SharedMemory/memoryWriteSubscriber
 * @description `MEMORY_WRITTEN` → 记忆沉淀 的订阅链（MEMN-GAP-EVENTSUB，设计 §3.8）。
 *
 * 背景（矩阵 cell 复现）：`MEMORY_WRITTEN` 只有**发布方**（globalWorkspace.write），
 * 全仓没有任何订阅方 —— "写入事件驱动后续沉淀"这条链在运行期不存在。
 *
 * 本模块提供真实消费者：
 *  - 订阅 `MEMORY_WRITTEN`，把写入事实收进有界环形缓冲；
 *  - 供沉淀/观测面消费（`getRecentMemoryWrites` / `drainMemoryWrites`）；
 *  - 启动期由 `main.ts` 安装（进程内只安一次，重复安装幂等）；
 *  - 失败 fail-soft：订阅/记录异常只记日志，绝不影响写入主链。
 */

import { subscribe } from "../EventBus/eventBus.js";
import { EventType } from "../EventBus/eventTypes.js";
import { logger } from "../../Infra/Logging/logger.js";

/** 一条记忆写入事件（沉淀链的输入） */
export interface MemoryWriteFact {
  entryId: string;
  key: string;
  agentId: string;
  assertion?: string;
  timestamp: number;
}

/** 环形缓冲上限（只需近期事实；长期沉淀由知识层负责） */
export const MEMORY_WRITE_BUFFER_LIMIT = 500;

const recent: MemoryWriteFact[] = [];
let subscription: ReturnType<typeof subscribe> | null = null;

/** 安装订阅（幂等）。返回当前订阅者数量（含其它模块的订阅）。 */
export function installMemoryWriteSubscriber(): number {
  if (subscription) return 1;
  try {
    subscription = subscribe(EventType.MEMORY_WRITTEN, (event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      recent.push({
        entryId: String(payload["entryId"] ?? ""),
        key: String(payload["key"] ?? ""),
        agentId: String(payload["agentId"] ?? ""),
        ...(typeof payload["assertion"] === "string"
          ? { assertion: payload["assertion"] }
          : {}),
        timestamp: event.timestamp ?? Date.now(),
      });
      if (recent.length > MEMORY_WRITE_BUFFER_LIMIT) {
        recent.splice(0, recent.length - MEMORY_WRITE_BUFFER_LIMIT);
      }
    });
    logger.info("记忆写入订阅已安装", {
      source: "SharedMemory/memoryWriteSubscriber",
    });
    return 1;
  } catch (e) {
    logger.warn("记忆写入订阅安装失败（沉淀链降级）", {
      source: "SharedMemory/memoryWriteSubscriber",
      error: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
}

/** 撤销订阅（测试隔离用） */
export function uninstallMemoryWriteSubscriber(): void {
  subscription?.unsubscribe();
  subscription = null;
}

/** 近期记忆写入事实（只读副本） */
export function getRecentMemoryWrites(): MemoryWriteFact[] {
  return recent.map((r) => ({ ...r }));
}

/** 取走并清空近期事实（沉淀器消费入口） */
export function drainMemoryWrites(): MemoryWriteFact[] {
  const drained = recent.splice(0, recent.length);
  return drained;
}

/** 重置（测试用） */
export function resetMemoryWriteSubscriber(): void {
  uninstallMemoryWriteSubscriber();
  recent.length = 0;
}
