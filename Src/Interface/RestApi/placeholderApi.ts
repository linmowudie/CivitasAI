/**
 * @module Interface/RestApi/placeholderApi
 * @description
 * 占位 API 端点——为前端 FeatureView 尚未实现的子视图提供占位响应。
 * data-hub / mcp / profile 将在后续 Phase 补齐真实数据。
 */

import { json, registerRoute } from './router.js';

/**
 * 注册占位 API 路由。
 */
export function registerPlaceholderRoutes(): void {
  // GET /api/data-hub — 数据枢纽（Phase 3 实现）
  registerRoute('GET', '/api/data-hub', async () => {
    return json({ items: [], message: 'Coming in Phase 3' });
  });

  // GET /api/mcp/connections — MCP 连接列表（Phase 3 实现）
  registerRoute('GET', '/api/mcp/connections', async () => {
    return json({ items: [], message: 'Coming in Phase 3' });
  });

  // GET /api/user/profile — 用户配置（Phase 3 实现）
  registerRoute('GET', '/api/user/profile', async () => {
    return json({ items: [], message: 'Coming in Phase 3' });
  });
}
