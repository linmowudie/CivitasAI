/**
 * @module Infra/Llm/providerProbe
 * @description
 * 供应商**连通性校验**（首启引导 / 设置面板共用）。
 *
 * 两步探测（都带超时，失败可归因）：
 * 1. `GET {base_url}/models` —— 校验鉴权与端点，并拿到模型清单；
 *    部分网关不提供该端点（404/405）不算致命，交由第 2 步判定。
 * 2. `POST {base_url}/chat/completions`（`max_tokens: 1` 的最小请求）——
 *    真正验证"这个 Key 能对话"，同时测出首字节时延。
 *
 * 与 `Src/Interface/IpcBridge` 里 `ipc-fetch-models` 的区别：那条通道只拉模型列表、不验证对话，
 * 且把 `context_window` 等规格写死 128000。这里返回**可归因的错误类型**，供引导页给出准确提示。
 */

/** 探测到的模型规格（与 `Configs/modelRouter.json` 的 models 项同构） */
export interface DiscoveredModel {
  id: string;
  context_window: number;
  max_output: number;
  supports_vision: boolean;
  supports_tools: boolean;
  cost_per_1k_input: number;
  cost_per_1k_output: number;
}

// ── 逐模型可用性校验（2026-10-07 模型导入重设计）────────────────────
//
// 背景：`GET /models` 返回的是账号**可见**的模型，不等于**当前可用**的模型
// （未开通 / 无权限 / 名字已下线都会出现在列表里）。实测后果：用户导入一批模型后，
// 选中其中一个不可用的，对话就得到一个"空气泡"。
//
// 因此导入流程改为：拉列表 → **逐个最小对话请求确认可用** → **由用户勾选**要导入的模型。
// 本函数只负责校验，不做导入。

/** 单个模型的可用性结论 */
export type ModelAvailability = 'available' | 'unavailable' | 'unknown';

export interface ModelVerification {
  id: string;
  status: ModelAvailability;
  /** 仅 available 时有意义（首字节/整体耗时） */
  latencyMs?: number;
  errorKind?: ProbeErrorKind;
  /** 供应商原话（不可用时给用户看原因） */
  providerMessage?: string;
}

export interface VerifyModelsInput {
  base_url: string;
  api_key: string;
  models: string[];
  /** 并发度（默认 4；过高容易被供应商限流） */
  concurrency?: number;
  timeoutMs?: number;
}

export interface VerifyModelsResult {
  results: ModelVerification[];
  summary: { total: number; available: number; unavailable: number; unknown: number };
}

/** 明确表示"这个模型不可用"的错误特征（模型不存在 / 未开通 / 无权限） */
const MODEL_UNAVAILABLE_PATTERNS = [
  'model_not_found', 'model not exist', 'model not found', 'no such model',
  'does not exist', 'not supported', 'unsupported', 'invalid model',
  'permission', 'not authorized', 'access denied', 'not enabled', '未开通', '无权限', '模型不存在',
];

/**
 * 校验一批模型是否可用（每个模型发一次 `max_tokens: 1` 的最小对话请求）。
 *
 * 分类原则（很重要，避免误杀）：
 * - 2xx → `available`；
 * - **明确**的模型级错误（400/404/403 且命中模型不可用特征）→ `unavailable`；
 * - 限流/超时/网络/5xx/鉴权失败 → `unknown`（**不能**判定为"这个模型不可用"，
 *   否则一次限流就会把好模型全标死；鉴权失败时整批都会 unknown，由上层提示先修 Key）。
 */
