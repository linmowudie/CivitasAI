/**
 * @module Decision/ComplexityAssessor
 * @description
 * 复杂度评估器——Docs/03 §3.2。
 * Phase 0-2：基于启发式规则评估；后续可接 LLM 评估。
 */

import type { ComplexityReport } from '../types.js';
import type { Result } from '../../../Infra/types.js';
import { ok, err } from '../../../Infra/types.js';

// ── 评估输入 ────────────────────────────────────────────────────────

export interface AssessmentInput {
  taskDescription: string;
  userRequest?: string;
  // 可选提示（后续 LLM 评估时使用）
  hint?: {
    estimatedTokens?: number;
    requiredDomains?: string[];
    subtaskCount?: number;
  };
}

// ── 已知 SOP 模板（Phase 0-2 硬编码，后续可配置化）────────────────

const KNOWN_SOPS: Array<{ id: string; keywords: string[]; domain: string }> = [
  { id: 'sop-code-review', keywords: ['review', 'code', '审查', '代码审查'], domain: 'backend' },
  { id: 'sop-data-migration', keywords: ['migrate', 'migration', 'data', '迁移'], domain: 'database' },
  { id: 'sop-api-design', keywords: ['api', 'rest', 'endpoint', '接口'], domain: 'backend' },
  { id: 'sop-frontend-component', keywords: ['component', 'ui', 'frontend', '组件', '界面'], domain: 'frontend' },
];

// ── 专业域关键词映射 ────────────────────────────────────────────────

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  backend: ['server', 'api', 'database', 'backend', '后端', '接口', '数据库', '服务'],
  frontend: ['ui', 'frontend', 'component', 'page', '前端', '界面', '组件', '页面'],
  database: ['database', 'sql', 'migration', 'schema', '数据库', '表结构', '迁移'],
  devops: ['deploy', 'docker', 'ci', 'cd', '部署', '容器', '流水线'],
  testing: ['test', 'testing', 'benchmark', '测试', '基准'],
  security: ['auth', 'security', 'encrypt', '认证', '安全', '加密'],
};

// ── 评估核心 ────────────────────────────────────────────────────────

/**
 * 评估任务复杂度。
 * Phase 0-2：基于关键词启发式 + 文本长度估算。
 */
export function assessComplexity(input: AssessmentInput): Result<ComplexityReport> {
  if (!input.taskDescription || input.taskDescription.trim().length === 0) {
    return err('任务描述不能为空');
  }

  const text = input.taskDescription.toLowerCase();

  // 1. 识别所需专业域
  const requiredDomains = input.hint?.requiredDomains ?? detectDomains(text);

  // 2. 估算 Token 消耗（启发式：中文约 1.5 char/token，英文约 4 char/token）
  const estimatedTokens = input.hint?.estimatedTokens ?? estimateTokens(input.taskDescription);

  // 3. 计算耦合度（域越多、关键词交叉越多，耦合度越高）
  const couplingScore = calculateCoupling(requiredDomains, text);

  // 4. 建议子任务数
  const subtaskCount = input.hint?.subtaskCount ?? estimateSubtaskCount(requiredDomains, couplingScore, estimatedTokens);

  // 5. SOP 匹配
  const matchedSop = matchSop(text);

  // 6. 风险评估
  const riskLevel = assessRisk(estimatedTokens, requiredDomains.length, couplingScore);

  // 7. 潜在冲突
  const potentialConflicts = detectPotentialConflicts(requiredDomains, couplingScore);

  return ok({
    estimatedTokens,
    requiredDomains,
    couplingScore,
    subtaskCount,
    hasSopMatch: matchedSop !== null,
    matchedSopId: matchedSop ?? undefined,
    riskLevel,
    potentialConflicts,
    assessedAt: Date.now(),
    assessorModel: 'heuristic-v1',
    confidenceScore: calculateConfidence(input),
  });
}

// ── 内部辅助 ────────────────────────────────────────────────────────

function detectDomains(text: string): string[] {
  const detected: string[] = [];
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      detected.push(domain);
    }
  }
  return detected.length > 0 ? detected : ['general'];
}

function estimateTokens(text: string): number {
  // 粗略估算：中文字符 ~1.5 char/token，英文 ~4 char/token
  let chineseChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      chineseChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(chineseChars / 1.5 + otherChars / 4) + 500; // +500 基础开销
}

function calculateCoupling(domains: string[], text: string): number {
  if (domains.length <= 1) return 0.1;
  // 域越多耦合度越高，上限 1.0
  const base = Math.min(domains.length * 0.2, 0.8);
  // 如果文本中包含跨域关键词（如"前后端联调"），增加耦合度
  const crossDomainKeywords = ['联调', '集成', 'interface', 'integration', '全栈', 'fullstack'];
  const hasCrossDomain = crossDomainKeywords.some(kw => text.includes(kw));
  return Math.min(base + (hasCrossDomain ? 0.2 : 0), 1.0);
}

function estimateSubtaskCount(domains: string[], couplingScore: number, tokens: number): number {
  // 基础：每域一个子任务
  let count = Math.max(domains.length, 1);
  // 耦合度高 → 减少并行度（需要更多协调）
  if (couplingScore > 0.6) count = Math.max(Math.ceil(count * 0.7), 1);
  // Token 多 → 可能需要更多子任务
  if (tokens > 30000) count = Math.max(count, 3);
  return count;
}

function matchSop(text: string): string | null {
  for (const sop of KNOWN_SOPS) {
    const matchCount = sop.keywords.filter(kw => text.includes(kw)).length;
    if (matchCount >= 2) return sop.id;
  }
  return null;
}

function assessRisk(tokens: number, domainCount: number, coupling: number): ComplexityReport['riskLevel'] {
  const score = (tokens > 50000 ? 2 : tokens > 20000 ? 1 : 0)
    + (domainCount >= 3 ? 2 : domainCount >= 2 ? 1 : 0)
    + (coupling > 0.7 ? 2 : coupling > 0.4 ? 1 : 0);

  if (score >= 5) return 'critical';
  if (score >= 3) return 'high';
  if (score >= 1) return 'medium';
  return 'low';
}

function detectPotentialConflicts(domains: string[], coupling: number): string[] {
  const conflicts: string[] = [];
  if (domains.includes('frontend') && domains.includes('backend')) {
    conflicts.push('前后端接口契约可能不一致');
  }
  if (domains.includes('database') && domains.length > 1) {
    conflicts.push('数据库 Schema 变更可能影响多域');
  }
  if (coupling > 0.6) {
    conflicts.push('高耦合任务并行执行时可能产生竞态');
  }
  return conflicts;
}

function calculateConfidence(input: AssessmentInput): number {
  // 有 hint 时置信度高
  if (input.hint && Object.keys(input.hint).length >= 2) return 0.85;
  // 文本越长信息越多，置信度越高
  const len = input.taskDescription.length;
  if (len > 500) return 0.7;
  if (len > 100) return 0.5;
  return 0.3;
}

// ── 清理（测试用）──────────────────────────────────────────────────

export function resetAssessor(): void {
  // Phase 0-2 无状态，预留接口
}
