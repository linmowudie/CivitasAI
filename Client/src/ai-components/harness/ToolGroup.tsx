/**
 * Harness.ToolGroup——工具调用展示组件。
 * 从 MessageBubble 抽离。
 *
 * 职责：展示单条/多条工具调用的参数、结果、错误。
 * 支持四种子样式：read / write / exec / system。
 *
 * 展示规格（工具展示动画改造）：每行 = `+工具 + 描述`
 * ```
 * [状态] [动画/图标] 工具名   人读描述             [子分组] [耗时] [参数]
 *         ↑            ↑
 *    ToolGlyph      describeToolCall()
 * ```
 * - **使用工具中**（generating / pending）播放语义动画：
 *   读→小眼睛扫视、写→细宽细光流、删除→方块阵列沉浮、执行→终端扫描、系统→轨道环；
 *   出结果后回落为同义静态图标（见 `ToolGlyph`）。
 * - **探索态**：组内只要还有未完成的探索型（读/查/列/搜）调用，组头**持续**显示小眼睛
 *   与"探索中…"，直到该组不再有未完成的探索型调用（见 `summarizeToolGroup`）。
 * - 组头另有语义计数（`读取 2 · 写入 1`）与运行状态词，折叠行为与轮次徽章保持原样。
 *
 * 可按事件类型注册到组件注册表：
 * registry.register<ToolCallPayload>({
 *   family: 'harness',
 *   component: ToolGroup,
 *   eventTypes: ['agent:tool_call', 'agent:tool_result'],
 *   metadata: { name: 'ToolGroup', ... }
 * });
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2,
  ShieldCheck, ShieldAlert, Check, X,
} from 'lucide-react';
import type { ComponentSubgroup } from '../types';
import type { ToolCallEntry } from '@/stores/chatStore';
import { useApprovalStore } from '@/stores/approvalStore';
import { ToolGlyph } from './ToolGlyph';
import {
  classifyToolVisual,
  describeToolCall,
  formatCounts,
  inferSubgroup,
  summarizeToolGroup,
} from './toolVisuals';
import styles from './ToolGroup.module.css';

// 纯函数层对外导出（`Tests/AIComponents/subscribeAndToolGroup.spec.ts` 直接引用 inferSubgroup）
export {
  classifyToolVisual,
  describeToolCall,
  formatCounts,
  inferSubgroup,
  isExploratoryTool,
  subgroupOfVisual,
  summarizeToolGroup,
} from './toolVisuals';
export type { ToolDescription, ToolGroupSummary, ToolVisualKind } from './toolVisuals';

// ── Props ───────────────────────────────────────────────────────────

interface ToolGroupProps {
  /** 工具调用列表 */
  toolCalls: ToolCallEntry[];
  /** 总迭代轮次（用于显示多轮标识） */
  totalIterations?: number;
  /** 本组所属的迭代轮次（按序渲染时用于标注"第 N 轮"） */
  iteration?: number;
}

// ── 组件实现 ────────────────────────────────────────────────────────