export async function verifyModels(input: VerifyModelsInput): Promise<VerifyModelsResult> {
  const baseUrl = normalizeBaseUrl(input.base_url);
  const { key: apiKey } = normalizeApiKey(input.api_key ?? '');
  const ids = [...new Set((input.models ?? []).filter((id) => typeof id === 'string' && id.length > 0))];
  const concurrency = Math.min(Math.max(input.concurrency ?? 4, 1), 8);
  const timeoutMs = input.timeoutMs ?? 15_000;

  const results: ModelVerification[] = [];
  const classify = (id: string, status: number, body: string): ModelVerification => {
    const providerMessage = extractProviderMessage(body);
    const haystack = `${providerMessage ?? ''} ${body}`.toLowerCase();
    const definitive = MODEL_UNAVAILABLE_PATTERNS.some((p) => haystack.includes(p.toLowerCase()));

    if (status === 401 || status === 403) {
      // 鉴权问题与"模型不可用"是两回事：整批不可判
      return { id, status: 'unknown', errorKind: 'auth', providerMessage };
    }
    if (status === 429) {
      return { id, status: 'unknown', errorKind: 'http', providerMessage: providerMessage ?? '触发供应商限流（429）' };
    }
    if (status >= 500) {
      return { id, status: 'unknown', errorKind: 'http', providerMessage };
    }
    if ((status === 400 || status === 404 || status === 405) && definitive) {
      return { id, status: 'unavailable', errorKind: 'http', providerMessage };
    }
    if (status === 400 || status === 404) {
      // 400/404 但错误文案看不出"模型不存在"：仍按不可用处理，但保留原话供核对
      return { id, status: 'unavailable', errorKind: 'http', providerMessage };
    }
    return { id, status: 'unknown', errorKind: 'http', providerMessage };
  };

  if (!baseUrl || !apiKey || ids.length === 0) {
    for (const id of ids) {
      results.push({ id, status: 'unknown', errorKind: 'invalid_input' });
    }
    const summary = { total: ids.length, available: 0, unavailable: 0, unknown: ids.length };
    return { results, summary };
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= ids.length) return;
      const id = ids[index]!;
      const startedAt = Date.now();
      try {
        const call = await fetchWithTimeout(
          `${baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
          },
          timeoutMs,
        );
        if (!call.ok) {
          results.push({ id, status: 'unknown', errorKind: call.kind, providerMessage: call.message });
          continue;
        }
        if (call.response.ok) {
          results.push({ id, status: 'available', latencyMs: Date.now() - startedAt });
          continue;
        }
        const body = await call.response.text().catch(() => '');
        results.push(classify(id, call.response.status, body));
      } catch (e) {
        results.push({ id, status: 'unknown', errorKind: 'unknown', providerMessage: e instanceof Error ? e.message : String(e) });
      }
    }
  });
  await Promise.all(workers);

  // 保持与入参一致的顺序（并发完成顺序不定，UI 要稳定）
  const order = new Map(ids.map((id, i) => [id, i] as const));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const summary = {
    total: results.length,
    available: results.filter((r) => r.status === 'available').length,
    unavailable: results.filter((r) => r.status === 'unavailable').length,
    unknown: results.filter((r) => r.status === 'unknown').length,
  };
  return { results, summary };
}

export type ProbeErrorKind = 'auth' | 'http' | 'network' | 'timeout' | 'invalid_input' | 'unknown';

export interface ProbeInput {
  base_url: string;
  api_key: string;
  /** 指定用于对话探测的模型；缺省取列表里的第一个 */
  model?: string;
  /** 单次请求超时（默认 12s；对话探测与列表探测各自计时） */
  timeoutMs?: number;
  /** 是否执行第 2 步对话探测（默认 true；只校验 Key 时可关掉） */
  chatProbe?: boolean;
}

export interface ProbeResult {
  /** 至少一步成功（列表或对话） */
  ok: boolean;
  baseUrl: string;
  listOk: boolean;
  chatOk: boolean;
  models: DiscoveredModel[];
  /** 建议默认模型（列表首个或显式传入的 model） */
  suggestedModel?: string;
  /** 对话探测首字节时延（ms） */
  latencyMs?: number;
  error?: string;
  errorKind?: ProbeErrorKind;
  /** 人类可读的建议（引导页直接展示） */
  hint?: string;
  /** `/models` 的 HTTP 状态码（未请求/网络失败时为空） */
  listStatus?: number;
  /** 是否真的发起了 `/models` 请求 */
  listAttempted?: boolean;
  /** 是否真的发起了对话请求（鉴权失败时会提前返回 → false） */
  chatAttempted?: boolean;
  /**
   * `/models` 明确不可用（404/405）——与"鉴权失败"是两回事。
   *
   * 修复背景（2026-10-07）：早期实现只要 `listOk=false` 就在引导页显示"该端点不提供"，
   * 于是 DashScope 返回 401 时用户看到的是"端点不提供"，与真实原因（Key 无效）完全相反。
   */
  listNotProvided?: boolean;
  /** 供应商返回的原始错误信息（解析自响应体，供用户自查：invalid_api_key / 余额不足 等） */
  providerMessage?: string;
  /** Key 被自动清理的内容说明（粘贴带入的不可见字符/引号/Bearer 前缀等） */
  keySanitized?: string[];
  /** 实际用于对话探测的模型（多候选重试后命中的那个） */
  chatModelUsed?: string;
  /** 本轮对话探测尝试过的模型顺序 */
  chatCandidates?: string[];
  /** 对话探测实际发起次数（>1 表示自动换模型重试过） */
  chatAttempts?: number;
}

/** 发现模型时的占位规格（真实规格由用户在引导页确认或后续编辑） */
export function defaultModelSpec(id: string): DiscoveredModel {
  return {
    id,
    context_window: 128000,
    max_output: 8192,
    supports_vision: false,
    supports_tools: true,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '');
}

/**
 * 规范化用户粘贴的 API Key（2026-10-07 修复）。
 *
 * 从网页控制台复制的 Key 经常夹带看不见的东西，直接塞进 `Authorization` 头会让服务端判为无效、
 * 或者让 `fetch` 直接抛异常（Node 的 undici 拒绝 > 0xFF 的头部字符）：
 * - 零宽字符 `\u200B-\u200D`、BOM `\uFEFF`：**不属于** `String.trim()` 的空白范围，会原样发出；
 * - 不间断空格 `\u00A0`、全角空格：肉眼与普通空格无异；
 * - 外层引号（从 JSON/配置文件复制）、前缀 `Bearer `（用户把整个头值粘进来）。
 *
 * 返回清理后的 Key 与"改了什么"的说明，由引导页如实展示——不静默改动用户数据。
 */
export function normalizeApiKey(raw: string): { key: string; changes: string[] } {
  const changes: string[] = [];
  let key = raw ?? '';

  const before = key;
  key = key
    .replace(/[\u200B-\u200D\uFEFF]/g, '')      // 零宽字符
    .replace(/[\u00A0\u3000]/g, ' ')            // 不间断/全角空格 → 普通空格
    .replace(/[\r\n\t]+/g, '')                  // 换行/制表（粘贴多行时）
    .trim();
  if (key !== before) changes.push('去除首尾空白或不可见字符');

  const quoted = key.match(/^(['"`])([\s\S]*)\1$/);
  if (quoted) {
    key = quoted[2]!.trim();
    changes.push('去除外层引号');
  }

  if (/^Bearer\s+/i.test(key)) {
    key = key.replace(/^Bearer\s+/i, '').trim();
    changes.push('去除 "Bearer " 前缀');
  }

  return { key, changes };
}

