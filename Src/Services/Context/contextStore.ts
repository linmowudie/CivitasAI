/**
 * @module Services/Context/contextStore
 * @description 追加式上下文集合（ContextStore 语义）。
 *
 * 借鉴 MongoTerminalAgent v2.0 `ContextModels.py` 的追加式上下文设计：
 *  - **同键同内容 → 跳过**（不改动位置，不产生冗余）；
 *  - **同键不同内容 → 原位替换**（保持 Map 插入顺序，只更新内容）；
 *  - **新键 → 追加末尾**（变化的上下文只追加到尾部，前缀保持稳定）。
 *
 * 目的：每轮变化的上下文只追加到消息尾部，系统提示与历史消息的前缀保持字节恒定，
 * 从而命中提供商前缀缓存（实测前缀稳定 ≥90%）。
 */

import { createHash } from 'node:crypto';

/** 上下文分区：同键代表"同一主题的最新内容" */
export interface ContextSection {
  /** 唯一键，形如 `ctx:P1:file:main.ts:a3f2` */
  key: string;
  /** 分区内容 */
  content: string;
  /** 写入时间戳 */
  timestamp: number;
}

/**
 * 追加式上下文集合：保证"键→内容"的**位置稳定**。
 *
 * 使用 Map 保持插入顺序：新键追加末尾，已有键原位替换（不挪动位置）。
 */
export class ContextStore {
  private sections = new Map<string, ContextSection>();

  /**
   * 写入一个上下文分区。
   * @returns true=发生变更（新增/替换）；false=跳过（同键同内容）
   */
  put(section: ContextSection): boolean {
    const existing = this.sections.get(section.key);
    // 同键同内容 → 跳过（trim 后比较，避免空白差异导致误判）
    if (existing && existing.content.trim() === section.content.trim()) {
      return false;
    }
    // 新键 → 追加末尾；已有键 → 原位替换（Map.set 不改变已有键的插入顺序）
    this.sections.set(section.key, { ...section, content: section.content.trim() });
    return true;
  }

  /** 移除一个分区 */
  remove(key: string): boolean {
    return this.sections.delete(key);
  }

  /** 获取一个分区 */
  get(key: string): ContextSection | undefined {
    return this.sections.get(key);
  }

  /** 当前所有键（按插入顺序） */
  keys(): string[] {
    return [...this.sections.keys()];
  }

  /**
   * 增量差异：自 knownKeys 以来新增的分区与已删除的键。
   * 供调用方判断是否需要重新序列化。
   */
  diffSince(knownKeys: string[]): { added: ContextSection[]; removedKeys: string[] } {
    const knownSet = new Set(knownKeys);
    const added: ContextSection[] = [];
    const removedKeys: string[] = [];

    // 新增：在当前 sections 中但不在 knownKeys 中
    for (const [key, section] of this.sections) {
      if (!knownSet.has(key)) {
        added.push(section);
      }
    }
    // 删除：在 knownKeys 中但不在当前 sections 中
    for (const key of knownKeys) {
      if (!this.sections.has(key)) {
        removedKeys.push(key);
      }
    }

    return { added, removedKeys };
  }

  /**
   * 转成追加式消息（role: 'system'，内容前缀 `[ctx:<key>] `）。
   * 按插入顺序排列，保证位置稳定。
   */
  toAppendMessages(): Array<{ role: 'system'; content: string }> {
    const messages: Array<{ role: 'system'; content: string }> = [];
    for (const [key, section] of this.sections) {
      messages.push({
        role: 'system',
        content: `[ctx:${key}] ${section.content}`,
      });
    }
    return messages;
  }

  /** 清空所有分区 */
  clear(): void {
    this.sections.clear();
  }

  /** 当前分区数量 */
  get size(): number {
    return this.sections.size;
  }
}

/**
 * 消息指纹（role + 内容前 300 字符），用于去重校验。
 * 使用 sha256 取前 16 位十六进制。
 */
export function messageFingerprint(role: string, content: string): string {
  const hash = createHash('sha256');
  hash.update(`${role}\u0000${content.slice(0, 300)}`);
  return hash.digest('hex').slice(0, 16);
}

// ── FE-054：上下文写侧接线（文件工作集）───────────────

/** 记录到追加区的文件类工具（仅 `file.read`：其余工具结果非文件内容） */
export const WORK_SET_FILE_TOOLS: readonly string[] = ['file.read'];
/** 单条追加内容上限（字符），超出截断（保持前缀稳定与预算可控） */
export const WORK_SET_MAX_CHARS = 2000;

/**
 * 把“文件类工具”的成功结果写入追加区（FE-054 写侧接线）。
 *
 * 语义：键 = `file:<path>`——同一文件多次读取**原位替换**（位置稳定，最新内容在固定位置），
 * 这正是 ContextStore 区别于“塞进历史”的价值；非文件工具/无 path/空内容一律跳过。
 * @returns true=发生变更（新增/替换）；false=跳过
 */
export function recordFileWorkSet(
  store: ContextStore | undefined,
  toolName: string,
  args: Record<string, unknown> | undefined,
  content: string,
): boolean {
  if (!store) return false;
  if (!WORK_SET_FILE_TOOLS.includes(toolName)) return false;
  const path = typeof args?.['path'] === 'string' ? (args['path'] as string) : undefined;
  if (!path || !content) return false;
  const snapshot = content.length > WORK_SET_MAX_CHARS
    ? `${content.slice(0, WORK_SET_MAX_CHARS)}\n…(已截断，共 ${content.length} 字符)`
    : content;
  return store.put({ key: `file:${path}`, content: snapshot, timestamp: Date.now() });
}
