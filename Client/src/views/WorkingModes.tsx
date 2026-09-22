/**
 * 六种工作方式 · 前端可视化视图
 *
 * PRD §3.1 定义了 6 种核心工作方式（DIRECT / DELEGATION / ASSEMBLY_LINE / CONSORTIUM /
 * LITIGATION / REGULATION / AUDIT，其中治理类拆为 REGULATION + AUDIT 独立视图）。
 *
 * 本视图为每种工作方式给出**专属的时间/进度呈现样式**，均基于业界最佳实践调研：
 *
 *   | 工作方式      | 呈现样式                          | 设计参考                                      |
 *   |---------------|-----------------------------------|-----------------------------------------------|
 *   | DIRECT        | 环形计时 + 流式气泡 + TTFB 标记   | Claude / ChatGPT / Android Progress Segments  |
 *   | DELEGATION    | 扇形分叉 + 并行轨道甘特           | Airflow / ZenML Timeline / Jenkins Pipeline   |
 *   | ASSEMBLY_LINE | 圆点 Stepper + 传送带串行时序     | GitHub Actions / Blue Ocean / CI/CD StepBar   |
 *   | CONSORTIUM    | 泳道 + Token 液面柱 + 屏障线      | ZenML Swimlane / Fluid Token / Kimi 集群      |
 *   | LITIGATION    | 六步 Stepper + 3×裁决矩阵 + 时间轴 | Azure Boards / Sentinel / 仲裁案件时间轴      |
 *   | REGULATION    | 广播扩散环 + ACK 三段漏斗         | Android 16 / 推送漏斗 / 应急指挥辐射图         |
 *   | AUDIT         | 消耗曲线 + 阈值带 + 冻结斜纹      | OpenSearch Anomaly / Grafana Annotation / SOC |
 */
import { useState } from 'react';
import DirectExecutionViz from '@/components/WorkingModes/DirectExecutionViz';
import DelegationViz from '@/components/WorkingModes/DelegationViz';
import AssemblyLineViz from '@/components/WorkingModes/AssemblyLineViz';
import ConsortiumViz from '@/components/WorkingModes/ConsortiumViz';
import LitigationViz from '@/components/WorkingModes/LitigationViz';
import RegulationViz from '@/components/WorkingModes/RegulationViz';
import AuditViz from '@/components/WorkingModes/AuditViz';

type TabKey = 'DIRECT' | 'DELEGATION' | 'ASSEMBLY_LINE' | 'CONSORTIUM' | 'LITIGATION' | 'REGULATION' | 'AUDIT';

const TABS: {
  key: TabKey; label: string; subtitle: string; color: string;
  summary: string; triggers: string;
}[] = [
  {
    key: 'DIRECT', label: '直接执行', subtitle: 'DIRECT', color: '#22d3ee',
    summary: '简单任务：单域 + 低 Token → Director 直接调 LLM 回复，不招募 Worker，不做任务拆解。',
    triggers: 'estimatedTokens ≤ 10K · 单域 · 无 SOP 匹配',
  },
  {
    key: 'DELEGATION', label: '并行委派', subtitle: 'DELEGATION', color: '#8b5cf6',
    summary: '中等任务：Director 拆解为 N 个子任务，招募 N 个 Worker 并行执行，最后聚合。',
    triggers: 'couplingScore < 0.5 · subtaskCount ≥ 2 · 单域或多域',
  },
  {
    key: 'ASSEMBLY_LINE', label: 'SOP 流水线', subtitle: 'ASSEMBLY_LINE', color: '#06b6d4',
    summary: '标准作业流程匹配：按 SOP 定义拆节点，强制串行（maxParallelism = 1），依赖链依次传递。',
    triggers: 'hasSopMatch = true · 匹配 code-review / data-migration / api-design / frontend-component',
  },
  {
    key: 'CONSORTIUM', label: '高难攻坚', subtitle: 'CONSORTIUM', color: '#f59e0b',
    summary: '多域高复杂度：每域一个 Partner，各自有独立钱包，并行攻坚，最后收敛屏障聚合。',
    triggers: 'estimatedTokens > 50K 或 requiredDomains ≥ 2',
  },
  {
    key: 'LITIGATION', label: '司法仲裁', subtitle: 'LITIGATION', color: '#ef4444',
    summary: 'Agent 冲突进入六步闭环：立案 → 胶囊组装 → 裁决推理 → 律师函挂起 → 现场恢复 → 知识沉淀。',
    triggers: 'writeGuard 检出冲突 · 双方 assertion ≥ inferred · 无法自动 LWW',
  },
  {
    key: 'REGULATION', label: '行政协调', subtitle: 'REGULATION', color: '#3b82f6',
    summary: '仲裁死锁升级至监管局强制裁决 + 广播规则 + ACK 回执 + 紧急干预 + 行为准则。',
    triggers: 'arbitration.deadlocked · emergency.triggered · rule.updated',
  },
  {
    key: 'AUDIT', label: '资源稽查', subtitle: 'AUDIT', color: '#10b981',
    summary: '异常检测（滚动/偏离/死循环）→ 自动冻结 → 稽查判定（误报/异常/攻击）→ 执行处罚。',
    triggers: 'rolling 超预算 · deviation 偏离均值 · loop 连续指纹重复',
  },
];

