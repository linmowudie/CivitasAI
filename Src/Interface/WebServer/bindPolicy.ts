/**
 * @module Interface/WebServer/bindPolicy
 * @description
 * 监听地址决策（REV-001 / REV-280）。
 *
 * 随包默认把 `/api/*` 摊在 `0.0.0.0` 上，而接入层长期没有统一鉴权 ——
 * 同网段任意机器即可读会话、改配置、代答审批。这里把"是否对外开放"变成
 * 一个必须显式声明的决定：非回环地址要么由配置明确授权，要么回退 `127.0.0.1`，
 * 两种情况都留下告警（不静默改用户的配置意图）。
 */

/** 视为回环的写法 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const DEFAULT_BIND_HOST = "127.0.0.1";

export interface BindDecision {
  /** 实际用于 listen 的地址 */
  host: string;
  /** 是否对外开放（非回环） */
  remoteEnabled: boolean;
  /** 需要打给运维/用户的告警 */
  warnings: string[];
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim());
}

/**
 * 决定监听地址。
 *
 * @param configuredHost `server.host`
 * @param allowRemoteAccess `server.allowRemoteAccess`——非回环绑定的显式开关
 */
export function resolveBindHost(input: {
  configuredHost?: unknown;
  allowRemoteAccess?: unknown;
}): BindDecision {
  const raw =
    typeof input.configuredHost === "string" &&
    input.configuredHost.trim() !== ""
      ? input.configuredHost.trim()
      : DEFAULT_BIND_HOST;
  const remoteOptIn = input.allowRemoteAccess === true;
  const warnings: string[] = [];

  if (isLoopbackHost(raw)) {
    return { host: raw, remoteEnabled: false, warnings };
  }

  if (!remoteOptIn) {
    warnings.push(
      `监听地址 ${raw} 属非回环地址，未获显式授权（需 server.allowRemoteAccess=true），已回退 ${DEFAULT_BIND_HOST}` +
        "——局域网内任意机器本可直接读写会话、配置与审批",
    );
    return { host: DEFAULT_BIND_HOST, remoteEnabled: false, warnings };
  }

  warnings.push(
    `已按显式配置对外开放监听地址 ${raw}：/api/* 对同网段可达，` +
      "请确认鉴权门（本地 API 令牌）已生效，否则等同暴露控制面",
  );
  return { host: raw, remoteEnabled: true, warnings };
}
