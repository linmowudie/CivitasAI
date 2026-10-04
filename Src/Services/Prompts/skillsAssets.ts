/**
 * @module Services/Prompts/skillsAssets
 * @description
 * `Skills/` 资产的运行期装载与查询（FE-071 实装）。
 *
 * 修复背景：`Skills/` 此前唯一读取方为 `skillsApi`（前端只读视图，且仅列 `.md`——
 * 两个 `.json` 连 API 都不可见），**无任何运行时消费**。现装载并由真实链路消费：
 *  - `playbooks/*.md` → 执行级角色（worker/partner/assembly_node）的提示词补充（agentFactory）；
 *  - `rubrics/verifierL3Calibration.json` → L3 Judge 评审准则（performReview 的 rubric）；
 *  - `strategies/candidates.json` → 替代策略候选集（strategyLedger / no-progress 退出提示）；
 *  - `rules/behaviorCode.md` → 行为法典文档（regulationApi 响应附加）。
 *
 * 装载时机：main.ts 启动（⑩.2）与热加载（Skills/ 变更回调）；未装载时各消费点退化（向后兼容）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { getSkillsDir } from '../../Infra/Fs/pathResolver.js';
import { logger } from '../../Infra/Logging/logger.js';

// ── 类型 ────────────────────────────────────────────────────────────

export interface L3RubricDimension {
  name: string;
  weight: number;
  description: string;
}

export interface L3CalibrationData {
  version: string;
  rubricDimensions: L3RubricDimension[];
  calibrationTarget: {
    consistencyRate?: number;
    maxDeviation?: number;
    minSamples?: number;
    recalibrateIntervalDay?: number;
  };
}

export interface StrategyCandidate {
  id: string;
  strategy: string;
  category?: string;
  applicableWhen?: string;
  riskLevel?: string;
}

// ── 内部状态 ────────────────────────────────────────────────────────

let playbooks: Map<string, string> = new Map();
let l3Calibration: L3CalibrationData | null = null;
let strategyCandidates: StrategyCandidate[] = [];
let behaviorCodeMarkdown: string | null = null;

// ── 装载 ────────────────────────────────────────────────────────────

export interface SkillsAssetsLoadResult {
  playbooks: number;
  rubricLoaded: boolean;
  strategies: number;
  behaviorCodeLoaded: boolean;
}

/** 装载 Skills/ 资产（幂等覆盖；单文件失败降级跳过，不阻断启动） */
export function loadSkillsAssets(dir: string = getSkillsDir()): SkillsAssetsLoadResult {
  // playbooks（全部 .md）
  playbooks = new Map();
  const playbookDir = join(dir, 'playbooks');
  if (existsSync(playbookDir)) {
    try {
      for (const file of readdirSync(playbookDir)) {
        if (!file.endsWith('.md')) continue;
        try {
          const content = readFileSync(join(playbookDir, file), 'utf-8').trim();
          if (content) playbooks.set(file.slice(0, -3), content);
        } catch { /* 单文件失败跳过 */ }
      }
    } catch { /* 目录读取失败跳过 */ }
  }

  // rubrics/verifierL3Calibration.json
  l3Calibration = null;
  const rubricPath = join(dir, 'rubrics', 'verifierL3Calibration.json');
  try {
    if (existsSync(rubricPath)) {
      const parsed = JSON.parse(readFileSync(rubricPath, 'utf-8')) as {
        version?: string;
        rubricDimensions?: L3RubricDimension[];
        calibrationTarget?: L3CalibrationData['calibrationTarget'];
      };
      if (Array.isArray(parsed.rubricDimensions) && parsed.rubricDimensions.length > 0) {
        l3Calibration = {
          version: parsed.version ?? 'unknown',
          rubricDimensions: parsed.rubricDimensions,
          calibrationTarget: parsed.calibrationTarget ?? {},
        };
      }
    }
  } catch (e) {
    logger.warn('L3 校准资产解析失败（降级：使用内置评审准则）', {
      source: 'skillsAssets',
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // strategies/candidates.json
  strategyCandidates = [];
  const strategyPath = join(dir, 'strategies', 'candidates.json');
  try {
    if (existsSync(strategyPath)) {
      const parsed = JSON.parse(readFileSync(strategyPath, 'utf-8')) as {
        candidates?: StrategyCandidate[];
      };
      if (Array.isArray(parsed.candidates)) {
        strategyCandidates = parsed.candidates.filter(c => c.id && c.strategy);
      }
    }
  } catch (e) {
    logger.warn('策略候选资产解析失败（降级：无候选）', {
      source: 'skillsAssets',
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // rules/behaviorCode.md
  behaviorCodeMarkdown = null;
  const behaviorPath = join(dir, 'rules', 'behaviorCode.md');
  try {
    if (existsSync(behaviorPath)) {
      const content = readFileSync(behaviorPath, 'utf-8').trim();
      behaviorCodeMarkdown = content || null;
    }
  } catch { /* 跳过 */ }

  const result: SkillsAssetsLoadResult = {
    playbooks: playbooks.size,
    rubricLoaded: l3Calibration !== null,
    strategies: strategyCandidates.length,
    behaviorCodeLoaded: behaviorCodeMarkdown !== null,
  };
  logger.info('Skills 资产装载完成', { source: 'skillsAssets', ...result });
  return result;
}

// ── 查询 ────────────────────────────────────────────────────────────

/** 任务 Playbook（按文件名；未装载返回 null）——agentFactory 对执行级角色注入 */
export function getPlaybook(name: string): string | null {
  return playbooks.get(name) ?? null;
}

/** L3 Judge 校准数据（未装载返回 null） */
export function getL3Calibration(): L3CalibrationData | null {
  return l3Calibration;
}

/**
 * L3 Judge 评审准则（由校准资产的 rubricDimensions 生成；未装载返回 null）。
 * 供 performReview 构建 L3 spec 使用（校准即配置源）。
 */
export function getL3Rubric(): string[] | null {
  if (!l3Calibration) return null;
  return l3Calibration.rubricDimensions.map(
    d => `${d.name}（权重 ${d.weight}）：${d.description}`,
  );
}

/** 替代策略候选集（副本） */
export function getStrategyCandidates(): StrategyCandidate[] {
  return strategyCandidates.map(c => ({ ...c }));
}

/** 行为法典文档（markdown；未装载返回 null）——regulationApi 附加说明 */
export function getBehaviorCodeMarkdown(): string | null {
  return behaviorCodeMarkdown;
}

/** 测试/诊断用：清空全部 Skills 资产 */
export function resetSkillsAssets(): void {
  playbooks = new Map();
  l3Calibration = null;
  strategyCandidates = [];
  behaviorCodeMarkdown = null;
}
