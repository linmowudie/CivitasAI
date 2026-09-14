/**
 * @module LoopScheduler/dedupStore
 * @description
 * 去重存储——Docs/14 §S8。
 * 防止同一事件在短时间内重复触发 Loop。
 * 60s 窗口内相同 key 仅允许首次通过。
 */

// ── 内部状态 ────────────────────────────────────────────────────────

interface DedupEntry {
  key: string;
  firstSeen: number;
  count: number;
}

const dedupMap: Map<string, DedupEntry> = new Map();
let windowMs = 60_000;

// ── 配置 ────────────────────────────────────────────────────────────

export function initDedupStore(config: { windowMs?: number } = {}): void {
  windowMs = config.windowMs ?? 60_000;
}

// ── 检查 ────────────────────────────────────────────────────────────

/**
 * 检查 key 是否允许通过（首次通过，窗口内后续拒绝）。
 * @returns true = 首次通过，false = 重复（已去重）
 */
export function checkDedup(key: string, now: number = Date.now()): boolean {
  const entry = dedupMap.get(key);

  // 无记录或已过期 → 首次
  if (!entry || (now - entry.firstSeen) > windowMs) {
    dedupMap.set(key, { key, firstSeen: now, count: 1 });
    return true;
  }

  // 窗口内重复 → 计数 + 拒绝
  entry.count++;
  return false;
}

export function getDedupCount(key: string): number {
  return dedupMap.get(key)?.count ?? 0;
}

// ── 清理 ────────────────────────────────────────────────────────────

export function purgeExpired(now: number = Date.now()): number {
  let purged = 0;
  for (const [key, entry] of dedupMap) {
    if ((now - entry.firstSeen) > windowMs) {
      dedupMap.delete(key);
      purged++;
    }
  }
  return purged;
}

export function resetDedupStore(): void {
  dedupMap.clear();
}
