/**
 * 六种工作方式可视化——共享类型 + 演示数据 + 通用工具。
 *
 * 数据源策略：
 *   1. 若后端 /api/tasks 返回的 TaskRecord 已带 routingMode / assignments / subtasks
 *      等结构化字段（Phase 3 计划扩展），则使用真实数据；
 *   2. 否则回落到本文件的演示数据 DEMO，用于展示每种工作方式的时间/进度样式。
 *
 * 每个可视化面板顶部均明确标注 "演示数据" / "实时数据" 徽标，避免误导。
 */

import type { TaskRecord } from '@/stores/taskStore';

// ── 通用类型 ─────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'suspended';

// DIRECT：单 Agent 流式响应
export interface DirectDemo {
  taskId: string;
  description: string;
  ttfb: number;         // 首字节延迟 (ms)
  totalDuration: number; // 总耗时 (ms)
  tokensConsumed: number;
  balanceAfter: number;
  status: StepStatus;
  outputPreview: string;
  streamTimeline: { ts: number; label: string }[];
}

// DELEGATION：Director 拆解 + N Worker 并行
export interface DelegationWorker {
  workerId: string;
  domain: string;
  start: number;   // 相对 traceStart 的毫秒偏移
  end: number;
  status: StepStatus;
  tokensConsumed: number;
}
export interface DelegationDemo {
  description: string;
  directorStart: number;
  directorEnd: number;
  aggregateStart: number;
  aggregateEnd: number;
  workers: DelegationWorker[];
}

// ASSEMBLY_LINE：串行 SOP 流水线
export interface AssemblyNode {
  nodeId: string;
  name: string;
  start: number;
  end: number;
  handoffDelay: number; // 到下一节点的传递延迟
  status: StepStatus;
}
export interface AssemblyLineDemo {
  sopName: string;
  description: string;
  nodes: AssemblyNode[];
}

// CONSORTIUM：多 Partner 并行 + 独立钱包 + 屏障
export interface ConsortiumPartner {
  partnerId: string;
  domain: string;
  walletInitial: number;
  walletBalance: number;
  start: number;
  end: number;
  status: StepStatus;
}
export interface ConsortiumDemo {
  description: string;
  partners: ConsortiumPartner[];
  barrierAt: number; // 全局收敛屏障时点
  finalStatus: StepStatus;
}

// LITIGATION：六步闭环 + 3 仲裁者
export interface LitigationStep {
  key: 'filed' | 'assembling' | 'reasoning' | 'verdict_ready' | 'suspended' | 'restoring' | 'completed';
  label: string;
  ts: number;
  status: StepStatus;
  event: string;
}
export interface ArbitratorVerdict {
  arbitratorId: string;
  model: string;
  choice: 'new_wins' | 'old_wins' | 'merge' | 'abstract';
  reasoning: string;
  latencyMs: number;
}
export interface LitigationDemo {
  caseId: string;
  conflictType: string;
  steps: LitigationStep[];
  verdicts: ArbitratorVerdict[];
  isUnanimous: boolean;
  isDeadlocked: boolean;
  escalatedToRegulator: boolean;
}

// REGULATION：广播 + ACK
export interface AckTarget {
  agentId: string;
  role: string;
  deliveredAt: number;   // 相对发出时刻的毫秒偏移
  ackedAt: number | null; // null = 尚未确认
}
export interface RegulationDemo {
  broadcastId: string;
  type: 'rule_update' | 'emergency_alert' | 'verdict_notice' | 'patrol_result';
  title: string;
  issuedAt: number;
  ackDeadlineMs: number; // ACK 截止时间（从 issuedAt 起）
  targets: AckTarget[];
}

// AUDIT：消耗曲线 + 阈值 + 冻结
export interface AuditSample {
  ts: number;
  tokens: number;
}
export interface AuditAnomaly {
  ts: number;
  level: 'warn' | 'soft' | 'critical';
  rule: 'rolling' | 'deviation' | 'loop';
  message: string;
}
export interface AuditFreezeWindow {
  start: number;
  end: number | null; // null = 仍在冻结
  reason: string;
}
export interface AuditDemo {
  agentId: string;
  rollingBudgetTokens: number;
  samples: AuditSample[];
  anomalies: AuditAnomaly[];
  freezeWindows: AuditFreezeWindow[];
  verdict: {
    finding: 'false_positive' | 'confirmed_anomaly' | 'attack' | 'pending';
    action: 'none' | 'throttle' | 'confiscate' | 'destroy';
    investigatedAt: number | null;
  };
}

