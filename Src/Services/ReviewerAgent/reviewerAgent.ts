/**
 * @module ReviewerAgent/reviewerAgent
 * @description
 * 审核 Agent——Docs/Agent/13 §S9。
 * Maker-Checker 模式的 Checker 实例。
 * 审核 Worker 提交的成果，决定接受或拒绝。
 */

import { reviewSubmission } from '../../Core/AgentRuntime/agentRuntime.js';
import { getAgent, getAllAgents } from '../../Core/AgentRuntime/agentRegistry.js';
import { createAgent } from '../../Core/AgentRuntime/agentFactory.js';
import { getPendingReview } from '../../Core/AgentRuntime/agentRuntime.js';
import type { AgentInstance, SubmitResult } from '../../Core/AgentRuntime/types.js';
import type { Result } from '../../Infra/types.js';
import { err, ok } from '../../Infra/types.js';
import { resolveModel, getRoutingConfig, getRegisteredModels } from '../../Infra/Llm/Router/modelRouter.js';
import { runVerifierPipeline } from '../LoopControl/verifier/index.js';
import type { VerifierSpec, VerifierResult } from '../LoopControl/loopState.js';
import { getL3Rubric } from '../Prompts/skillsAssets.js';

// ── 审核策略 ────────────────────────────────────────────────────────

export type ReviewPolicy = 'strict' | 'moderate' | 'lenient';

export interface ReviewConfig {
  policy: ReviewPolicy;
  maxReviewTimeMs?: number;
  autoRejectOnTimeout?: boolean;
  /** 验证管线最少层数（ADR-0003；main.ts 从 loopConfig.json 的 verifier.minLevelsRequired 注入；缺省 2） */
  minLevelsRequired?: number;
  /**
   * L3 Judge 模型（全限定名，ADR-0004：必须与产出者不同）。
   * 缺省自动选择：routing.verifierModel → directorModel → arbitrationModels → defaultModel → 已注册模型；
   * 显式配置（含空串）完全接管——空串或与产出者相同表示显式禁用 L3（降级 L1+L2）。
   */
  judgeModel?: string;
  /** L3 通过分 minScore（0-1；缺省 0.6） */
  minScore?: number;
  /**
   * Judge 调用函数。**必须由组合根注入**（分层：Services 不可直接 import Core/Model）：
   * main.ts ⑮.1 注入真实 `callModel`；测试注入 mock。未注入而 L3 被选用时
   * 按 fail-closed 处理（judge 抛出 → 评审拒绝，不静默放行）。
   */
  callModelFn?: (model: string, prompt: string) => Promise<string>;
}

/** 评审配置默认值（含 minLevelsRequired=2 对齐 Configs/loopConfig.json 的 verifier 段） */
const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  policy: 'moderate',
  maxReviewTimeMs: 30000,
  autoRejectOnTimeout: true,
  minLevelsRequired: 2,
  minScore: 0.6,
};

let currentConfig: ReviewConfig = { ...DEFAULT_REVIEW_CONFIG };

/** L3 Judge 默认评审准则（调用方未传 criteria 时使用） */
const DEFAULT_REVIEW_RUBRIC: string[] = [
  '成果摘要与被分配任务的要求一致，无遗漏关键交付项',
  '成果具体可验证（有实质内容/文件产物说明），非空泛占位或过程性描述',
  '若声明了文件产物，其路径与用途描述自洽',
];

