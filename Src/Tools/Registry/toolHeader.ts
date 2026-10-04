/**
 * @module Tools/Registry/toolHeader
 * @description 工具头部（`tools` 参数）的**冻结**与**探索**机制。
 *
 * 为什么需要（设计依据：MongoTerminalAgent v2.0 的工具头部冻结 + 统一派发器）：
 *  OpenAI 兼容接口把 `tools` 放在请求**最前面**（在所有 messages 之前），因此：
 *  - 一旦头部工具集合或顺序发生变化，从该点起的**前缀缓存全部失效**；
 *  - 若一开始就注入全部工具（本项目当前 12 个，未来会持续增长），头部体积与抖动都随之膨胀。
 *
 * 因此采用：
 *  ① **头部只放"热工具"（默认 ~10 个）+ 通用元工具**（`tool.execute` / `tool.search`），
 *     会话内**字节级不变**（排序确定、可冻结）；
 *  ② 其余工具由 Agent **探索**：`tool.search` 返回匹配工具的 schema，
 *     这些 schema 作为**工具结果追加到消息尾部**（不进入头部），因此不破坏前缀；
 *  ③ 执行统一走 `toolDispatcher.dispatchToolCall` —— 它按名字派发**任意已注册工具**，
 *     不要求该工具出现在头部，从而让"探索到即可用"成立。
 *
 * 安全边界：属于头部的热工具会各自经过安全门（审批/副作用日志）；
 * 经 `tool.execute` 间接受控执行的工具**只允许 SAFE / CONTROLLED**，
 * DANGEROUS 工具必须出现在头部（否则安全门看不到它，无法审批）——见 `toolExecutor.ts`。
 */

import { getAllToolSpecs } from './toolRegistry.js';
import { isSpecVisibleForRole } from '../Factory/toolFactory.js';
import type { ToolSpec } from '../Traits/toolSpec.js';
import type { UserRole } from '../../Infra/types.js';
import { logger } from '../../Infra/Logging/logger.js';

/**
 * 热工具默认清单（头部冻结集）。
 *
 * 选取原则：覆盖"读-写-跑-搜-计划"主链路，且都是高频工具；
 * 可通过配置覆盖（见 `Configs/tools.json → tools.hot`），但**同一会话内必须保持恒定**。
 */
export const DEFAULT_HOT_TOOLS: readonly string[] = [
  'file.read',
  'file.write',
  'file.edit',
  'dir.list',
  'file.grep',
  'shell.exec',
  'todo.write',
  'web.search',
  'tool.search',
  'tool.execute',
];

/** 元工具（永远在头部，保证"探索→执行"闭环可用） */
export const META_TOOLS: readonly string[] = ['tool.search', 'tool.execute'];

export interface ToolHeaderOptions {
  /** 覆盖热工具清单（为空则用 DEFAULT_HOT_TOOLS） */
  hotTools?: readonly string[];
  /** 是否包含元工具（默认包含） */
  includeMeta?: boolean;
}

/** 启动期注入的配置（配置驱动）；禁止在会话运行中调用，否则头部会抖动、破坏前缀缓存 */
let headerConfig: { hotTools?: readonly string[]; maxHeaderTools?: number } = {};

/** 启动期注入热工具配置（由 `Configs/tools.json` 驱动） */
export function setToolHeaderConfig(cfg: { hotTools?: readonly string[]; maxHeaderTools?: number }): void {
  headerConfig = { ...cfg };
}

/** 测试/诊断用：清除配置（回退到默认） */
export function resetToolHeaderConfig(): void {
  headerConfig = {};
}

/**
 * 构造**冻结**的工具头部（`tools` 参数内容）。
 *
 * 特性（保证前缀稳定）：
 *  - 只含热工具 + 元工具，与"注册了多少工具"无关；
 *  - **按名称排序**，与会话、轮次、注册顺序无关 → 同一会话内字节恒定；
 *  - 过滤掉当前角色无权使用的工具（角色是会话级常量，不会逐轮变化）。
 */
export function buildToolHeader(role: UserRole, options: ToolHeaderOptions = {}): ToolSpec[] {
  // 优先级：调用参数 > 启动期配置 > 默认常量
  const resolvedHot = options.hotTools && options.hotTools.length > 0
    ? options.hotTools
    : headerConfig.hotTools && headerConfig.hotTools.length > 0
      ? headerConfig.hotTools
      : DEFAULT_HOT_TOOLS;
  const hot = new Set(resolvedHot);
  if (options.includeMeta !== false) for (const m of META_TOOLS) hot.add(m);

  let result = getAllToolSpecs()
    .filter((spec) => hot.has(spec.name))
    .filter((spec) => isSpecVisibleForRole(spec, role))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 兑底截断：超出上限时按名称排序取前 N 个，但元工具始终保留
  const maxTools = headerConfig.maxHeaderTools;
  if (maxTools && result.length > maxTools) {
    const metaSet = new Set(META_TOOLS);
    const metaSpecs = result.filter(s => metaSet.has(s.name));
    const nonMeta = result.filter(s => !metaSet.has(s.name));
    const remaining = Math.max(0, maxTools - metaSpecs.length);
    result = [...nonMeta.slice(0, remaining), ...metaSpecs].sort((a, b) => a.name.localeCompare(b.name));
    logger.warn('工具头部超出上限，已截断', {
      source: 'toolHeader/buildToolHeader',
      maxHeaderTools: maxTools,
      original: result.length,
      truncated: result.length,
    });
  }

  return result;
}

/** 头部之外的工具（需经探索发现） */
export function listDiscoverableSpecs(role: UserRole, options: ToolHeaderOptions = {}): ToolSpec[] {
  const inHeader = new Set(buildToolHeader(role, options).map((s) => s.name));
  return getAllToolSpecs()
    .filter((spec) => !inHeader.has(spec.name))
    .filter((spec) => isSpecVisibleForRole(spec, role))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 探索工具：按关键词/用途在**全部**工具中检索（含已在头部的），返回可追加进上下文的 schema 摘要。
 *
 * 支持：名称子串、描述子串、按类别（如 `write` / `read` / `execute` 前缀）匹配；空查询返回前 N 个。
 */
export function searchToolSpecs(
  query: string,
  role: UserRole,
  limit = 5,
): Array<{ name: string; description: string; dangerLevel: string; parameters: unknown; inHeader: boolean }> {
  const header = new Set(buildToolHeader(role).map((s) => s.name));
  const q = query.trim().toLowerCase();
  const all = getAllToolSpecs().filter((s) => isSpecVisibleForRole(s, role));

  const scored = all
    .map((s) => {
      const name = s.name.toLowerCase();
      const desc = s.description.toLowerCase();
      let score = 0;
      if (q === '') score = 1;
      else {
        if (name === q) score += 100;
        if (name.includes(q)) score += 50;
        if (desc.includes(q)) score += 20;
        // 前缀类别匹配：`file` 命中 `file.read` / `file.write`
        if (name.split('.')[0] === q) score += 40;
      }
      return { spec: s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.spec.name.localeCompare(b.spec.name))
    .slice(0, Math.max(1, Math.min(limit, 20)));

  return scored.map(({ spec }) => ({
    name: spec.name,
    description: spec.description,
    dangerLevel: spec.dangerLevel,
    parameters: spec.inputSchema,
    inHeader: header.has(spec.name),
  }));
}
