/**
 * @module SharedMemory/memoryGovernance
 * @description 共享记忆的**治理策略**（2026-10-04 新增，落地灵感源《一些思考2》§1.3 / §3.3）。
 *
 * 灵感源原文（`一些思考2.md`）：
 *  - §1.3 分层：**共享层**（messages / task_context，全员可读写）／**隔离层**
 *    （internal_scratchpad / draft_content，子图执行期，父图结束即丢弃）；
 *  - §3.3 写入守卫：拦截器提取语义与元数据 → **相似度碰撞（>0.85 且语义相反）→ 阻断并上报
 *    `CONFLICT_DETECTED` → 打包新旧记忆 ID 发给仲裁者**。
 *
 * 本模块补齐三项落地：
 *  1. **键分层**（classifyKeyTier）：治理键、隔离键、普通共享键；
 *  2. **写入权限**（requireWritePermission）：治理键仅 L0/所有者可写；隔离键不得写入共享层；
 *  3. **语义冲突检测**（detectSemanticConflict）：词元 Jaccard 相似度 ≥ 阈值 + 否定极性相反
 *     → 判定冲突（不依赖外部向量库的**可插拔**实现；接入向量检索后可直接替换相似度函数）。
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { requireGovernanceRole, isGovernanceRole } from '../Governance/governanceGuard.js';

/** 记忆键的层级归属（灵感源 §1.3） */
export type MemoryTier = 'governance' | 'shared' | 'private';

/** 治理键前缀：这些内容属于裁决/规则/通告等治理产出 */
const GOVERNANCE_KEY_PREFIXES = [
  'regulation.',    // 监管立法与执法（含广播）
  'governance.',
  'verdict.',       // 裁决
  'rule.',          // 行为规则
  'arbitration.',
];

/** 隔离键前缀：中间推理/草稿，**不得**进入共享层（应留在子图私有状态） */
const PRIVATE_KEY_PREFIXES = [
  'internal_scratchpad',
  'draft.',
  'private.',
  'scratchpad.',
  'reasoning.',     // 中间推理过程
];

/** 判定键的层级 */
export function classifyKeyTier(key: string): MemoryTier {
  const k = key.trim().toLowerCase();
  if (PRIVATE_KEY_PREFIXES.some(p => k.startsWith(p))) return 'private';
  if (GOVERNANCE_KEY_PREFIXES.some(p => k.startsWith(p))) return 'governance';
  return 'shared';
}

/** 语义冲突阈值（灵感源 §3.3：相似度 > 0.85） */
export const CONFLICT_SIMILARITY_THRESHOLD = 0.85;

/** 否定/相反极性标记（借鉴 MongoTerminalAgent `LogicContinuity` 的 `_NEGATION_PATTERN` 思路） */
const NEGATION_PATTERN = /(不|无法|不能|不可能|不应该|没有|未|非|无|失败|错误|禁止|不得|取消|撤销|禁用|阻止|not|no|never|disable|reject|deny)/i;

/**
 * 极性词表（肯定 + 否定），用于剥离"模态"以比较**命题本身**。
 *
 * 为什么需要：灵感源 §3.3 的"相似度 > 0.85 且语义相反"指的是**语义**相似度。
 * 直接对原句做词元重叠会因"允许/禁止"这类模态词拉低相似度（实测 0.64 < 0.85），
 * 导致真冲突漏判。正确做法是：**先剥掉模态词，比较命题；再单独判定极性相反**。
 */
const POLARITY_WORDS = [
  '不允许', '不应该', '不可以', '不得', '禁止', '禁用', '取消', '撤销', '阻止', '拒绝',
  '不能', '无法', '没有', '不再', '无需',
  '允许', '可以', '应当', '应该', '必须', '需要', '启用', '开启', '支持',
  'not', 'no', 'never', 'disable', 'disabled', 'reject', 'deny', 'forbid', 'allow', 'allowed', 'enable', 'enabled', 'must', 'should',
];

/** 剥离极性/模态词，得到"命题"文本 */
export function proposition(text: string): string {
  let out = text.toLowerCase();
  // 长词优先，避免"不允许"被"允许"先截断
  for (const w of [...POLARITY_WORDS].sort((a, b) => b.length - a.length)) {
    out = out.split(w).join(' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** 词元化：拆出中英文词元（中文按 2-gram + 关键词，英文按单词） */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9_]{2,}/g) ?? []) tokens.add(w);
  const cjk = lower.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk.slice(i, i + 2));
  return tokens;
}

/** Jaccard 相似度（可插拔：接入向量检索后替换此函数即可） */
export function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** 极性是否相反（一方含否定标记、另一方不含） */
export function polarityConflicts(a: string, b: string): boolean {
  return NEGATION_PATTERN.test(a) !== NEGATION_PATTERN.test(b);
}

/**
 * 语义冲突检测（灵感源 §3.3）。
 *
 * @returns 冲突时返回说明，否则 null
 */
export function detectSemanticConflict(newContent: string, existingContent: string): string | null {
  // 先在"命题"层面比较（剥掉允许/禁止这类模态词），再单独判定极性
  const sim = similarity(proposition(newContent), proposition(existingContent));
  if (sim < CONFLICT_SIMILARITY_THRESHOLD) return null;
  if (!polarityConflicts(newContent, existingContent)) return null;
  return `语义碰撞：命题相似度 ${sim.toFixed(3)} ≥ ${CONFLICT_SIMILARITY_THRESHOLD} 且极性相反`;
}

/**
 * 写入权限校验（灵感源 §1.3 分层 + 本项目治理规则）。
 *
 * - 治理键：必须 L0 / 人类所有者；
 * - 隔离键：**拒绝写入共享层**（应留在子图私有状态，防止中间过程污染全局记忆）；
 * - 普通共享键：放行（全员可读写）。
 *
 * @param actorRole 写入者角色；`agentId` 形如 `governance:<role>` 时也会被解析
 */
export function requireWritePermission(params: {
  key: string;
  actorRole?: string;
  agentId?: string;
}): Result<MemoryTier> {
  const tier = classifyKeyTier(params.key);

  if (tier === 'private') {
    return err(
      `写入被拒绝：key "${params.key}" 属**隔离层**（中间推理/草稿），不得写入共享记忆（灵感源 §1.3 中间过程物理隔离）`,
    );
  }

  if (tier === 'governance') {
    // 角色可显式给出，也可从 agentId 的 `governance:<role>` 形式解析
    const role = params.actorRole
      ?? (params.agentId?.startsWith('governance:') ? params.agentId.slice('governance:'.length) : undefined);
    if (!isGovernanceRole(role)) {
      const guard = requireGovernanceRole(role, `写入治理记忆键 "${params.key}"`);
      return err(guard.ok ? '写入被拒绝' : guard.error);
    }
  }

  return ok(tier);
}
