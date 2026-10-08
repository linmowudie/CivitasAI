/**
 * 由 API 地址识别供应商（2026-10-08）。
 *
 * 需求：用户在「添加供应商」里**不选供应商**时，只填「地址 + 密钥」即可——
 * 供应商由地址自动识别；选了供应商则地址自动填充（仍可手改）。
 *
 * 判定只依赖 host（外加少量路径特征），不做网络请求：
 * 识别失败不是错误，退化为通用 `自定义供应商`（OpenAI 兼容协议）。
 */

export interface DetectedProvider {
  /** 供应商标识（与 PRESET_PROVIDERS 的 id 对齐；未知时为 'custom'） */
  id: string;
  /** 展示名 */
  name: string;
  /** 识别依据，供界面提示"为什么是它" */
  matchedBy: string;
}

interface DetectRule {
  id: string;
  name: string;
  /** host 关键字（任一命中即可） */
  hosts: string[];
  /** 可选的路径特征，进一步确认（如 dashscope 的 compatible-mode） */
  pathHint?: string;
}

/** 规则表：按"越具体越靠前"排列 */
const RULES: DetectRule[] = [
  { id: 'huawei-maas', name: '华为云 MaaS', hosts: ['modelarts-maas.com', 'modelarts.myhuaweicloud.com', 'huaweicloud.com'] },
  { id: 'dashscope', name: '阿里通义', hosts: ['dashscope.aliyuncs.com', 'aliyuncs.com'], pathHint: 'compatible-mode' },
  { id: 'qianfan', name: '百度文心', hosts: ['qianfan.baidubce.com', 'baidubce.com'] },
  { id: 'zhipu', name: '智谱 AI', hosts: ['open.bigmodel.cn', 'bigmodel.cn'] },
  { id: 'deepseek', name: 'DeepSeek', hosts: ['api.deepseek.com', 'deepseek.com'] },
  { id: 'moonshot', name: '月之暗面', hosts: ['api.moonshot.cn', 'moonshot.cn'] },
  { id: 'minimax', name: 'MiniMax', hosts: ['api.minimax.chat', 'minimaxi.com', 'minimax.io'] },
  { id: 'lingyi', name: '零一万物', hosts: ['api.lingyiwanwu.com', 'lingyiwanwu.com'] },
  { id: 'openai', name: 'OpenAI', hosts: ['api.openai.com', 'openai.azure.com'] },
  { id: 'anthropic', name: 'Anthropic', hosts: ['api.anthropic.com'] },
  { id: 'google', name: 'Google Gemini', hosts: ['generativelanguage.googleapis.com'] },
  { id: 'mistral', name: 'Mistral', hosts: ['api.mistral.ai'] },
  { id: 'groq', name: 'Groq', hosts: ['api.groq.com'] },
  { id: 'siliconflow', name: '硅基流动', hosts: ['api.siliconflow.cn', 'siliconflow.cn'] },
  { id: 'openrouter', name: 'OpenRouter', hosts: ['openrouter.ai'] },
  { id: 'together', name: 'Together AI', hosts: ['api.together.xyz', 'together.ai'] },
  { id: 'ollama', name: 'Ollama（本地）', hosts: ['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal'] },
];

/** 归一化：去空白、去尾斜杠（大小写保留在 URL 里，比较时再降级） */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** 是否是形状合法的 http(s) 地址（不强求可达） */
export function isValidHttpUrl(url: string): boolean {
  const v = normalizeBaseUrl(url);
  if (!v) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

/**
 * 由地址识别供应商。
 * @returns 命中返回供应商标识；无法识别返回 null（调用方退化为"自定义供应商"）
 */
export function detectProviderByUrl(url: string): DetectedProvider | null {
  const v = normalizeBaseUrl(url);
  if (!isValidHttpUrl(v)) return null;

  let host = '';
  let pathname = '';
  try {
    const u = new URL(v);
    host = u.hostname.toLowerCase();
    pathname = u.pathname.toLowerCase();
  } catch {
    return null;
  }

  for (const rule of RULES) {
    const hit = rule.hosts.find((h) => host === h || host.endsWith(`.${h}`) || host.includes(h));
    if (!hit) continue;
    // 路径特征存在时要求同时满足，避免把同域其它服务误判
    if (rule.pathHint && !pathname.includes(rule.pathHint)) continue;
    return { id: rule.id, name: rule.name, matchedBy: hit };
  }
  return null;
}

/** 界面用的显示名：识别到就用识别结果，否则"自定义供应商" */
export function resolveProviderLabel(url: string): { id: string; name: string; detected: boolean } {
  const d = detectProviderByUrl(url);
  return d
    ? { id: d.id, name: d.name, detected: true }
    : { id: 'custom', name: '自定义供应商', detected: false };
}
