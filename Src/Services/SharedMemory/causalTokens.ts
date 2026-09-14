/**
 * @module SharedMemory/causalTokens
 * @description
 * 因果一致性令牌——Docs/07 §8.2。
 * 记录 Agent 写入时的 happens-before 关系，用于仲裁时重建因果链。
 */

// ── 向量时钟 ────────────────────────────────────────────────────────

export type VectorClock = Map<string, number>;

/**
 * 合并两个向量时钟（取各分量最大值）
 */
export function mergeClocks(a: VectorClock, b: VectorClock): VectorClock {
  const merged: VectorClock = new Map(a);
  for (const [agentId, tick] of b) {
    const current = merged.get(agentId) ?? 0;
    merged.set(agentId, Math.max(current, tick));
  }
  return merged;
}

/**
 * 检查 a 是否 happens-before b（a 的所有分量 ≤ b，且至少一个 <）
 */
export function happensBefore(a: VectorClock, b: VectorClock): boolean {
  let strictlyLess = false;
  const allKeys = new Set([...a.keys(), ...b.keys()]);
  for (const key of allKeys) {
    const va = a.get(key) ?? 0;
    const vb = b.get(key) ?? 0;
    if (va > vb) return false;
    if (va < vb) strictlyLess = true;
  }
  return strictlyLess;
}

/**
 * 检查两个向量时钟是否并发（互不 happens-before）
 */
export function isConcurrent(a: VectorClock, b: VectorClock): boolean {
  return !happensBefore(a, b) && !happensBefore(b, a) && !clocksEqual(a, b);
}

function clocksEqual(a: VectorClock, b: VectorClock): boolean {
  const allKeys = new Set([...a.keys(), ...b.keys()]);
  for (const key of allKeys) {
    if ((a.get(key) ?? 0) !== (b.get(key) ?? 0)) return false;
  }
  return true;
}

/**
 * 递增指定 Agent 的时钟分量
 */
export function incrementClock(clock: VectorClock, agentId: string): VectorClock {
  const next = new Map(clock);
  next.set(agentId, (next.get(agentId) ?? 0) + 1);
  return next;
}

/**
 * 将向量时钟序列化为 causalTokens 字符串数组
 */
export function clockToTokens(clock: VectorClock): string[] {
  const tokens: string[] = [];
  for (const [agentId, tick] of clock) {
    tokens.push(`${agentId}:${tick}`);
  }
  return tokens.sort();
}

/**
 * 从 causalTokens 字符串数组恢复向量时钟
 */
export function tokensToClock(tokens: string[]): VectorClock {
  const clock: VectorClock = new Map();
  for (const token of tokens) {
    const [agentId, tickStr] = token.split(':');
    if (agentId && tickStr) {
      clock.set(agentId, parseInt(tickStr, 10));
    }
  }
  return clock;
}