/** 明确不是"对话"用途的模型特征（DashScope 等端点会把它们和对话模型混在一个 /models 列表里） */
const NON_CHAT_HINTS = [
  'embedding', 'embed', 'rerank', 'tts', 'asr', 'audio', 'speech',
  'image', 'wanx', 'stable-diffusion', 'ocr', 'moderation', 'dall',
  'vision-ocr', 'voice', 'realtime',
];

/** 常见对话模型前缀（优先尝试，避免拿列表里第一个非对话模型去探测） */
const CHAT_PREFIX_HINTS = [
  'qwen', 'gpt', 'claude', 'deepseek', 'glm', 'ernie', 'moonshot',
  'abab', 'gemini', 'llama', 'mistral', 'yi-', 'hunyuan', 'spark', 'doubao', 'minimax',
];

/**
 * 从 `/models` 结果里挑"适合做对话探测"的模型候选（2026-10-07 修复）。
 *
 * 背景：DashScope 的 `/models` 会返回上百个模型，包含 `text-embedding-*`、`wanx-*`、TTS/ASR 等。
 * 早期实现直接拿 `models[0]` 去 POST /chat/completions —— 若首位恰好是 embedding，
 * **Key 完全正确也会失败**，用户被误导成"Key 有问题"。
 *
 * 策略：排除明显的非对话模型 → 优先常见对话前缀 → 最多取 5 个作为重试候选。
 */
export function pickChatCandidates(models: DiscoveredModel[]): string[] {
  const ids = models.map((m) => m.id).filter((id) => typeof id === 'string' && id.length > 0);
  const isChatLike = (id: string): boolean => {
    const lower = id.toLowerCase();
    return !NON_CHAT_HINTS.some((hint) => lower.includes(hint));
  };

  const chatLike = ids.filter(isChatLike);
  const preferred = chatLike.filter((id) => {
    const lower = id.toLowerCase();
    return CHAT_PREFIX_HINTS.some((p) => lower.startsWith(p) || lower.includes(`/${p}`));
  });
  const rest = chatLike.filter((id) => !preferred.includes(id));

  const ordered = [...preferred, ...rest];
  // 极端情况：列表里全是非对话模型 → 退回原始顺序，至少让探测说明"这个模型不行"
  const finalList = ordered.length > 0 ? ordered : ids;
  return finalList.slice(0, 5);
}

