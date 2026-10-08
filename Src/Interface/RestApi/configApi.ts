/**
 * @module Interface/RestApi/configApi
 * @description
 * Config API——系统配置只读视图。
 * 读取 Configs/ 目录下的 JSON 配置文件。
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { json, apiError, registerRoute } from './router.js';
import { getBundledConfigDir } from '../../Infra/Fs/pathResolver.js';

/**
 * 配置目录（**惰性**解析）。
 *
 * 历史实现是 `join(process.cwd(), 'Configs')`：安装态 `cwd` 不是程序目录，
 * 该接口会读到不存在的位置。现在统一取内置配置目录（`<APP_ROOT>/Configs`）。
 */
function configsDir(): string {
  return getBundledConfigDir();
}

/**
 * GET /api/configs — 配置列表
 */
export function listConfigs(): { name: string; size: number }[] {
  try {
    const dir = configsDir();
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    return files.map(name => {
      const stat = readFileSync(join(dir, name));
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
    const content = readFileSync(join(configsDir(), safeName), 'utf-8');
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