// ── 工具函数 ──────────────────────────────────────────

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(0);
  return `${m}m${s.padStart(2, '0')}s`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

export const STATUS_COLOR: Record<StepStatus, string> = {
  pending:   '#6b7280',
  running:   '#06b6d4',
  done:      '#10b981',
  failed:    '#ef4444',
  suspended: '#f59e0b',
};

export const STATUS_LABEL: Record<StepStatus, string> = {
  pending:   '待处理',
  running:   '执行中',
  done:      '已完成',
  failed:    '失败',
  suspended: '挂起',
};

// 判断是否可以使用真实数据；当前后端未提供 routingMode，返回 false → 走演示数据
export function pickRealOrDemo<T extends { taskId?: string }>(_tasks: TaskRecord[], _demo: T): { source: 'real' | 'demo'; data: T } {
  return { source: 'demo', data: _demo };
}

// ── 演示数据 ──────────────────────────────────────────

const NOW = Date.now();

export const DEMO_DIRECT: DirectDemo = {
  taskId: 'demo-direct-001',
  description: '用一句话解释什么是递归',
  ttfb: 620,
  totalDuration: 3480,
  tokensConsumed: 464,
  balanceAfter: 9536,
  status: 'done',
  outputPreview: '递归就是函数自己调用自己，将大问题不断拆解为同类的更小问题，直到满足终止条件再逐层返回。',
  streamTimeline: [
    { ts: 0, label: '任务接收' },
    { ts: 120, label: '复杂度评估 → DIRECT' },
    { ts: 280, label: 'Director 启动' },
    { ts: 620, label: '模型首字（TTFB）' },
    { ts: 3480, label: '流式结束' },
    { ts: 3560, label: 'Token 扣减' },
  ],
};

export const DEMO_DELEGATION: DelegationDemo = {
  description: '开发一个前后端 + 数据库的用户管理 CRUD 应用',
  directorStart: 0,
  directorEnd: 2400,
  aggregateStart: 12_800,
  aggregateEnd: 13_900,
  workers: [
    { workerId: 'w-backend',  domain: 'backend',  start: 2400, end: 9800,  status: 'done',    tokensConsumed: 2840 },
    { workerId: 'w-frontend', domain: 'frontend', start: 2400, end: 12600, status: 'done',    tokensConsumed: 3210 },
    { workerId: 'w-database', domain: 'database', start: 2400, end: 7400,  status: 'done',    tokensConsumed: 1980 },
    { workerId: 'w-testing',  domain: 'testing',  start: 12600, end: 12800, status: 'running', tokensConsumed: 460 },
  ],
};

export const DEMO_ASSEMBLY: AssemblyLineDemo = {
  sopName: 'sop-code-review',
  description: '对 PR #42 做一次完整的代码审查',
  nodes: [
    { nodeId: 'n1', name: '静态分析',   start: 0,     end: 3200,  handoffDelay: 220, status: 'done' },
    { nodeId: 'n2', name: '安全扫描',   start: 3420,  end: 6900,  handoffDelay: 180, status: 'done' },
    { nodeId: 'n3', name: '风格校验',   start: 7080,  end: 9200,  handoffDelay: 240, status: 'running' },
    { nodeId: 'n4', name: '审查报告',   start: 9440,  end: 12800, handoffDelay: 0,   status: 'pending' },
  ],
};

export const DEMO_CONSORTIUM: ConsortiumDemo = {
  description: '秒杀系统：架构 + 前端 + 后端 + 库存一致性 + 上线部署',
  partners: [
    { partnerId: 'p-arch',   domain: '架构',   walletInitial: 10000, walletBalance: 9390, start: 0,     end: 6800,  status: 'done' },
    { partnerId: 'p-frontend', domain: '前端', walletInitial: 10000, walletBalance: 9434, start: 400,   end: 8200,  status: 'done' },
    { partnerId: 'p-backend', domain: '后端',  walletInitial: 10000, walletBalance: 8120, start: 400,   end: 14400, status: 'running' },
    { partnerId: 'p-stock',   domain: '库存',  walletInitial: 10000, walletBalance: 9610, start: 6800,  end: 15200, status: 'running' },
    { partnerId: 'p-devops',  domain: '部署',  walletInitial: 10000, walletBalance: 9880, start: 14400, end: 16000, status: 'pending' },
  ],
  barrierAt: 16000,
  finalStatus: 'running',
};

