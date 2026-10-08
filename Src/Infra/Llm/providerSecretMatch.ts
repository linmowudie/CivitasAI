/**
 * 已保存凭据 ↔ 已注册 Provider 的匹配（2026-10-08）。
 *
 * 背景：启动时按加密凭据恢复供应商，原实现**无条件**改用 `uniqueProviderName()` 造新名：
 * 配置里已有 `huawei-maas`（api_key_ref=env:XXX，环境变量没设）时，恢复出的
 * `huawei-maas-2` 会与它并存；而路由解析 `huawei-maas/<model>` 仍落到**没有密钥的那个**，
 * 用户"保存过 Key 却每次都说未设置"，根因就在这里。
 *
 * 匹配规则（按可靠性排序）：
 *  1. 注册名相同（或与旧数据的展示名相同）；
 *  2. **端点相同**（baseUrl 归一化后相等）——命名漂移时唯一可靠的锚点。
 *
 * 抽成纯函数是为了可单测：这里出错的表现是"密钥静默不生效"，最难排查的一类。
 */

/** baseUrl 归一化：去尾斜杠、统一小写（端点大小写不敏感） */
export function normalizeBaseUrl(url: string | undefined | null): string {
  return (url ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

export interface ProviderLike {
  name: string;
  config: { base_url: string };
}

export interface SecretLike {
  name: string;
  provider?: string;
  baseUrl?: string;
}

/**
 * 在已注册 provider 中找出该凭据应当**就地替换密钥**的那一个。
 * @returns 命中的 provider；未命中返回 undefined（调用方按新供应商注册，用 uniqueProviderName 避免覆盖）
 */
export function findProviderToMerge<T extends ProviderLike>(
  registered: readonly T[],
  secret: SecretLike,
): T | undefined {
  const key = (secret.provider?.trim() || secret.name || '').trim();
  if (!key && !secret.baseUrl) return undefined;

  // 1) 名字（注册名 / 旧数据的展示名）
  const byName = registered.find((p) => p.name === key || p.name === secret.name);
  if (byName) return byName;

  // 2) 端点（命名漂移时的兜底锚点）
  const target = normalizeBaseUrl(secret.baseUrl);
  if (!target) return undefined;
  return registered.find((p) => normalizeBaseUrl(p.config.base_url) === target);
}
