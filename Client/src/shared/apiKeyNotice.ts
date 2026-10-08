/**
 * 「未配置 API Key」错误的识别与清理。
 *
 * 背景（2026-10-08）：缺 Key 时后端此前**什么都不回**（循环以 risk 结束、没有正文也没有 error），
 * 界面只留一个空进度条。现在后端在发消息前预检，并以 `[MISSING_API_KEY] ` 前缀回传原因，
 * 前端据此**弹窗提示并引导到「设置 → 模型供应商」**。
 *
 * ⚠️ 标记必须与后端 `Src/Interface/IpcBridge/ipcBridge.ts` 的 `MISSING_API_KEY_MARKER` 一致；
 * `Tests/Client/apiKeyNotice.spec.ts` 有一条断言专门盯着这两个常量不许漂移。
 */

/** 与后端一致的标记前缀 */
export const MISSING_API_KEY_MARKER = '[MISSING_API_KEY] ';

/** 该错误是否是"缺 API Key"（可引导到设置页的配置问题） */
export function isMissingApiKeyError(error: string | undefined | null): boolean {
  return typeof error === 'string' && error.includes(MISSING_API_KEY_MARKER.trim());
}

/** 去掉标记，得到面向用户的文案（标记只用于程序识别，不该出现在界面上） */
export function stripMissingApiKeyMarker(error: string): string {
  return error.startsWith(MISSING_API_KEY_MARKER)
    ? error.slice(MISSING_API_KEY_MARKER.length)
    : error.split(MISSING_API_KEY_MARKER).join('');
}