export const DEMO_LITIGATION: LitigationDemo = {
  caseId: 'arb-2026-0914-001',
  conflictType: 'semantic_opposition',
  steps: [
    { key: 'filed',        label: '立案',   ts: 0,     status: 'done', event: 'ARBITRATION_FILED' },
    { key: 'assembling',   label: '胶囊组装', ts: 800,  status: 'done', event: 'CAPSULE_ASSEMBLED' },
    { key: 'reasoning',    label: '裁决推理', ts: 2400, status: 'done', event: 'VERDICT_REASONING' },
    { key: 'verdict_ready', label: '裁决就绪', ts: 8600, status: 'done', event: 'ARBITRATION_VERDICT' },
    { key: 'suspended',    label: '律师函挂起', ts: 9200, status: 'done', event: 'SUSPEND_AND_NOTIFY' },
    { key: 'restoring',    label: '现场恢复', ts: 12400, status: 'done', event: 'RESTORATION_ACK' },
    { key: 'completed',    label: '知识沉淀', ts: 15200, status: 'running', event: 'KNOWLEDGE_CONSOLIDATION' },
  ],
  verdicts: [
    { arbitratorId: 'arb-1', model: 'huawei/glm-5.1',       choice: 'new_wins', reasoning: 'LWW：新写入时间戳更晚，采信新值',       latencyMs: 2100 },
    { arbitratorId: 'arb-2', model: 'huawei/deepseek-v4',   choice: 'new_wins', reasoning: '任务上下文以最新配置为准，新值胜出',    latencyMs: 2600 },
    { arbitratorId: 'arb-3', model: 'huawei/kimi-k2.6',     choice: 'new_wins', reasoning: '证据链完整性对齐，判定新写入为准',      latencyMs: 1500 },
  ],
  isUnanimous: true,
  isDeadlocked: false,
  escalatedToRegulator: false,
};

export const DEMO_REGULATION: RegulationDemo = {
  broadcastId: 'bc-rule-update-007',
  type: 'rule_update',
  title: '行为准则更新 v2.3：禁止未授权文件访问',
  issuedAt: NOW,
  ackDeadlineMs: 120_000,
  targets: [
    { agentId: 'agent-director-01', role: 'director', deliveredAt: 60,   ackedAt: 4200 },
    { agentId: 'agent-w-backend',   role: 'worker',   deliveredAt: 120,  ackedAt: 8600 },
    { agentId: 'agent-w-frontend',  role: 'worker',   deliveredAt: 180,  ackedAt: 12_400 },
    { agentId: 'agent-w-db',        role: 'worker',   deliveredAt: 240,  ackedAt: null },
    { agentId: 'agent-reviewer-01', role: 'reviewer', deliveredAt: 320,  ackedAt: 6800 },
    { agentId: 'agent-arb-01',      role: 'arbitrator', deliveredAt: 400, ackedAt: null },
  ],
};

export const DEMO_AUDIT: AuditDemo = {
  agentId: 'agent-w-backend',
  rollingBudgetTokens: 500,
  samples: Array.from({ length: 60 }, (_, i) => ({
    ts: i * 1000,
    tokens: i < 20
      ? 60 + Math.round(40 * Math.sin(i / 3))
      : i < 28
        ? 240 + (i - 20) * 90
        : i < 40
          ? 40
          : 70 + Math.round(20 * Math.sin(i / 4)),
  })),
  anomalies: [
    { ts: 25_000, level: 'warn',     rule: 'rolling',   message: '滚动窗口消耗接近预算上限（420/500）' },
    { ts: 27_000, level: 'critical', rule: 'rolling',   message: '滚动窗口消耗超阈值（660/500，132%）' },
  ],
  freezeWindows: [
    { start: 27_500, end: 39_500, reason: 'resource_abuse · 自动冻结 12s' },
  ],
  verdict: {
    finding: 'confirmed_anomaly',
    action: 'throttle',
    investigatedAt: 41_200,
  },
};
