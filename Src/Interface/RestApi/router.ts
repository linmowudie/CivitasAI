/**
 * @module Interface/RestApi/router
 * @description
 * 轻量级路由解析与请求/响应类型——Phase 0-2 无 Express 依赖。
 * REST API handler 均为纯函数：接收解析后的参数，返回 JSON 数据。
 */

// ── HTTP 方法 ────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

// ── 请求/响应 ────────────────────────────────────────────────────────

export interface ApiRequest {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;     // 路径参数
  query: Record<string, string>;      // 查询参数
  body: Record<string, unknown>;      // 请求体
}

export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type ApiHandler = (req: ApiRequest) => Promise<ApiResponse> | ApiResponse;

// ── 响应辅助 ────────────────────────────────────────────────────────

export function json(data: unknown, status = 200): ApiResponse {
  return { status, body: { ok: true, data } };
}

export function apiError(message: string, status = 400): ApiResponse {
  return { status, body: { ok: false, error: message } };
}

// ── 路由注册表 ──────────────────────────────────────────────────────

interface RouteEntry {
  method: HttpMethod;
  pattern: RegExp;
  paramNames: string[];
  handler: ApiHandler;
}

const routes: RouteEntry[] = [];

export function registerRoute(method: HttpMethod, path: string, handler: ApiHandler): void {
  const paramNames: string[] = [];
  const patternStr = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({
    method,
    pattern: new RegExp(`^${patternStr}$`),
    paramNames,
    handler,
  });
}

// ── 路由匹配 ────────────────────────────────────────────────────────

export function matchRoute(method: HttpMethod, path: string): {
  handler: ApiHandler;
  params: Record<string, string>;
} | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });

    return { handler: route.handler, params };
  }
  return null;
}

// ── 解析查询字符串 ──────────────────────────────────────────────────

export function parseQuery(search: string): Record<string, string> {
  const query: Record<string, string> = {};
  if (!search) return query;
  const params = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of params.split('&')) {
    const [key, value] = pair.split('=');
    if (key) query[decodeURIComponent(key)] = decodeURIComponent(value ?? '');
  }
  return query;
}

// ── 清除路由（测试用）──────────────────────────────────────────────

export function clearRoutes(): void {
  routes.length = 0;
}