export function configureReviewer(config: Partial<ReviewConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

// ── Reviewer 实例供给（FE-050：生产代码此前无任何 reviewer 创建点）────────

/** Reviewer 模型标识（与 orchestrator 的 director-model / worker-model 命名对齐） */
const REVIEWER_MODEL = 'reviewer-model';

/**
 * 确保 trace 内存在一名可用的 Reviewer Agent。
 *
 * - 优先复用本 trace 内存活（非 destroyed / expelled）的 reviewer；
 * - 不存在则创建（Maker-Checker 的独立 Checker 实例，与提交者分离）。
 *
 * 调用方：`agent.submit_review` 工具（评审链路接线）。
 */
export function ensureReviewerAgent(traceId: string): Result<AgentInstance> {
  const existing = getAllAgents().find(
    (a) => a.traceId === traceId
      && a.role === 'reviewer'
      && a.status !== 'destroyed'
      && a.status !== 'expelled',
  );
  if (existing) return ok(existing);
  return createAgent({ role: 'reviewer', model: REVIEWER_MODEL }, traceId);
}

// ── 审核执行 ────────────────────────────────────────────────────────

/**
 * Reviewer Agent 执行审核（FE-056/FE-057：四级验证管线实装，替代“默认接受”桩）。
 *
 * 验证层级（ADR-0003 不可跳层）：
 * - L1 schema：提交结构完整性（summary 必填）；
 * - L2 rule：确定性规则（成果非空）；
 * - L3 llm_judge：独立 LLM Judge（ADR-0004：模型必须与产出者不同；无可用异模型时降级为 L1+L2）；
 * - L4 human_gate：评审链路暂不预置（高风险操作门控由工具安全门承担）。
 *
 * “完全实现”口径：判定由验证结果产生，不再是恒 true；Judge 不可用/失败时
 * 按 fail-closed 拒绝（管线异常时同样拒绝，不静默放行）。
 */
export async function performReview(params: {
  taskId: string;
  reviewerAgentId: string;
  criteria?: string[];
}): Promise<Result<SubmitResult>> {
  const review = getPendingReview(params.taskId);
  if (!review) return err(`Task ${params.taskId} 无待审记录`);

  const worker = getAgent(review.workerAgentId);
  if (!worker) return err(`Worker ${review.workerAgentId} 不存在`);

  const summary = typeof review.payload['summary'] === 'string' ? review.payload['summary'] : '';
  const artifacts = Array.isArray(review.payload['artifacts'])
    ? (review.payload['artifacts'] as unknown[]).map(String)
    : [];

  // ── 构建评审验证 spec（L1 结构 → L2 规则 → [L3 异模型 Judge]）──
  const specs = buildReviewSpecs({ producerModel: worker.model, criteria: params.criteria });

  const artifactText = [summary, ...artifacts].filter(Boolean).join('\n');
  const pipeline = await runVerifierPipeline(
    specs,
    {
      hard: { dataToValidate: { summary, artifacts } },
      rule: { artifact: artifactText },
      llm: {
        artifact: buildJudgeArtifact(params.taskId, summary, artifacts),
        producerModel: worker.model,
        callModel: (model, prompt) => (currentConfig.callModelFn ?? defaultJudgeCaller)(model, prompt),
      },
      human: { loopId: `review-${params.taskId}`, iteration: 0, requestedAt: Date.now() },
    },
    currentConfig.minLevelsRequired ?? 2,
  );

  const accepted = pipeline.ok && pipeline.value.allPassed;
  const comment = buildReviewComment(pipeline, specs);

  return reviewSubmission({
    taskId: params.taskId,
    reviewerAgentId: params.reviewerAgentId,
    accepted,
    comment,
  });
}

// ── 验证 spec 构建 ──────────────────────────────────────────────────

/** 构建默认评审 spec：L1 结构完整性 + L2 非空规则 + [L3 独立 Judge] */
function buildReviewSpecs(input: { producerModel: string; criteria?: string[] }): VerifierSpec[] {
  const specs: VerifierSpec[] = [
    // L1：提交结构完整性（summary 必填）
    { level: 'L1', kind: 'schema', payload: { jsonSchema: { type: 'object', required: ['summary'] } } },
    // L2：确定性规则——成果非空（质量判定交由 L3）
    { level: 'L2', kind: 'rule', payload: { expression: 'length >= 1' } },
  ];

  // L3：独立 LLM Judge（ADR-0004：模型必须与产出者不同）
  const judgeModel = pickJudgeModel(input.producerModel);
  if (judgeModel) {
    // rubric 优先级：显式 criteria > Skills 校准资产（rubricDimensions，FE-071）> 内置默认
    const calibrated = getL3Rubric();
    specs.push({
      level: 'L3',
      kind: 'llm_judge',
      payload: {
        model: judgeModel,
        rubric: input.criteria && input.criteria.length > 0
          ? input.criteria
          : (calibrated ?? DEFAULT_REVIEW_RUBRIC),
        minScore: currentConfig.minScore ?? 0.6,
        requireEvidence: true,
      },
    });
  }
  return specs;
}

/**
 * 选择 L3 Judge 模型（必须 ≠ 产出者模型，ADR-0004）。
 *
 * 规则：
 * - 显式配置（currentConfig.judgeModel）完全接管自动路径：
 *   · 非空且 ≠ 产出者 → 直接使用（不做注册检查，不可用时由 L3 调用失败 fail-closed 兜底）；
 *   · 空串或与产出者相同 → 显式禁用 L3（降级为 L1+L2）；
 * - 未配置 → 按 routing 候选依次取第一个“异模型且已注册”者；
 *   全部不可用时返回 null → 管线降级为 L1+L2（仍满足 minLevelsRequired=2）。
 */
function pickJudgeModel(producerModel: string): string | null {
  if (currentConfig.judgeModel !== undefined) {
    return currentConfig.judgeModel && currentConfig.judgeModel !== producerModel
      ? currentConfig.judgeModel
      : null;
  }

  const routing = getRoutingConfig();
  const candidates: string[] = [
    routing?.verifierModel ?? '',
    routing?.directorModel ?? '',
    ...(routing?.arbitrationModels ?? []),
    routing?.defaultModel ?? '',
    ...getRegisteredModels(),
  ].filter((m) => m.length > 0);

  for (const c of candidates) {
    if (c !== producerModel && resolveModel(c).ok) return c;
  }
  return null;
}

/** 注入的 Judge 调用器：未装配时抛错（fail-closed，不静默降级/伪造判定） */
async function defaultJudgeCaller(model: string, prompt: string): Promise<string> {
  const fn = currentConfig.callModelFn;
  if (!fn) {
    throw new Error('L3 Judge 调用器未装配（ReviewConfig.callModelFn；由组合根注入）');
  }
  return fn(model, prompt);
}

/** 组装供 Judge 评估的产物文本（任务与成果上下文） */
function buildJudgeArtifact(taskId: string, summary: string, artifacts: string[]): string {
  return [
    `Task ID: ${taskId}`,
    '',
    '## 成果摘要',
    summary,
    '',
    '## 产物路径',
    artifacts.length > 0 ? artifacts.map(a => `- ${a}`).join('\n') : '(未声明文件产物)',
  ].join('\n');
}

// ── 评审结论摘要 ────────────────────────────────────────────────────

/** 生成评审 comment（含层级/失败证据摘要；管线异常 fail-closed 明确标注） */
function buildReviewComment(
  pipeline: Result<{ results: VerifierResult[]; levelsRun: number; allPassed: boolean }>,
  specs: VerifierSpec[],
): string {
  const MAX = 500;

  if (!pipeline.ok) {
    return truncateComment(`验证管线异常（fail-closed 拒绝）：${pipeline.error}`, MAX);
  }

  const { results, levelsRun, allPassed } = pipeline.value;
  const levels = specs
    .map(s => s.level)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join('+');

  if (allPassed) {
    return truncateComment(
      `评审通过：${levels} 共 ${results.length} 项验证全过（layers=${levelsRun}）`,
      MAX,
    );
  }

  const failed = results.filter(r => !r.pass);
  const details = failed
    .map(r => {
      const ev = r.evidence[0];
      const brief = ev ? JSON.stringify(ev.data).slice(0, 160) : '';
      return `[${r.level} ${r.kind}] ${brief}`;
    })
    .join('；');
  return truncateComment(`评审未通过：${details || '验证失败'}`, MAX);
}

function truncateComment(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ── 清理 ────────────────────────────────────────────────────────────

export function resetReviewer(): void {
  currentConfig = { ...DEFAULT_REVIEW_CONFIG };
}
