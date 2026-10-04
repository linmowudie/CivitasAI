/**
 * @module Interface/RestApi/toolsApi
 * @description
 * Tools API——自定义工具与内置工具只读视图。
 * 前端 FeatureView custom-tools 子视图数据源。
 */

import { json, registerRoute } from './router.js';
import { getAllToolSpecs } from '../../Tools/Registry/toolRegistry.js';

/** 工具信息类型 */
export interface ToolInfo {
  name: string;
  description: string;
  dangerLevel: string;
  idempotent: boolean;
  reversible: boolean;
  isBuiltin: boolean;
  requiredRoles: string[];
}

function listTools(query: Record<string, string>): ToolInfo[] {
  try {
    const allTools = getAllToolSpecs();
    const filter = query['type']; // 'builtin' | 'custom' | undefined(全部)

    // 注：ToolSpec 无 builtin/custom 标记，全部注册工具均视为 builtin。
    // 请求 'custom' 时无独立自定义工具标记，返回空列表。
    if (filter === 'custom') return [];

    return allTools.map((t) => ({
      name: t.name,
      description: t.description,
      dangerLevel: t.dangerLevel,
      idempotent: t.idempotency !== 'NO',
      reversible: t.reversibility === 'REVERSIBLE',
      isBuiltin: true,
      requiredRoles: [...t.requiredRoles],
    }));
  } catch {
    return [];
  }
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerToolsRoutes(): void {
  registerRoute('GET', '/api/tools', async (req) => {
    const tools = listTools(req.query);
    return json({ items: tools, total: tools.length });
  });

  registerRoute('GET', '/api/tools/custom', async (req) => {
    req.query['type'] = 'custom';
    const tools = listTools(req.query);
    return json({ items: tools, total: tools.length });
  });
}
