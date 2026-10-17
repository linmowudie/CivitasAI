/**
 * 检索的 **Core 层入口**（裁定 (a)，2026-10-14 项目负责人）
 *
 * 为什么需要它：记忆检索属 Services 层，产品里此前只有 Tools 层的 `VectorSearch` 能到达它
 * （Tools 在 Services **之下**，不是上层入口），而 Core 没有任何检索调用点
 * —— 这正是 `AG-SEC-POISON`「检索器未接入 prompt」登记的事实。
 *
 * 本函数是**唯一入口**：loop 的 ⑷ ContextAssembly 与 Benchmark 实验台都调它，
 * 从而"经上层驱动"是真的（同一个入口），而不是两边各写一套。
 *
 * 层规：驱动方（Core / 实验台）位于被测层 Services **之上**；端口只是边界，
 * 读它返回什么属于**监控**，不构成驱动。
 */
import type { ContextSection } from "../../Services/Context/contextStore.js";

/** 检索端口：由组合根注入真实实现（Tools 层不得 import Services，故用原始类型） */
export type MemorySearchPortFn = (
  query: string,
  limit: number,
) => Promise<Array<{ key: string; content: string }>>;

/** 稳定键：同键同内容跳过、内容变化原位替换 → 不破坏前缀缓存 */
export const RETRIEVAL_SECTION_KEY = "ctx:memory:retrieval";

/**
 * 经 Core 入口检索，得到可写入追加式上下文的**分区**。
 * 未注入端口 / 查询为空 / 无命中 → 返回 null（调用方跳过，行为与改动前一致）。
 */
export async function retrieveForContextAssembly(
  port: MemorySearchPortFn | undefined,
  query: string,
  limit: number,
  now: number = Date.now(),
): Promise<ContextSection | null> {
  if (!port) return null;
  if (query.trim().length === 0) return null;
  const hits = await port(query, limit);
  const body = hits
    .map((h, i) => `${i + 1}. ${h.key}\n${h.content}`)
    .join("\n\n");
  if (body.trim().length === 0) return null;
  return {
    key: RETRIEVAL_SECTION_KEY,
    content: `【相关记忆（检索自长期记忆，仅供参考）】\n${body}`,
    timestamp: now,
  };
}
