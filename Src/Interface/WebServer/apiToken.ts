/**
 * @module Interface/WebServer/apiToken
 * @description
 * 本机控制面（`/api/*`）的统一身份门（REV-001/133/280）。
 *
 * ## 为什么需要它
 * 接入层此前**匹配到路由就执行**：18 个 `*Api` 全部匿名可读可写，而监听地址默认
 * `0.0.0.0`（见 `bindPolicy.ts`）→ 同网段任意机器可读写会话、代答审批、写配置。
 * 本模块给出接入层的**唯一凭据判定**：无有效凭据一律 401 并落日志。
 *
 * ## 凭据来源（两种，都归"本机/受控客户端"）
 * 1. `server.apiToken`（配置显式提供）——远程形态（`allowRemoteAccess:true`）**只有这一条路**；
 * 2. 进程内随机生成（`randomBytes(32)`，**不落盘**）——桌面形态由主进程经 IPC 交给渲染进程，
 *    浏览器/开发态由渲染进程向 `/internal/api-token` 领取。
 *
 * ## 领取通道 `/internal/api-token`（不在 `/api/*` 前缀内）
 * 只在**回环**上开放，且必须同时满足：`POST`、来源 `Origin`（若有）也是回环、
 * 且服务端未开启远程访问。响应不回显 CORS 头、`Cache-Control: no-store`。
 * 之所以要求同源回环：开发态渲染进程本身是浏览器上下文，若这条通道可被任意
 * 跨站页面读取，注入即可自举拿到门禁凭据（等于门白装）。
 *
 * ## 头字段选择
 * 同时接受 `Authorization: Bearer <token>` 与专用头 `X-Civitas-Api-Token`。
 * 客户端**用专用头**，把 `Authorization` 留给治理侧的身份验真
 * （`approvalApi.ts` 用 Bearer 向账号服务验真用户身份，见 REV-076/G-09）——
 * 两个凭据语义不同，共用一个头会让"带了 API 令牌"被误当成"已验真的用户"。
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { logger } from "../../Infra/Logging/logger.js";

/** 专用凭据头（与 Bearer 等价，避免占用治理身份验真用的 Authorization） */
export const API_TOKEN_HEADER = "x-civitas-api-token";
/** 令牌领取通道（刻意放在 `/api/` 之外，不受本门管辖） */
export const API_TOKEN_BOOTSTRAP_PATH = "/internal/api-token";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost"]);

let apiToken: string | null = null;
/** 回环领取通道是否开放：开启远程访问时必须关闭（fail-closed） */
let bootstrapEnabled = false;

export interface ApiTokenInit {
  /** `server.apiToken`：显式配置优先（远程形态的唯一来源） */
  configuredToken?: unknown;
  /** 本次实际监听是否为非回环地址（`resolveBindHost().remoteEnabled`） */
  remoteEnabled: boolean;
}