export function ToolGroup({ toolCalls, totalIterations, iteration }: ToolGroupProps) {
  const [open, setOpen] = useState(true);

  // 组头汇总：状态词 / 语义计数 / 动画形态（探索中恒为小眼睛）
  const summary = useMemo(() => summarizeToolGroup(toolCalls), [toolCalls]);

  if (!toolCalls.length) return null;

  const busy = summary.running > 0;

  return (
    <div
      className={styles.wrapper}
      data-testid="tool-group"
      data-state={summary.state}
      data-exploring={summary.exploring ? 'true' : undefined}
    >
      <button
        className={styles.header}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <div className={styles.headerLeft}>
          {/* 组头动画：探索中持续小眼睛，其余取运行中/最后一个工具的语义 */}
          <ToolGlyph
            toolName={toolCalls[0]?.name ?? ''}
            visual={summary.visual}
            status={busy ? 'pending' : 'success'}
          />
          <span>工具调用</span>
          {iteration != null && <span className={styles.badge}>第 {iteration} 轮</span>}
          {iteration == null && totalIterations != null && totalIterations > 1 && (
            <span className={styles.badge}>{totalIterations} 轮</span>
          )}
          <span className="text-[9px] text-text-muted">{toolCalls.length} 次</span>
          {(busy || summary.failed > 0) && (
            <span className={styles.statusChip} data-state={summary.state}>
              {summary.label}
            </span>
          )}
          {toolCalls.length > 1 && (
            <span className={styles.counts} title="按语义统计本组工具调用">
              {formatCounts(summary.counts)}
            </span>
          )}
        </div>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className={styles.body}>
          {toolCalls.map((tc, i) => (
            <ToolCallItem key={`${tc.id}-${i}`} tc={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 单条工具调用子组件 ──────────────────────────────────────────────

function ToolCallItem({ tc }: { tc: ToolCallEntry }) {
  const [expanded, setExpanded] = useState(false);
  /** 刚出结果：播放一次"落定"扫光（仅表示状态跃迁，不代表成功/失败） */
  const [justSettled, setJustSettled] = useState(false);
  const prevStatus = useRef<ToolCallEntry['status']>(tc.status);

  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = tc.status;
    const wasRunning = prev === 'generating' || prev === 'pending';
    if (wasRunning && (tc.status === 'success' || tc.status === 'error')) {
      setJustSettled(true);
      const timer = setTimeout(() => setJustSettled(false), 700);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [tc.status]);

  const argsStr = Object.keys(tc.arguments).length > 0
    ? JSON.stringify(tc.arguments, null, 2)
    : '';

  const subgroup = inferSubgroup(tc.name);
  const visual = classifyToolVisual(tc.name);
  const desc = useMemo(
    () => describeToolCall(tc.name, tc.arguments),
    [tc.name, tc.arguments],
  );

  return (
    <div
      className={styles.item}
      data-status={tc.status}
      data-visual={visual}
      data-just-settled={justSettled ? 'true' : undefined}
    >
      <button
        className={styles.itemToggle}
        onClick={() => setExpanded(o => !o)}
        aria-expanded={expanded}
      >
        {tc.status === 'success' ? (
          <CheckCircle2 size={12} className="text-success flex-shrink-0" />
        ) : tc.status === 'error' ? (
          <XCircle size={12} className="text-danger flex-shrink-0" />
        ) : (
          <Loader2 size={12} className="text-warning flex-shrink-0 animate-spin" />
        )}
        {/* 工具位：使用中播放语义动画，出结果后为静态同义图标 */}
        <ToolGlyph toolName={tc.name} status={tc.status} />
        <span className={styles.toolName}>{tc.name || '（生成工具调用…）'}</span>
        {/* 描述位：动作 + 作用对象（+ 量词），如「读取文件 · Client/src/index.css」 */}
        <span className={styles.description} title={desc.text}>{desc.text}</span>
        {/* 模型正在生成参数阶段（尚未执行）：明确文案，避免长参数生成期间界面"看起来卡住" */}
        {tc.status === 'generating' && (
          <span className="text-[10px] text-warning/80 flex-shrink-0">
            {/write|edit|create|write_file|file\.write|file\.edit/i.test(tc.name) ? '准备写入…' : '生成中…'}
          </span>
        )}
        <span className={`${styles.badge} ${getSubgroupBadgeClass(subgroup)}`}>
          {subgroup}
        </span>
        {/* 工具耗时：仅在成功/失败且有值时显示，避免"生成中"显示耗时 */}
        {tc.status !== 'generating' && tc.status !== 'pending' && typeof tc.durationMs === 'number' && (
          <span className="text-[10px] text-text-muted flex-shrink-0">{tc.durationMs} ms</span>
        )}
        {argsStr && (
          <span className={styles.argsHint}>
            {expanded ? '收起' : '参数'}
          </span>
        )}
      </button>

      {expanded && argsStr && (
        <div className={styles.itemDetail}>
          <div className={styles.detailLabel}>参数：</div>
          <pre className={styles.codeBlock}>
            {argsStr}
          </pre>
        </div>
      )}

      {expanded && tc.content && (
        <div className={styles.itemDetail}>
          <div className={styles.detailLabel}>结果：</div>
          <pre className={styles.codeBlock}>
            {tc.content}
          </pre>
        </div>
      )}

      {expanded && tc.error && (
        <div className={styles.itemDetail}>
          <div className={styles.errorText}>
            {tc.error.code}: {tc.error.message}
          </div>
        </div>
      )}

      {/* 需要审批的工具：在工具行内嵌审批卡（与审批栏共享同一份决策） */}
      {tc.approvalId && (
        <div className={styles.itemDetail}>
          <InlineApproval approvalId={tc.approvalId} approvalStatus={tc.approvalStatus} />
        </div>
      )}
    </div>
  );
}

// ── 内嵌审批（L0 审查 / 人工确认 / 自动通过） ────────────────────────

interface InlineApprovalProps {
  approvalId: string;
  approvalStatus?: ToolCallEntry['approvalStatus'];
}

/**
 * 工具行内的审批卡。
 *
 * 与左侧「审批」栏读**同一个** approvalStore：任一处点击批准/拒绝都会同步生效；
 * 阻塞期间后端不会执行工具，确认后才放开执行。
 */
function InlineApproval({ approvalId, approvalStatus }: InlineApprovalProps) {
  const approval = useApprovalStore((s) => s.approvals.find((a) => a.approvalId === approvalId));
  const decide = useApprovalStore((s) => s.decide);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 状态来源（两条路互补，任一到达即可正确显示）：
   * ① 工具行上的 approvalStatus（由 APPROVAL_DECIDED 事件按 toolCallId 更新）
   * ② 审批记录本身（审批栏/内嵌卡决策后 store 内同一条记录会落定）
   */
  const fromRecord: ToolCallEntry['approvalStatus'] | undefined = approval
    ? approval.status === 'APPROVED'
      ? (approval.autoApproved ? 'auto-approved' : 'approved')
      : approval.status === 'PENDING'
        ? 'pending'
        : approval.status === 'TIMEOUT'
          ? 'timeout'
          : 'rejected'
    : undefined;
  // 已决状态优先（避免事件缺失时仍显示"审查中"）
  const status = (approvalStatus && approvalStatus !== 'pending' ? approvalStatus : undefined)
    ?? (fromRecord && fromRecord !== 'pending' ? fromRecord : undefined)
    ?? approvalStatus
    ?? fromRecord;

  const handle = async (approve: boolean) => {
    setSubmitting(true);
    setError(null);
    const ok = await decide(approvalId, approve, 'human-operator');
    if (!ok) setError('提交失败，请重试（可能触发接口限流，稍后再试）');
    setSubmitting(false);
  };

  if (status === 'approved' || status === 'auto-approved') {
    return (
      <div className={styles.approvalRow}>
        <ShieldCheck size={12} className="text-success" />
        <span className="text-success">
          {status === 'auto-approved' ? '已自动通过（策略白名单）' : '审批已通过，工具已放行执行'}
        </span>
      </div>
    );
  }

  if (status === 'rejected' || status === 'timeout') {
    return (
      <div className={styles.approvalRow}>
        <ShieldAlert size={12} className="text-danger" />
        <span className="text-danger">
          {status === 'timeout' ? '审批超时，已默认拒绝（工具未执行）' : '审批被拒绝（工具未执行）'}
        </span>
      </div>
    );
  }

  return (
    <div className={styles.approvalCard}>
      <div className={styles.approvalHead}>
        <Loader2 size={12} className="text-warning animate-spin" />
        <span className="text-warning">L0 级权限审查中…</span>
        <span className="text-text-muted">
          {approval ? `剩余 ${Math.max(0, Math.ceil((approval.requestedAt + approval.timeoutSec * 1000 - Date.now()) / 1000))}s · 超时默认拒绝` : '等待确认'}
        </span>
      </div>
      <div className={styles.approvalActions}>
        <span className="text-text-muted">确认后放行执行：</span>
        <button
          className="btn btn-success text-xs"
          disabled={submitting}
          onClick={() => { void handle(true); }}
        >
          <Check size={12} />{submitting ? '提交中…' : '确认执行'}
        </button>
        <button
          className="btn btn-danger text-xs"
          disabled={submitting}
          onClick={() => { void handle(false); }}
        >
          <X size={12} />拒绝
        </button>
      </div>
      {error && <div className={styles.errorText}>{error}</div>}
    </div>
  );
}

// ── 工具函数 ────────────────────────────────────────────────────────

function getSubgroupBadgeClass(subgroup: ComponentSubgroup): string {
  switch (subgroup) {
    case 'read': return styles.badgeRead;
    case 'write': return styles.badgeWrite;
    case 'exec': return styles.badgeExec;
    case 'system': return styles.badgeSystem;
  }
}
