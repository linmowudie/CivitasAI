/**
 * @module Interface/WebServer/httpServer
 * @description
 * HTTP 服务器——Docs/16 F0.1。
 * Node 原生 `http.createServer`，绑定 `server.httpPort`(3000)。
 * - CORS（`server.corsOrigins`）
 * - 静态托管 `Client/dist`（仅生产模式；开发模式由 Vite 代理）
 * - API 路由委托给 `handleRequest()`（保留旧纯函数实现供测试）
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve, join, extname } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { handleRequest } from './webServer.js';
import type { HttpMethod } from '../RestApi/router.js';

// ── 配置 ────────────────────────────────────────────────────────────

export interface HttpServerConfig {
  host: string;
  port: number;
  corsOrigins: string[];
  /** 静态文件根目录（默认 Client/dist） */
  staticDir?: string;
}

// ── MIME 映射 ───────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ── 内部状态 ────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer> | null = null;

// ── 启动 / 停止 ────────────────────────────────────────────────────

export function startHttpServer(config: HttpServerConfig): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const staticDir = config.staticDir ?? resolve('Client/dist');

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // CORS
      const origin = req.headers.origin ?? '';
      if (config.corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '86400');
      }

      // 预检
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url ?? '/';
      const [pathPart] = url.split('?');
      const path = pathPart ?? '/';

      // API 路由（/api/*）
      if (path.startsWith('/api/')) {
        await handleApiRequest(req, res);
        return;
      }

      // 静态文件
      if (tryServeStatic(path, staticDir, res)) return;

      // SPA fallback：非 API、非静态文件 → index.html
      if (tryServeStatic('/index.html', staticDir, res)) return;

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Not Found: ${path}` }));
    });

    server.listen(config.port, config.host, () => {
      // 启动成功
    });

    server.on('error', (e) => {
      reject(e);
    });

    // 立即 resolve（端口绑定是异步的，但此处不阻塞启动链）
    resolvePromise();
  });
}

export function stopHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => { server = null; resolve(); });
  });
}

// ── API 请求处理 ────────────────────────────────────────────────────

async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 读取 body
  let body = '';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
  }

  let parsedBody: Record<string, unknown> = {};
  if (body) {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
      return;
    }
  }

  const fullUrl = req.url ?? '/';
  const apiResponse = await handleRequest({
    method: (req.method ?? 'GET') as HttpMethod,
    url: fullUrl,
    body: parsedBody,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...(apiResponse.headers ?? {}),
  };

  res.writeHead(apiResponse.status, headers);
  res.end(JSON.stringify(apiResponse.body));
}

// ── 静态文件服务 ────────────────────────────────────────────────────

function tryServeStatic(urlPath: string, rootDir: string, res: ServerResponse): boolean {
  const filePath = join(rootDir, urlPath);

  // 安全检查：防止路径穿越
  if (!filePath.startsWith(rootDir)) return false;

  if (!existsSync(filePath)) return false;

  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    const indexPath = join(filePath, 'index.html');
    if (existsSync(indexPath)) {
      return tryServeStatic(join(urlPath, 'index.html'), rootDir, res);
    }
    return false;
  }

  const ext = extname(filePath);
  const contentType = MIME[ext] ?? 'application/octet-stream';

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}