export interface ApiTokenState {
  token: string;
  /** 令牌来自配置还是进程内生成 */
  fromConfig: boolean;
  bootstrapEnabled: boolean;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  // Node 下 IPv4 常以 IPv4-mapped IPv6 形式出现
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (normalized.startsWith("127.")) return true;
  return LOOPBACK_ADDRESSES.has(normalized);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackAddress(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * 初始化控制面凭据。**必须在 `startHttpServer()` 之前调用**：
 * 未初始化时门是关的（`/api/*` 全 401），不存在"忘了装配 = 无鉴权"这条路。
 */
export function initApiToken(init: ApiTokenInit): ApiTokenState {
  const configured =
    typeof init.configuredToken === "string" ? init.configuredToken.trim() : "";
  apiToken =
    configured.length > 0 ? configured : randomBytes(32).toString("base64url");
  bootstrapEnabled = !init.remoteEnabled;
  if (configured.length > 0 && configured.length < 16) {
    logger.warn("API 令牌过短", {
      source: "apiToken",
      length: configured.length,
      hint: "server.apiToken 建议不少于 32 字符",
    });
  }
  const state: ApiTokenState = {
    token: apiToken,
    fromConfig: configured.length > 0,
    bootstrapEnabled,
  };
  logger.info("控制面鉴权门已启用", {
    source: "apiToken",
    tokenSource: state.fromConfig ? "config" : "generated",
    bootstrapEnabled: state.bootstrapEnabled,
  });
  return state;
}

/** 当前令牌（主进程经 IPC 下发给渲染进程；未初始化返回 null） */
export function getApiToken(): string | null {
  return apiToken;
}

/** 领取通道是否开放（诊断/测试用） */
export function isBootstrapEnabled(): boolean {
  return bootstrapEnabled;
}

function tokensEqual(a: string, b: string): boolean {
  const [bufA, bufB] = [Buffer.from(a), Buffer.from(b)];
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 从请求头提取凭据（Bearer 与专用头任一） */
export function extractApiCredential(
  headers: Record<string, string>,
): string | null {
  const dedicated = headers[API_TOKEN_HEADER] ?? headers["X-Civitas-Api-Token"];
  if (typeof dedicated === "string" && dedicated.trim() !== "")
    return dedicated.trim();
  const authorization = headers["authorization"] ?? headers["Authorization"];
  if (
    typeof authorization === "string" &&
    /^bearer\s+\S+/i.test(authorization.trim())
  ) {
    return authorization.trim().slice("bearer".length).trim();
  }
  return null;
}

/**
 * `/api/*` 请求是否放行。
 * 未初始化（无令牌）时一律拒绝——**fail-closed**。
 */
export function isApiAuthorized(headers: Record<string, string>): boolean {
  if (!apiToken) return false;
  const credential = extractApiCredential(headers);
  if (!credential) return false;
  return tokensEqual(credential, apiToken);
}

/** 写 401 并留痕（终结响应，调用方随后 return） */
export function rejectUnauthorizedRequest(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const credential = extractApiCredential(normalizeHeaders(req.headers));
  logger.warn("控制面请求被拒绝（缺少有效凭据）", {
    source: "apiToken",
    method: req.method ?? "GET",
    path: (req.url ?? "").split("?")[0],
    peer: req.socket.remoteAddress ?? "unknown",
    // 只记录"带没带"，绝不记录凭据本身
    credentialPresent: credential !== null,
  });
  res.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      ok: false,
      error:
        `未授权：本机控制面要求 API 凭据（请求头 X-Civitas-Api-Token 或 Authorization: Bearer）。` +
        `命令行/脚本可先 POST http://${req.headers.host ?? "127.0.0.1"}/internal/api-token 领取（仅回环、且未开启 allowRemoteAccess 时可用），` +
        `或在 Configs 的 server.apiToken 固定一个值`,
    }),
  );
}

function normalizeHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * 处理令牌领取请求。命中该路径时**必须**由本函数终结响应（返回 true）。
 *
 * 三重门：`POST` + 回环来源 + 未开启远程访问；任一不满足即 403 并留痕。
 */
export function handleTokenBootstrap(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const path = (req.url ?? "").split("?")[0];
  if (path !== API_TOKEN_BOOTSTRAP_PATH) return false;

  const deny = (reason: string): true => {
    logger.warn("API 令牌领取被拒绝", {
      source: "apiToken",
      reason,
      method: req.method ?? "",
      peer: req.socket.remoteAddress ?? "unknown",
      origin: req.headers.origin ?? "(none)",
    });
    // 不回显 CORS 头：跨站页面即便发出请求也读不到响应
    res.removeHeader("Access-Control-Allow-Origin");
    res.writeHead(403, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ ok: false, error: reason }));
    return true;
  };

  if (req.method !== "POST") return deny("领取通道只接受 POST");
  if (!apiToken) return deny("鉴权门尚未初始化");
  if (!bootstrapEnabled)
    return deny(
      "服务已开启远程访问，令牌领取通道关闭（请设置 server.apiToken）",
    );
  if (!isLoopbackAddress(req.socket.remoteAddress))
    return deny("领取通道只在回环上开放");
  const origin = req.headers.origin;
  if (
    typeof origin === "string" &&
    origin !== "" &&
    !isLoopbackOrigin(origin)
  ) {
    return deny("领取通道只允许同源回环来源");
  }

  res.removeHeader("Access-Control-Allow-Origin");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ ok: true, data: { token: apiToken } }));
  logger.info("API 令牌已下发（回环领取）", {
    source: "apiToken",
    peer: req.socket.remoteAddress ?? "unknown",
    origin: origin ?? "(none)",
  });
  return true;
}

/** 测试/停机时复位（避免用例间串门） */
export function resetApiToken(): void {
  apiToken = null;
  bootstrapEnabled = false;
}
