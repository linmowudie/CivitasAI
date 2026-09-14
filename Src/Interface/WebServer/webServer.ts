/**
 * @module Interface/WebServer/webServer
 * @description
 * Web 服务器——Docs/09 §3。
 * Phase 0-2：内存请求模拟（不绑定端口）；Phase 3 接 Node http 模块。
 * 整合 REST 路由 + WebSocket 桥接。
 */

import { matchRoute, parseQuery, type HttpMethod, type ApiRequest, type ApiResponse } from '../RestApi/router.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

// ── 请求日志 ────────────────────────────────────────────────────────

export interface RequestLog {
  method: HttpMethod;
  path: string;
  status: number;
  durationMs: number;
  timestamp: number;
}

const requestLogs: RequestLog[] = [];
const MAX_LOGS = 1000;

// ── 模拟请求处理 ────────────────────────────────────────────────────

/**
 * 处理一个 HTTP 请求（Phase 0-2：纯函数模拟，不绑定端口）。
 */
export async function handleRequest(request: {
  method: HttpMethod;
  url: string;
  body?: Record<string, unknown>;
}): Promise<ApiResponse> {
  const start = Date.now();

  // 解析 URL
  const [path, search] = request.url.split('?');
  const query = parseQuery(search ?? '');

  // 路由匹配
  const matched = matchRoute(request.method, path);
  if (!matched) {
    const response: ApiResponse = {
      status: 404,
      body: { ok: false, error: `Not Found: ${request.method} ${path}` },
    };
    logRequest(request.method, path, 404, Date.now() - start);
    return response;
  }

  // 构造 ApiRequest
  const apiReq: ApiRequest = {
    method: request.method,
    path,
    params: matched.params,
    query,
    body: request.body ?? {},
  };

  // 执行 handler
  try {
    const response = await matched.handler(apiReq);
    logRequest(request.method, path, response.status, Date.now() - start);
    return response;
  } catch (error) {
    const response: ApiResponse = {
      status: 500,
      body: { ok: false, error: `Internal Error: ${error}` },
    };
    logRequest(request.method, path, 500, Date.now() - start);
    return response;
  }
}

function logRequest(method: HttpMethod, path: string, status: number, durationMs: number): void {
  requestLogs.push({ method, path, status, durationMs, timestamp: Date.now() });
  if (requestLogs.length > MAX_LOGS) requestLogs.shift();
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getRequestLogs(limit?: number): RequestLog[] {
  if (limit) return requestLogs.slice(-limit);
  return [...requestLogs];
}

export function getRequestCount(): number {
  return requestLogs.length;
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetWebServer(): void {
  requestLogs.length = 0;
}
