/**
 * @module Scripts/rubricRecalibrate
 * @description
 * 评分标准重校准——Docs/14 §S14。
 * 用人工标注集对比 LLM Judge 评分，计算一致率。
 * 目标：一致率 ≥ 85%。
 * 用法：npx tsx Scripts/rubricRecalibrate.ts
 */

// ── 标注数据结构 ────────────────────────────────────────────────────

interface AnnotationSample {
  sampleId: string;
  taskDescription: string;
  agentOutput: string;
  humanScore: number;       // 人工评分 0-100
  judgeScore: number;       // LLM Judge 评分 0-100
}

interface CalibrationResult {
  totalSamples: number;
  consistentCount: number;
  consistencyRate: number;
  averageDeviation: number;
  maxDeviation: number;
  threshold: number;
  passed: boolean;
}

// ── 人工标注集（Phase 0-2：内置示例）──────────────────────────────

const ANNOTATION_DATASET: AnnotationSample[] = [
  {
    sampleId: 'ann-1',
    taskDescription: '创建 add 函数',
    agentOutput: 'function add(a, b) { return a + b; }',
    humanScore: 90,
    judgeScore: 88,
  },
  {
    sampleId: 'ann-2',
    taskDescription: '设计 REST API',
    agentOutput: 'GET /api/users, POST /api/users, ...',
    humanScore: 75,
    judgeScore: 78,
  },
  {
    sampleId: 'ann-3',
    taskDescription: '修复 bug',
    agentOutput: '修改了第 42 行的条件判断',
    humanScore: 85,
    judgeScore: 82,
  },
  {
    sampleId: 'ann-4',
    taskDescription: '编写测试',
    agentOutput: 'describe("test", () => { it("works", ...) })',
    humanScore: 70,
    judgeScore: 72,
  },
  {
    sampleId: 'ann-5',
    taskDescription: '代码重构',
    agentOutput: '提取了公共函数，消除了重复代码',
    humanScore: 80,
    judgeScore: 76,
  },
];

// ── 校准函数 ────────────────────────────────────────────────────────

const DEVIATION_THRESHOLD = 10; // 分差 ≤ 10 视为一致
const CONSISTENCY_TARGET = 0.85; // 目标一致率 85%

export function calibrate(
  dataset: AnnotationSample[] = ANNOTATION_DATASET,
  threshold: number = DEVIATION_THRESHOLD,
): CalibrationResult {
  let consistentCount = 0;
  const deviations: number[] = [];

  for (const sample of dataset) {
    const deviation = Math.abs(sample.humanScore - sample.judgeScore);
    deviations.push(deviation);

    if (deviation <= threshold) {
      consistentCount++;
    }
  }

  const consistencyRate = dataset.length > 0 ? consistentCount / dataset.length : 0;
  const avgDeviation = deviations.length > 0
    ? deviations.reduce((s, d) => s + d, 0) / deviations.length
    : 0;

  return {
    totalSamples: dataset.length,
    consistentCount,
    consistencyRate,
    averageDeviation: avgDeviation,
    maxDeviation: deviations.length > 0 ? Math.max(...deviations) : 0,
    threshold,
    passed: consistencyRate >= CONSISTENCY_TARGET,
  };
}

// ── 建议调整 ────────────────────────────────────────────────────────

export function suggestAdjustments(result: CalibrationResult): string[] {
  const suggestions: string[] = [];

  if (!result.passed) {
    suggestions.push(`一致率 ${result.consistencyRate.toFixed(1%)} 低于目标 ${CONSISTENCY_TARGET * 100}%`);
    suggestions.push('建议：增加 Judge 提示词中的评分维度说明');
    suggestions.push('建议：补充更多边界案例到标注集');
  }

  if (result.maxDeviation > 20) {
    suggestions.push(`最大偏差 ${result.maxDeviation} 分，建议检查极端案例`);
  }

  if (result.averageDeviation > 8) {
    suggestions.push(`平均偏差 ${result.averageDeviation.toFixed(1)} 分，建议校准 Judge 评分尺度`);
  }

  if (suggestions.length === 0) {
    suggestions.push('校准通过，Judge 评分与人工标注一致率达标');
  }

  return suggestions;
}

// ── CLI 入口 ────────────────────────────────────────────────────────

if (process.argv[1]?.includes('rubricRecalibrate')) {
  const result = calibrate();
  const suggestions = suggestAdjustments(result);

  console.log('=== Rubric Recalibration ===');
  console.log(`总样本: ${result.totalSamples}`);
  console.log(`一致数: ${result.consistentCount}`);
  console.log(`一致率: ${(result.consistencyRate * 100).toFixed(1)}%`);
  console.log(`平均偏差: ${result.averageDeviation.toFixed(1)} 分`);
  console.log(`最大偏差: ${result.maxDeviation} 分`);
  console.log(`通过: ${result.passed ? '✅' : '❌'}`);
  console.log('\n建议:');
  for (const s of suggestions) {
    console.log(`  - ${s}`);
  }
}
