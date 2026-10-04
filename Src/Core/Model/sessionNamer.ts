/**
 * @module Core/Model/sessionNamer
 * @description
 * 用模型给会话/任务起名（2026-10-01 需求）。
 *
 * 背景：原先 `tryAutoNameSession` 直接把用户第一条消息截断成标题
 * （长句会变成"请只回复两个字：收到"这类不像名字的标题）。
 * 现在改为**首次请求时让模型起一个简短名称**；模型不可用时回退到截断用户消息。
 */

/** 命名提示词（要求极短，且不要引号/句末标点） */
const NAME_SYSTEM_PROMPT =
  '你是任务命名助手。根据用户的第一条消息，为这次任务起一个简短名称：' +
  '不超过 12 个汉字（或 24 个字符），不加引号、不加书名号、不以标点结尾，只输出名称本身。';

/** 名称最大长度（字符） */
export const MAX_SESSION_NAME_LENGTH = 24;

/**
 * 清洗模型输出：去掉引号/换行/多余空白，限制长度。
 * 返回 null 表示不可用（交由调用方回退）。
 */
export function sanitizeSessionName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const firstLine = raw.split('\n')[0] ?? '';
  let name = firstLine
    .trim()
    .replace(/^["'“”‘’《》【】\s]+/, '')
    .replace(/["'“”‘’《》【】\s]+$/, '')
    .replace(/[。．.,，;；:：!！?？]+$/, '')  // 去句末标点
    .trim();

  if (!name) return null;
  if (name.length > MAX_SESSION_NAME_LENGTH) {
    name = name.slice(0, MAX_SESSION_NAME_LENGTH);
  }
  return name || null;
}

/** 回退命名：截断用户消息（保持既有行为） */
export function fallbackSessionName(userMessage: string): string {
  const name = userMessage.replace(/[\r\n]+/g, ' ').trim();
  if (!name) return 'New Chat';
  return name.length > 40 ? `${name.slice(0, 40)}…` : name;
}

/** 命名所需的最小 provider 契约（便于测试替身） */
export interface NamingProvider {
  chat(options: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
    max_tokens?: number;
    temperature?: number;
  }): Promise<{ ok: boolean; value?: { content: string }; error?: string }>;
}

export interface GenerateSessionNameOptions {
  provider: NamingProvider;
  model: string;
  userMessage: string;
  /** 超时（ms），超时视为失败并回退 */
  timeoutMs?: number;
}

/**
 * 请求模型生成会话名称。
 * 任何失败（网络/超时/空输出）返回 null，由调用方使用 `fallbackSessionName`。
 */
export async function generateSessionName(options: GenerateSessionNameOptions): Promise<string | null> {
  const { provider, model, userMessage, timeoutMs = 15_000 } = options;

  const call = provider.chat({
    model,
    messages: [
      { role: 'system', content: NAME_SYSTEM_PROMPT },
      { role: 'user', content: `用户的第一条消息：${userMessage.slice(0, 500)}` },
    ],
    max_tokens: 32,
    temperature: 0.2,
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    const result = await Promise.race([call, timeout]);
    if (!result || !result.ok || !result.value) return null;
    return sanitizeSessionName(result.value.content);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
