/**
 * @module Interface/RestApi/configApi
 * @description
 * Config API——系统配置只读视图。
 * 读取 Configs/ 目录下的 JSON 配置文件。
 */

import { json, apiError, registerRoute } from './router.js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CONFIGS_DIR = join(process.cwd(), 'Configs');

/**
 * GET /api/configs — 配置列表
 */
export function listConfigs(): { name: string; size: number }[] {
  try {
    const files = readdirSync(CONFIGS_DIR).filter(f => f.endsWith('.json'));
    return files.map(name => {
      const stat = readFileSync(join(CONFIGS_DIR, name));
      return { name, size: stat.length };
    });
  } catch {
    return [];
  }
}

/**
 * GET /api/configs/:name — 配置详情
 */
export function getConfig(name: string): unknown | undefined {
  try {
    const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '');
    const content = readFileSync(join(CONFIGS_DIR, safeName), 'utf-8');
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerConfigRoutes(): void {
  registerRoute('GET', '/api/configs', async () => {
    return json(listConfigs());
  });

  registerRoute('GET', '/api/configs/:name', async (req) => {
    const name = req.params.name;
    if (!name) return apiError('name is required', 400);
    const config = getConfig(name);
    if (!config) return apiError('Config not found', 404);
    return json(config);
  });
}