/** 从供应商的错误响应体里提取可读信息（如 `invalid_api_key`、余额不足等） */export function extractProviderMessage(text: string): string | undefined {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return undefined;
  try {
    const body = JSON.parse(trimmed) as {
      error?: { message?: string; code?: string; type?: string } | string;
      message?: string;
      code?: string;
    };
    if (typeof body.error === 'string') return body.error.slice(0, 300);
    const message = body.error?.message ?? body.message;
    const code = body.error?.code ?? body.error?.type ?? body.code;
    if (message && code) return `${message}（${code}）`.slice(0, 300);
    if (message) return message.slice(0, 300);
    if (code) return String(code);
  } catch {
    // 非 JSON：原样截断
  }
  return trimmed.slice(0, 300);
}

function classifyHttpStatus(status: number): ProbeErrorKind {
  return status === 401 || status === 403 ? 'auth' : 'http';
}

function hintFor(kind: ProbeErrorKind | undefined, status?: number): string {
  switch (kind) {
    case 'auth':
      return 'API Key 无效或无权访问该端点：请确认 Key 是否正确、是否已开通对应模型。';
    case 'http':
      return `端点返回 HTTP ${status ?? ''}：请确认 Base URL 是否包含版本路径（如 /v1），以及模型是否可用。`;
    case 'timeout':
      return '请求超时：请检查网络/代理，或换一个更近的端点。';
    case 'network':
      return '网络不可达：请检查本机网络、代理设置或企业防火墙。';
    case 'invalid_input':
      return '请先填写 Base URL 与 API Key。';
    default:
      return '未能确认连通性：请检查 Base URL、API Key 与所选模型。';
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: true; response: Response } | { ok: false; kind: ProbeErrorKind; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { ok: true, response };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, kind: 'timeout', message: `请求超时（${timeoutMs}ms）` };
    }
    return { ok: false, kind: 'network', message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测供应商连通性。
 *
 * 不抛异常：所有失败都映射为 `ok:false` + `errorKind` + `hint`，便于引导页直接渲染。
 */
export async function probeProviderConnection(input: ProbeInput): Promise<ProbeResult> {
  const baseUrl = normalizeBaseUrl(input.base_url);
  const { key: apiKey, changes: keyChanges } = normalizeApiKey(input.api_key ?? '');
  const timeoutMs = input.timeoutMs ?? 12_000;
  const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const result: ProbeResult = {
    ok: false,
    baseUrl,
    listOk: false,
    chatOk: false,
    models: [],
    listAttempted: false,
    chatAttempted: false,
    ...(keyChanges.length > 0 ? { keySanitized: keyChanges } : {}),
  };

  if (!baseUrl || !apiKey) {
    result.error = '缺少 Base URL 或 API Key';
    result.errorKind = 'invalid_input';
    result.hint = hintFor('invalid_input');
    return result;
  }

  // Key 里仍有非 ASCII/控制字符：HTTP 头只能携带 0xFF 以内字符，直接给出可执行的提示，
  // 而不是让 fetch 抛 ByteString 异常后被误判成"网络不可达"（2026-10-07 实测：零宽空格
  // 会走到那条错误路径，用户看到的却是网络问题）。
  // eslint-disable-next-line no-control-regex
  const badChars = apiKey.match(/[^\x20-\x7E]/g);
  if (badChars) {
    result.error = `API Key 含非 ASCII/控制字符（${badChars.length} 个，例如 U+${badChars[0]!.codePointAt(0)!.toString(16).toUpperCase()}）`;
    result.errorKind = 'invalid_input';
    result.hint = '请回到百炼/供应商控制台重新复制 Key（不要从聊天记录或截图中抄写），再粘贴测试。';
    return result;
  }

  // ── 第 1 步：拉模型列表 ────────────────────────────────────────────
  result.listAttempted = true;
  const listCall = await fetchWithTimeout(`${baseUrl}/models`, { method: 'GET', headers: authHeaders }, timeoutMs);
  if (!listCall.ok) {
    result.error = listCall.message;
    result.errorKind = listCall.kind;
    result.hint = hintFor(listCall.kind);
    return result;
  }

  const listResponse = listCall.response;
  result.listStatus = listResponse.status;
  if (listResponse.ok) {
    try {
      const body = (await listResponse.json()) as { data?: Array<{ id?: string }> };
      result.models = (body.data ?? [])
        .map((m) => m?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .map((id) => defaultModelSpec(id));
      result.listOk = true;
    } catch {
      // 端点存在但返回体不是预期 JSON：不算失败，交给对话探测
      result.listOk = false;
    }
  } else if (listResponse.status === 401 || listResponse.status === 403) {
    // 关键：把供应商的原话带出来（invalid_api_key / 余额不足 / 未开通 …），
    // 用户才能自己判断是"Key 抄错"还是"账号问题"。
    const body = await listResponse.text().catch(() => '');
    result.providerMessage = extractProviderMessage(body);
    result.error = `鉴权失败（HTTP ${listResponse.status}）`;
    result.errorKind = 'auth';
    // 供应商原话 + 可执行建议都给（原话用于自查，建议用于下一步动作）
    result.hint = result.providerMessage
      ? `供应商原话：${result.providerMessage}；${hintFor('auth')}`
      : hintFor('auth');
    return result;
  } else if (listResponse.status === 404 || listResponse.status === 405) {
    // 端点明确不提供 /models：正常情况，继续对话探测
    result.listNotProvided = true;
  } else {
    // 其它状态码（5xx/429/400…）：记下原话但继续尝试对话探测
    const body = await listResponse.text().catch(() => '');
    result.providerMessage = extractProviderMessage(body);
  }

  result.suggestedModel = input.model?.trim() || pickChatCandidates(result.models)[0] || result.models[0]?.id;

  // ── 第 2 步：最小对话探测（多候选模型，逐个尝试）────────────────────
  // 显式指定就用指定模型；否则从列表里**挑对话可用**的模型（排除 embedding/tts/asr/image…），
  // 失败自动换下一个候选——早期实现只试 models[0]，首位是 embedding 时会"Key 正确但对话失败"。
  const explicitModel = input.model?.trim();
  const candidates = explicitModel ? [explicitModel] : pickChatCandidates(result.models);
  result.chatCandidates = candidates;

  if (input.chatProbe === false || candidates.length === 0) {
    result.ok = result.listOk;
    result.suggestedModel = explicitModel || result.models[0]?.id;
    if (!result.ok) {
      result.error = candidates.length === 0
        ? '未能列出模型，且未指定用于对话探测的模型'
        : '已按 chatProbe=false 跳过对话探测';
      result.errorKind = 'unknown';
      result.hint = hintFor('unknown');
    }
    return result;
  }

  let lastFailure: {
    error: string; errorKind: ProbeErrorKind; providerMessage?: string; model: string;
  } | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i]!;
    const startedAt = Date.now();
    result.chatAttempted = true;
    result.chatAttempts = i + 1;

    const chatCall = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
      },
      timeoutMs,
    );

    if (!chatCall.ok) {
      // 网络/超时类失败换模型也没用，直接停
      result.latencyMs = Date.now() - startedAt;
      result.error = chatCall.message;
      result.errorKind = chatCall.kind;
      result.hint = hintFor(chatCall.kind);
      result.chatModelUsed = model;
      return result;
    }

    const chatResponse = chatCall.response;
    result.latencyMs = Date.now() - startedAt;

    if (chatResponse.ok) {
      result.chatOk = true;
      result.ok = true;
      result.chatModelUsed = model;
      result.suggestedModel = model;
      return result;
    }

    const text = await chatResponse.text().catch(() => '');
    lastFailure = {
      error: `对话失败（HTTP ${chatResponse.status}）（model=${model}）`,
      errorKind: classifyHttpStatus(chatResponse.status),
      providerMessage: extractProviderMessage(text) ?? undefined,
      model,
    };
    // 鉴权失败（401/403）换模型也没用，直接停；其它状态码（400 模型不支持/无权限…）继续试下一个
    if (chatResponse.status === 401 || chatResponse.status === 403) break;
  }

  if (lastFailure) {
    result.chatModelUsed = lastFailure.model;
    result.providerMessage = lastFailure.providerMessage ?? result.providerMessage;
    result.error = lastFailure.error;
    result.errorKind = lastFailure.errorKind;
    const triedAll = (result.chatAttempts ?? 0) >= candidates.length;
    const advice = result.listOk
      ? `模型列表可读，但对话失败：请确认模型 "${lastFailure.model}" 是否有权限/是否已开通，以及 Base URL 是否需要 /v1。`
        + (triedAll && candidates.length > 1 ? `（已依次尝试 ${candidates.length} 个候选模型）` : '')
      : hintFor(lastFailure.errorKind);
    result.hint = result.providerMessage
      ? `供应商原话：${result.providerMessage}；${advice}`
      : advice;
  } else {
    result.error = '对话探测未取得结果';
    result.errorKind = 'unknown';
    result.hint = hintFor('unknown');
  }
  return result;
}
