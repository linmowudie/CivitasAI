/**
 * P0-3 验收（2026-10-08）：浏览器/局域网形态不得对外发出源码映射（REV-291）
 *
 * 背景：本进程直接托管 `dist/renderer`，而 vite 此前无条件 `sourcemap: true`，
 * `.map` 里的 `sourcesContent` 就是原始 TS 全文；MIME 表没有 `.map` 时
 * 它以 `application/octet-stream` 照样可下载 —— 等于前端源码全量外泄。
 *
 * 覆盖：
 *  1. `.map` 请求返回 404（且**不是** SPA 回退的 200 + index.html）；
 *  2. 同目录的正常 chunk 仍可取（门没有把静态面一起关掉）；
 *  3. 大写字母扩展名同样被拒（`.MAP` 不是绕行口）；
 *  4. 未知路径的 SPA 回退行为不变（回退是特性，本工单只切掉源码映射）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startHttpServer,
  stopHttpServer,
} from "../../Src/Interface/WebServer/httpServer.js";

const TEST_PORT = 14043;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const ASSETS = "assets";

let staticDir = "";

/** 复刻真实产物形状：assets/<chunk>-<hash>.js 与同名 .map（幂等） */
function writeFixture(): void {
  const dir = join(staticDir, ASSETS);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index-CVpjqtvg.js"), 'console.log("chunk")');
  writeFileSync(
    join(dir, "index-CVpjqtvg.js.map"),
    JSON.stringify({
      version: 3,
      sources: ["src/App.tsx"],
      sourcesContent: ["const SECRET = 1"],
    }),
  );
  writeFileSync(
    join(dir, "Big-CHUNK.MAP"),
    JSON.stringify({ sourcesContent: ["UPPER"] }),
  );
}

/** listen 是异步的，先探一次入口页确认服务器真的在听 */
async function waitForServer(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/index.html`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  throw new Error("httpServer 未在预期时间内就绪");
}

describe("P0-3 静态源码映射拒发（REV-291）", () => {
  beforeAll(async () => {
    staticDir = mkdtempSync(join(tmpdir(), "civitas-static-"));
    writeFileSync(
      join(staticDir, "index.html"),
      "<!doctype html><title>Civitas</title>",
    );
    writeFixture();
    await startHttpServer({
      host: "127.0.0.1",
      port: TEST_PORT,
      corsOrigins: [],
      staticDir,
    });
    await waitForServer();
  });

  afterAll(async () => {
    await stopHttpServer();
    rmSync(staticDir, { recursive: true, force: true });
  });

  it("产物目录里放了 .map，请求它必须 404 而非回退成 index.html", async () => {
    const res = await fetch(`${BASE}/${ASSETS}/index-CVpjqtvg.js.map`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("sourcesContent");
    // 关键：不能是 SPA 回退发出来的 index.html（那会是 200）
    expect(body).not.toContain("<title>Civitas</title>");
    expect((JSON.parse(body) as { ok: boolean }).ok).toBe(false);
  });

  it("大写字母扩展名同样被拒（`.MAP` 不是绕行口）", async () => {
    const res = await fetch(`${BASE}/${ASSETS}/Big-CHUNK.MAP`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  it("同目录的正常 chunk 仍可取——门没有把静态面一起关掉", async () => {
    const res = await fetch(`${BASE}/${ASSETS}/index-CVpjqtvg.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("chunk")');
  });

  it("未知路径的 SPA 回退行为不变", async () => {
    const res = await fetch(`${BASE}/some/client/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Civitas</title>");
  });
});