export default function WorkingModes() {
  const [tab, setTab] = useState<TabKey>('DIRECT');
  const active = TABS.find(t => t.key === tab)!;

  return (
    <div className="p-6 space-y-4">
      {/* ── 页头 ─────────────────────────────── */}
      <div>
        <h1 className="text-xl font-bold text-text-primary">工作方式可视化</h1>
        <p className="text-xs text-text-muted mt-0.5">
          PRD §3.1 · 6 种路由模式 · 每种方式独立的时序 / 进度呈现样式（基于业界调研）
        </p>
      </div>

      {/* ── Tab 栏 ───────────────────────────── */}
      <div className="flex gap-1 p-1 rounded-lg bg-surface-800 border border-surface-700 overflow-x-auto">
        {TABS.map(t => {
          const isActive = t.key === tab;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className="flex items-center gap-2 px-3 py-2 rounded-md whitespace-nowrap transition-all text-[13px]"
              style={{
                background: isActive ? `${t.color}20` : 'transparent',
                color: isActive ? t.color : 'var(--color-text-secondary)',
                border: `1px solid ${isActive ? t.color + '55' : 'transparent'}`,
              }}>
              <span className="w-2 h-2 rounded-full" style={{ background: t.color }} />
              <span className="font-semibold">{t.label}</span>
              <span className="font-mono text-[10px] opacity-70 hidden xl:inline">{t.subtitle}</span>
            </button>
          );
        })}
      </div>

      {/* ── 当前方式摘要条 ───────────────────── */}
      <div className="card flex items-start gap-4 flex-wrap" style={{ borderLeft: `3px solid ${active.color}` }}>
        <div className="flex-1 min-w-[280px]">
          <div className="flex items-center gap-2 mb-1">
            <span className="badge font-mono" style={{ background: `${active.color}25`, color: active.color }}>
              {active.subtitle}
            </span>
            <span className="text-sm font-semibold text-text-primary">{active.label}</span>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">{active.summary}</p>
        </div>
        <div className="text-[10px] font-mono text-text-muted">
          <div className="text-text-secondary mb-1">触发条件</div>
          <div>{active.triggers}</div>
        </div>
      </div>

      {/* ── 对应可视化 ───────────────────────── */}
      {tab === 'DIRECT' && <DirectExecutionViz />}
      {tab === 'DELEGATION' && <DelegationViz />}
      {tab === 'ASSEMBLY_LINE' && <AssemblyLineViz />}
      {tab === 'CONSORTIUM' && <ConsortiumViz />}
      {tab === 'LITIGATION' && <LitigationViz />}
      {tab === 'REGULATION' && <RegulationViz />}
      {tab === 'AUDIT' && <AuditViz />}
    </div>
  );
}
