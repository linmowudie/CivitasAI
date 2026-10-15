/**
 * @module electron/urlPolicy
 * @description
 * 桌面形态的外联 URL 策略（REV-286/287）。
 *
 * 渲染进程被 compromise 或被诱导点击链接时，能借主进程做两件事：
 * ① `server-fetch`——旧实现只要 `^https?://` 就转发的**任意 URL**，
 *    等于给渲染进程一个内网代理（`http://169.254.169.254/`、路由器后台、任意内网服务）；
 * ② `shell.openExternal`——`setWindowOpenHandler` 此前**零校验**直接开浏览器。
 * 这里给出单一判定源：本机控制面只认回环 + 实际监听端口，其余外联只认 https。
 */

/** 允许交给外部程序/浏览器的 URL scheme */
export const ALLOWED_EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set([
  "https:",
  "mailto:",
]);

/** 本机控制面允许的 host（`http` 仅限回环，且端口必须是后端实际监听端口） */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
]);

export interface UrlDecision {
  allowed: boolean;
  reason?: string;
}

function parseUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * 交给默认浏览器 / 外部程序打开的 URL。
 * 只允许 `https:` 与 `mailto:`；`http:` 一律拒绝（含 `http://localhost`，
 * 前端调试链接本就在应用内打开，不需要唤起外部程序）。
 */
export function isSafeExternalUrl(raw: unknown): UrlDecision {
  const url = parseUrl(raw);
  if (!url) return { allowed: false, reason: "URL 无法解析" };
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) {
    return {
      allowed: false,
      reason: `不允许的 scheme：${url.protocol || "(空)"}（仅 https / mailto）`,
    };
  }
  if (url.protocol === "https:" && url.hostname === "") {
    return { allowed: false, reason: "缺少主机名" };
  }
  return { allowed: true };
}

/**
 * `server-fetch` 允许的目标（该通道是双用途的：本机控制面 + 账号服务端）：
 * - 本机后端：`http(s)://<回环>:<后端实际端口>`（端口必须精确匹配，避免借道其他本机服务）；
 * - 账号服务端：必须由渲染进程经 `set-account-server-origin` **显式固定**，
 *   且只允许 `https://` 或回环 `http://`（开发态账号服务跑在 `127.0.0.1:8787`）；
 * - 其余（未固定的任意 http、内网/链路本地地址、`file:`、非标 scheme）一律拒绝。
 *
 * 固定值来自用户登录时填写的服务端地址：不固定就无法区分"用户的账号服务"与"任意内网主机"，
 * 而把判定权一直交给每次请求自带 URL 的渲染进程，等于留着内网代理。
 */
export function isAllowedServerFetchTarget(
  raw: unknown,
  allowed: { localHttpPort: number | null; accountOrigin: string | null },
): UrlDecision {
  const url = parseUrl(raw);
  if (!url) return { allowed: false, reason: "非法请求地址" };

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: `不允许的 scheme：${url.protocol}` };
  }

  const targetOrigin = url.origin;

  if (LOOPBACK_HOSTS.has(url.hostname)) {
    if (allowed.localHttpPort === null || Number.isNaN(allowed.localHttpPort)) {
      return { allowed: false, reason: "后端尚未就绪，拒绝本机请求转发" };
    }
    const port =
      url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
    if (port === String(allowed.localHttpPort)) return { allowed: true };
    // 回环上的其它端口只可能是账号服务端——必须是已固定的那个才放行
    if (allowed.accountOrigin === targetOrigin) return { allowed: true };
    return {
      allowed: false,
      reason: `本机仅允许后端端口 ${allowed.localHttpPort} 或已固定的账号服务端`,
    };
  }

  if (allowed.accountOrigin === targetOrigin) {
    if (url.protocol !== "https:") {
      return { allowed: false, reason: "非回环的账号服务端必须使用 https" };
    }
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `目标 ${targetOrigin} 不是本机后端，也未与已固定的账号服务端一致`,
  };
}

/**
 * 校验渲染进程上报的账号服务端 origin：只接受 `https://` 或回环 `http://`，
 * 且必须是不带路径/查询的纯 origin（防止把 allowlist 扩成某个 host 的任意子树）。
 */
export function normalizeAccountOrigin(
  raw: unknown,
): UrlDecision & { origin: string | null } {
  const url = parseUrl(raw);
  if (!url) return { allowed: false, origin: null, reason: "URL 无法解析" };
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    return {
      allowed: false,
      origin: null,
      reason: "账号服务端必须是 https 或回环 http 地址",
    };
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return {
      allowed: false,
      origin: null,
      reason: "账号服务端地址只能是 origin（协议+主机+端口）",
    };
  }
  return { allowed: true, origin: url.origin };
}
