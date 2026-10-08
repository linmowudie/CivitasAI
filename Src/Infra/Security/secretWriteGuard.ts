/**
 * 供应商凭据写入守卫（2026-10-08）。
 *
 * 背景：`ipc-save-secrets` 是"整包覆盖"兼容通道。原守卫只拦"非空但字段不完整"的写入，
 * **空数组被直接放行** → 凭据文件被整体清空。实测发生过一次：
 * `供应商密钥已加密保存 {"count":0}`（此前为 2 条），用户保存过的 API Key 就此消失，
 * 表现为"密钥未设置"反复出现且无从解释。属**静默数据丢失**，必须由后端兜底拒绝。
 *
 * 抽成纯函数便于单测：这里出错的表现是"用户凭据凭空消失"，最难排查的一类。
 */

export interface SecretLike {
  name?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** 凭据是否完整（与 secretsStore.hasUsableSecret 同判据） */
export function isUsableSecret(entry: SecretLike | undefined | null): boolean {
  return !!entry
    && typeof entry.apiKey === 'string' && entry.apiKey.trim().length > 0
    && typeof entry.baseUrl === 'string' && entry.baseUrl.trim().length > 0;
}

export type SecretWriteDecision =
  | { ok: true; warning?: string }
  | { ok: false; error: string };

/**
 * 评估一次整包凭据写入是否允许。
 *
 * 规则：
 *  1. **拒绝用空列表覆盖已有凭据**——这是数据丢失，不是"用户想清空"（真要清空请逐个移除供应商）；
 *  2. 已有凭据时，拒绝写入字段不完整的条目（历史客户端会把 apiKey 写成空串）；
 *  3. 数量减少时放行但给出警告（可能是误删，需要留痕）。
 *
 * @param currentCount 当前已保存的凭据条数
 * @param incoming 本次写入的条目
 */
export function evaluateSecretWrite(
  currentCount: number,
  incoming: readonly SecretLike[],
): SecretWriteDecision {
  if (incoming.length === 0 && currentCount > 0) {
    return {
      ok: false,
      error: `拒绝清空已保存的 ${currentCount} 条供应商凭据（如需删除请逐个移除供应商）。`,
    };
  }

  if (currentCount > 0) {
    const blanks = incoming.filter((p) => !isUsableSecret(p)).map((p) => p.name ?? '(未命名)');
    if (blanks.length > 0) {
      return {
        ok: false,
        error: `拒绝写入不完整凭据（缺少 apiKey/baseUrl）：${blanks.join(', ')}。请通过「添加供应商」重新填写。`,
      };
    }
  }

  if (incoming.length < currentCount) {
    return {
      ok: true,
      warning: `供应商凭据数量减少：${currentCount} → ${incoming.length}（请确认是否为有意删除）`,
    };
  }

  return { ok: true };
}
