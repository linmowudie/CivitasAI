import { Text, useHostTheme } from 'qoder/canvas';
import { useState, useRef, useCallback, useEffect } from 'react';

const PANEL_MIN = 120;
const PANEL_DEFAULT = 220;
const HANDLE_WIDTH = 6;
const LEFT_PANEL_RATIO = 0.25;
const RIGHT_PANEL_RATIO = 0.5;

/* ── Page definitions ── */
const pages = [
  { id: 'overview', title: '概览', desc: '系统整体状态一览' },
  { id: 'agents', title: 'Agent 列表', desc: '查看与管理系统中的 Agent' },
  { id: 'tasks', title: '任务队列', desc: '当前排队与执行中的任务' },
  { id: 'logs', title: '运行日志', desc: '系统运行日志与事件流' },
  { id: 'settings', title: '配置', desc: '系统参数与偏好设置' },
];

/* ── Project & task data ── */
const projects = [
  {
    name: 'Civitas-AI',
    tasks: [
      { id: 't1', title: '实现 Agent 编排引擎', status: '进行中', tag: '开发' },
      { id: 't2', title: 'Token 经济系统联调', status: '待处理', tag: '测试' },
      { id: 't3', title: '前端对话界面重构', status: '进行中', tag: '开发' },
    ],
  },
  {
    name: 'MongoTerminalAgent',
    tasks: [
      { id: 't4', title: 'MongoDB 连接池优化', status: '已完成', tag: '运维' },
      { id: 't5', title: '查询性能基准测试', status: '待处理', tag: '测试' },
    ],
  },
  {
    name: 'HarmonyOS Assistant',
    tasks: [
      { id: 't6', title: '设备控制技能适配', status: '进行中', tag: '开发' },
      { id: 't7', title: 'HDC 连接稳定性修复', status: '待处理', tag: '修复' },
    ],
  },
];

const statusColor: Record<string, string> = {
  '进行中': '#f59e0b',
  '待处理': '#8a8a8a',
  '已完成': '#22c55e',
};

/* ── Conversation container types ── */
type ContainerKind = 'text' | 'loop' | 'harness' | 'tool' | 'data';
const COLLAPSE_THRESHOLD = 50;
const COLLAPSE_BATCH = 50;

interface ReplyContainer {
  id: string;
  kind: ContainerKind;
  title: string;
  content: string;
  meta?: string;
}

interface ConversationTurn {
  id: string;
  userMessage: string;
  agentReply: ReplyContainer[];
}

const kindLabel: Record<ContainerKind, string> = {
  text: 'Text',
  loop: 'Loop',
  harness: 'Harness',
  tool: 'Tool',
  data: 'Data',
};

const kindIcon: Record<ContainerKind, string> = {
  text: 'T',
  loop: '⟳',
  harness: '⚙',
  tool: '⚡',
  data: '◫',
};

/* ── Sample conversation turns ── */
const sampleTurns: ConversationTurn[] = [
  {
    id: 'turn1',
    userMessage: '你好，请介绍一下你自己',
    agentReply: [
      { id: 'r1', kind: 'text', title: '问候', content: '你好，我是系统助手，有什么可以帮你的？' },
    ],
  },
  {
    id: 'turn2',
    userMessage: '请展示当前系统状态概览',
    agentReply: [
      { id: 'r2', kind: 'loop', title: 'Loop #1 — 状态采集', content: '执行 3 个 Agent 状态轮询，耗时 1.2s', meta: 'iteration: 3 / completed' },
      { id: 'r3', kind: 'tool', title: 'Tool Call — getAgentStatus', content: '返回 5 个 Agent 的实时负载数据', meta: '230ms' },
      { id: 'r4', kind: 'data', title: '数据集 — Agent 负载', content: 'A1: 42% | A2: 78% | A3: idle | B1: 15% | B2: 63%', meta: '5 records' },
      { id: 'r5', kind: 'harness', title: 'Harness — 质量门禁', content: 'G0 通过，G1 通过，进入执行阶段', meta: 'gate: pass' },
      { id: 'r6', kind: 'text', title: '回复', content: '当前系统运行正常，共有 5 个活跃 Agent，任务队列中 3 项待处理。' },
    ],
  },
  {
    id: 'turn3',
    userMessage: '请详细分析每个 Agent 的运行参数并生成报告',
    agentReply: (() => {
      /* 55 sub-containers to demo auto-collapse within a single agent reply */
      const items: ReplyContainer[] = [
        { id: 'a1', kind: 'loop', title: 'Loop — 数据采集', content: '开始采集所有 Agent 运行参数...', meta: 'start' },
        { id: 'a2', kind: 'tool', title: 'Tool Call — collectMetrics', content: '获取 CPU / 内存 / 网络指标', meta: '180ms' },
      ];
      const kinds: ContainerKind[] = ['text', 'loop', 'tool', 'data', 'harness'];
      for (let i = 3; i <= 55; i++) {
        const k = kinds[i % 5];
        items.push({
          id: `a${i}`,
          kind: k,
          title: `${kindLabel[k]} #${i}`,
          content: `子容器 ${i} 的执行内容与运行数据摘要...`,
          meta: `step: ${i}`,
        });
      }
      return items;
    })(),
  },
];

/* ── Right panel preview options ── */
type PreviewKind = 'agent' | 'subagent' | 'terminal' | 'summary' | 'fileview' | 'filepreview';

interface PreviewOption {
  id: PreviewKind;
  label: string;
  icon: string;
}

const previewOptions: PreviewOption[] = [
  { id: 'agent', label: 'L1 Agent', icon: '◉' },
  { id: 'subagent', label: 'SubAgent', icon: '◎' },
  { id: 'terminal', label: '终端', icon: '▸' },
  { id: 'summary', label: '概要', icon: '☰' },
  { id: 'fileview', label: '文件查看', icon: '📂' },
  { id: 'filepreview', label: '文件预览', icon: '👁' },
];

const sampleFiles = [
  { name: 'main.ts', renderable: true },
  { name: 'App.tsx', renderable: true },
  { name: 'config.json', renderable: true },
  { name: 'logo.png', renderable: false },
  { name: 'data.db', renderable: false },
];

const sampleAgents = ['Agent-Orchestrator', 'Agent-Coder', 'Agent-Reviewer'];
const sampleSubAgents = ['SubA-Parser', 'SubA-Validator'];

/* ── Left panel bottom feature list (upward-expandable) ── */
interface FeatureItem {
  id: string;
  label: string;
  children: { id: string; label: string }[];
}

const featureItems: FeatureItem[] = [
  { id: 'loop-tasks', label: 'Loop 任务', children: [] },
  { id: 'harness', label: 'Harness 工程检查', children: [] },
  { id: 'memory', label: '记忆', children: [] },
  { id: 'data-hub', label: '数据中台', children: [] },
  {
    id: 'plugins',
    label: '插件',
    children: [
      { id: 'skills', label: 'Skill' },
      { id: 'mcp', label: 'MCP' },
      { id: 'custom-tools', label: '自定义工具' },
    ],
  },
  {
    id: 'account',
    label: '账号',
    children: [
      { id: 'profile', label: '个人信息' },
      { id: 'settings', label: '设置' },
    ],
  },
];

/* ── Main view: unified state for main container content ── */
type MainView =
  | { type: 'conversation' }
  | { type: 'task'; id: string }
  | { type: 'feature'; id: string }
  | { type: 'agent'; id: string };

/* ── Preview tab cache wrapper ──
   Keeps visited tabs mounted in DOM; hides inactive via display:none.
   Preserves scroll position, input state, and React state across tab switches.
   For production: heavy data should be serialized to snapshot storage (IndexedDB)
   when tab count or data size exceeds threshold to prevent UI lag. */
const PreviewCache = ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (
  <div style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', gap: 4, flex: 1 }}>
    {children}
  </div>
);

export default function ResizablePanelLayout() {
  const theme = useHostTheme();
  const containerRef = useRef<HTMLDivElement>(null);

  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(false);
  const [leftWidth, setLeftWidth] = useState(PANEL_DEFAULT);
  const [rightWidth, setRightWidth] = useState(PANEL_DEFAULT);
  const [activePage, setActivePage] = useState('overview');
  const [mainView, setMainView] = useState<MainView>({ type: 'conversation' });
  const [inputExpanded, setInputExpanded] = useState(false);
  const [activePreview, setActivePreview] = useState<PreviewKind>('agent');
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [visitedTabs, setVisitedTabs] = useState<Set<PreviewKind>>(new Set(['agent']));
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set());
  const [expandedFeatures, setExpandedFeatures] = useState<Set<string>>(new Set());
  const [containerWidth, setContainerWidth] = useState(900);

  const dragRef = useRef<{
    side: 'left' | 'right';
    startX: number;
    startWidth: number;
  } | null>(null);

  /* ── Track container width → dynamic panel max ── */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w > 0) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const leftPanelMax = Math.max(PANEL_MIN + 20, Math.floor(containerWidth * LEFT_PANEL_RATIO));
  const rightPanelMax = Math.max(PANEL_MIN + 20, Math.floor(containerWidth * RIGHT_PANEL_RATIO));

  /* ── Drag resize ── */
  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = e.clientX - d.startX;
      if (d.side === 'left') {
        setLeftWidth(Math.min(leftPanelMax, Math.max(PANEL_MIN, d.startWidth + delta)));
      } else {
        setRightWidth(Math.min(rightPanelMax, Math.max(PANEL_MIN, d.startWidth - delta)));
      }
    },
    [leftPanelMax, rightPanelMax],
  );

  const onMouseUp = useCallback(() => {
    dragRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const startDrag = (side: 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = {
      side,
      startX: e.clientX,
      startWidth: side === 'left' ? leftWidth : rightWidth,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  /* ── Dark theme palette ── */
  const accent = theme.tokens?.colorAccent ?? '#8b5cf6';
  const border = '#2a2a2a';
  const bgBase = '#0e0e0e';
  const bgSecondary = '#161616';
  const bgSurface = '#1c1c1c';
  const bgInput = '#1a1a1a';
  const textPrimary = '#e8e8e8';
  const textSecondary = '#8a8a8a';
  const textTertiary = '#555';
  const radius = theme.tokens?.radiusMd ?? '8px';

  /* ── Toggle button (corner tab) ── */
  const tabStyle: React.CSSProperties = {
    position: 'absolute',
    top: 8,
    width: 26,
    height: 26,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontSize: 12,
    zIndex: 10,
    background: bgSurface,
    color: textSecondary,
    transition: 'background 0.15s',
  };

  const resizeHandle = (side: 'left' | 'right'): React.CSSProperties => ({
    width: HANDLE_WIDTH,
    flexShrink: 0,
    cursor: 'col-resize',
    background: 'transparent',
    transition: 'background 0.15s',
  });

  /* ── Render a single reply sub-container ── */
  const renderReplyItem = (c: ReplyContainer) => {
    const bg = bgSurface;

    if (c.kind === 'text') {
      return (
        <div key={c.id} style={{ padding: '10px 14px', borderRadius: radius, background: bg, border: `1px solid ${border}` }}>
          <Text size="small" style={{ color: textSecondary, overflowWrap: 'break-word' }}>{c.content}</Text>
        </div>
      );
    }

    /* Non-text containers: Loop / Harness / Tool / Data */
    return (
      <div key={c.id} style={{ borderRadius: radius, border: `1px solid ${border}`, background: bg, overflow: 'hidden' }}>
        {/* Header bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: `1px solid ${border}`, background: `${accent}0a` }}>
          <span style={{ fontSize: 11, color: accent, fontWeight: 600 }}>{kindIcon[c.kind]}</span>
          <Text size="sm" weight="medium" style={{ color: textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</Text>
          {c.meta && <Text size="sm" style={{ color: textTertiary, flexShrink: 0, fontSize: 10 }}>{c.meta}</Text>}
        </div>
        {/* Body */}
        <div style={{ padding: '8px 12px' }}>
          <Text size="small" style={{ color: textSecondary, overflowWrap: 'break-word' }}>{c.content}</Text>
        </div>
      </div>
    );
  };

  /* ── Render main content based on mainView ── */
  const renderMainContent = () => {
    /* conversation (default) */
    if (mainView.type === 'conversation') {
      return sampleTurns.map((turn) => {
        const replyCount = turn.agentReply.length;
        const needsCollapse = replyCount > COLLAPSE_THRESHOLD;
        const isExpanded = expandedReplies.has(turn.id);
        const batches: ReplyContainer[][] = needsCollapse
          ? (() => { const b: ReplyContainer[][] = []; for (let i = 0; i < replyCount; i += COLLAPSE_BATCH) b.push(turn.agentReply.slice(i, i + COLLAPSE_BATCH)); return b; })()
          : [turn.agentReply];
        return (
          <div key={turn.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ padding: '10px 14px', borderRadius: radius, background: `${accent}22`, border: `1px solid ${border}` }}>
              <Text size="small" style={{ color: textPrimary, overflowWrap: 'break-word' }}>{turn.userMessage}</Text>
            </div>
            <div style={{ borderRadius: radius, border: `1px solid ${border}`, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: isExpanded || !needsCollapse ? `1px solid ${border}` : 'none', background: `${accent}0a` }}>
                <span style={{ fontSize: 11, color: accent, fontWeight: 600 }}>Agent</span>
                <Text size="sm" style={{ color: textSecondary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyCount} 个子容器</Text>
                {needsCollapse && (
                  <div onClick={() => { const n = new Set(expandedReplies); isExpanded ? n.delete(turn.id) : n.add(turn.id); setExpandedReplies(n); }} style={{ cursor: 'pointer', fontSize: 11, color: accent, flexShrink: 0 }}>
                    {isExpanded ? '▾ 收起' : '▸ 展开'}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: needsCollapse && !isExpanded ? 0 : 8 }}>
                {batches.map((batch, bi) => {
                  const isLast = bi === batches.length - 1;
                  if (!needsCollapse) return batch.map((c) => renderReplyItem(c));
                  if (!isExpanded && !isLast) return (
                    <div key={`b${bi}`} onClick={() => { const n = new Set(expandedReplies); n.add(turn.id); setExpandedReplies(n); }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: radius, border: `1px dashed ${border}`, cursor: 'pointer', background: bgSurface }}>
                      <Text size="sm" style={{ color: textTertiary }}>▸</Text>
                      <Text size="sm" style={{ color: textSecondary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{batch.length} 个容器（{batch[0].id}–{batch[batch.length - 1].id}）</Text>
                    </div>
                  );
                  return batch.map((c) => renderReplyItem(c));
                })}
              </div>
            </div>
          </div>
        );
      });
    }
    /* task detail */
    if (mainView.type === 'task') {
      let task: typeof projects[0]['tasks'][0] | undefined; let projName = '';
      for (const p of projects) for (const t of p.tasks) if (t.id === mainView.id) { task = t; projName = p.name; }
      if (!task) return <Text size="small" style={{ color: textTertiary }}>任务未找到</Text>;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ padding: 14, borderRadius: radius, border: `1px solid ${border}`, background: bgSurface }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor[task.status] ?? textTertiary, flexShrink: 0 }} />
              <Text weight="semibold" size="small" style={{ color: textPrimary }}>{task.title}</Text>
            </div>
            <Text size="sm" style={{ color: textSecondary }}>项目: {projName}</Text>
            <div style={{ marginTop: 4 }}><Text size="sm" style={{ color: textSecondary }}>状态: {task.status}</Text></div>
            <div style={{ marginTop: 4 }}><Text size="sm" style={{ color: textSecondary }}>标签: {task.tag}</Text></div>
          </div>
          <div style={{ padding: 14, borderRadius: radius, border: `1px solid ${border}`, background: bgSurface }}>
            <Text weight="semibold" size="small" style={{ color: textSecondary, marginBottom: 8 }}>任务对话</Text>
            <div style={{ padding: '8px 12px', borderRadius: radius, background: `${accent}22`, border: `1px solid ${border}`, marginBottom: 8 }}>
              <Text size="small" style={{ color: textPrimary }}>请开始执行此任务</Text>
            </div>
            <div style={{ borderRadius: radius, border: `1px solid ${border}`, overflow: 'hidden' }}>
              <div style={{ padding: '6px 12px', borderBottom: `1px solid ${border}`, background: `${accent}0a`, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: accent, fontWeight: 600 }}>Agent</span>
                <Text size="sm" style={{ color: textSecondary }}>2 个子容器</Text>
              </div>
              <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ padding: '8px 12px', borderRadius: radius, background: bgSurface, border: `1px solid ${border}` }}>
                  <Text size="small" style={{ color: textSecondary }}>正在分析任务需求并制定执行计划...</Text>
                </div>
                <div style={{ borderRadius: radius, border: `1px solid ${border}`, background: bgSurface, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: `1px solid ${border}`, background: `${accent}0a` }}>
                    <span style={{ fontSize: 11, color: accent, fontWeight: 600 }}>⚡</span>
                    <Text size="sm" weight="medium" style={{ color: textPrimary }}>Tool Call — analyzeTask</Text>
                  </div>
                  <div style={{ padding: '8px 12px' }}><Text size="small" style={{ color: textSecondary }}>任务拆解完成，共 3 个子步骤</Text></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }
    /* feature views */
    if (mainView.type === 'feature') {
      const id = mainView.id;
      const views: Record<string, { title: string; desc: string; items: string[] }> = {
        'loop-tasks': { title: 'Loop 任务管理', desc: '循环执行任务的状态与进度', items: ['Loop #1 — 数据采集 (运行中)', 'Loop #2 — 报告生成 (等待审批)', 'Loop #3 — 数据同步 (已完成)'] },
        'harness': { title: 'Harness 工程检查', desc: '质量门禁与验证状态', items: ['G0 基础检查 — 通过', 'G1 安全门禁 — 通过', 'G2 质量验证 — 待执行', 'G3 性能基准 — 未开始'] },
        'memory': { title: '共享记忆', desc: 'Agent 间共享的上下文与知识', items: ['工作记忆 — 12 条活跃上下文', '长期记忆 — 48 条持久化知识', '记忆压缩 — 最近一次: 15 分钟前'] },
        'data-hub': { title: '数据中台', desc: '数据资源管理与服务', items: ['数据源 — 5 个已连接', '数据管道 — 3 个运行中', '数据质量 — 98.5% 合格率'] },
        'profile': { title: '个人信息', desc: '账号基本资料', items: ['用户名: CivitasUser', '邮箱: user@civitas.ai', '角色: 管理员'] },
        'settings': { title: '系统设置', desc: '偏好与配置管理', items: ['主题: 深色模式', '语言: 中文', '通知: 已开启', '自动保存: 已开启'] },
        'skills': { title: 'Skill 技能', desc: '已安装的 Agent 技能', items: ['canvas — 可视化画布生成', 'pdf — 文档处理', 'xlsx — 表格处理', 'find-skills — 技能发现'] },
        'mcp': { title: 'MCP 服务', desc: 'Model Context Protocol 连接', items: ['browser-use — 已连接', 'chrome-devtools — 已连接', 'genui — 已连接', 'schedule — 已连接'] },
        'custom-tools': { title: '自定义工具', desc: '用户自定义的外部工具', items: ['暂无自定义工具', '可通过插件系统添加'] },
      };
      const v = views[id];
      if (!v) return <Text size="small" style={{ color: textTertiary }}>视图开发中...</Text>;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ padding: 14, borderRadius: radius, border: `1px solid ${border}`, background: bgSurface }}>
            <Text weight="semibold" size="small" style={{ color: textPrimary, marginBottom: 4 }}>{v.title}</Text>
            <Text size="sm" style={{ color: textSecondary }}>{v.desc}</Text>
          </div>
          {v.items.map((item, i) => (
            <div key={i} style={{ padding: '10px 14px', borderRadius: radius, border: `1px solid ${border}`, background: bgSurface }}>
              <Text size="small" style={{ color: textPrimary, overflowWrap: 'break-word' }}>{item}</Text>
            </div>
          ))}
        </div>
      );
    }
    /* agent view */
    if (mainView.type === 'agent') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ padding: 14, borderRadius: radius, border: `1px solid ${border}`, background: bgSurface }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 14, color: accent }}>◉</span>
              <Text weight="semibold" size="small" style={{ color: textPrimary }}>{mainView.id}</Text>
            </div>
            <Text size="sm" style={{ color: textSecondary }}>L1 Agent 对话视图</Text>
          </div>
          <div style={{ padding: '10px 14px', borderRadius: radius, background: `${accent}22`, border: `1px solid ${border}` }}>
            <Text size="small" style={{ color: textPrimary, overflowWrap: 'break-word' }}>你好 {mainView.id}，请报告当前工作状态</Text>
          </div>
          <div style={{ borderRadius: radius, border: `1px solid ${border}`, overflow: 'hidden' }}>
            <div style={{ padding: '6px 12px', borderBottom: `1px solid ${border}`, background: `${accent}0a`, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: accent, fontWeight: 600 }}>Agent</span>
              <Text size="sm" style={{ color: textSecondary }}>2 个子容器</Text>
            </div>
            <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ padding: '8px 12px', borderRadius: radius, background: bgSurface, border: `1px solid ${border}` }}>
                <Text size="small" style={{ color: textSecondary }}>正在采集运行状态数据...</Text>
              </div>
              <div style={{ padding: '8px 12px', borderRadius: radius, background: bgSurface, border: `1px solid ${border}` }}>
                <Text size="small" style={{ color: textPrimary }}>当前运行正常，已处理 12 个任务，待处理 3 个。</Text>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return <Text size="small" style={{ color: textTertiary }}>未知视图</Text>;
  };

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100vh', background: bgBase, color: textPrimary, overflow: 'hidden' }}
    >
      {/* ── Body ── */}
      <div
        ref={containerRef}
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          border: `1px solid ${border}`,
          borderRadius: radius,
          margin: 0,
        }}
      >
        {/* ═══ Left Panel ═══ */}
        {leftOpen && (
          <>
            <div
              style={{
                width: leftWidth,
                flexShrink: 0,
                background: bgSecondary,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                position: 'relative',
                borderRight: `1px solid ${border}`,
              }}
            >
              {/* Toggle: inside left panel, left-top corner */}
              <div
                style={{
                  ...tabStyle,
                  left: 8,
                  borderTopLeftRadius: radius,
                  borderBottomLeftRadius: radius,
                }}
                onClick={() => setLeftOpen(false)}
                title="隐藏左侧面板"
              >
                ◁
              </div>

              {/* ── Container 1: new task button ── */}
              <div style={{ flexShrink: 0, padding: '44px 12px 10px' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    padding: '8px 0',
                    borderRadius: radius,
                    border: `1px solid ${border}`,
                    background: bgSurface,
                    cursor: 'pointer',
                  }}
                >
                  <Text size="small" weight="medium" style={{ color: accent }}>+ 新任务</Text>
                </div>
              </div>

              {/* ── Container 2: task list by project (scrollable) ── */}
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  overflowX: 'hidden',
                  borderTop: `1px solid ${border}`,
                  padding: '10px 0',
                }}
              >
                <div style={{ padding: '0 16px 6px' }}>
                  <Text weight="semibold" size="small" style={{ color: textSecondary }}>
                    任务列表
                  </Text>
                </div>
                {projects.map((proj) => (
                  <div key={proj.name} style={{ marginBottom: 10 }}>
                    {/* Project header */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 16px',
                      }}
                    >
                      <Text size="sm" weight="medium" style={{ color: textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {proj.name}
                      </Text>
                      <Text size="sm" style={{ color: textTertiary, fontSize: 10 }}>
                        {proj.tasks.length}
                      </Text>
                    </div>
                    {/* Task items */}
                    {proj.tasks.map((task) => {
                      const isActive = mainView.type === 'task' && task.id === mainView.id;
                      return (
                        <div
                          key={task.id}
                          onClick={() => setMainView({ type: 'task', id: task.id })}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 16px',
                            cursor: 'pointer',
                            background: isActive ? `${accent}14` : 'transparent',
                            borderLeft: isActive ? `3px solid ${accent}` : '3px solid transparent',
                            transition: 'background 0.15s',
                          }}
                        >
                          <div
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              flexShrink: 0,
                              background: statusColor[task.status] ?? textTertiary,
                            }}
                          />
                          <Text
                            size="sm"
                            weight={isActive ? 'medium' : 'normal'}
                            style={{
                              flex: 1,
                              color: isActive ? textPrimary : textSecondary,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {task.title}
                          </Text>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              {/* ── Bottom: upward-expandable feature list ── */}
              <div
                style={{
                  flexShrink: 0,
                  maxHeight: '50%',
                  overflowY: 'auto',
                  overflowX: 'hidden',
                  borderTop: `1px solid ${border}`,
                }}
              >
                {featureItems.map((feat) => {
                  const isExpanded = expandedFeatures.has(feat.id);
                  return (
                    <div key={feat.id}>
                      {/* Feature row */}
                      <div
                        onClick={() => {
                          const next = new Set(expandedFeatures);
                          if (isExpanded) next.delete(feat.id); else next.add(feat.id);
                          setExpandedFeatures(next);
                          if (feat.children.length === 0) {
                            setMainView({ type: 'feature', id: feat.id });
                          }
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '8px 16px',
                          cursor: feat.children.length > 0 ? 'pointer' : 'default',
                          transition: 'background 0.15s',
                        }}
                      >
                        {feat.children.length > 0 && (
                          <span style={{ fontSize: 9, color: textTertiary, flexShrink: 0 }}>
                            {isExpanded ? '▾' : '▸'}
                          </span>
                        )}
                        <Text
                          size="sm"
                          style={{
                            flex: 1,
                            color: textSecondary,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {feat.label}
                        </Text>
                      </div>
                      {/* Sub-items (expand upward visually) */}
                      {isExpanded &&
                        feat.children.map((child) => {
                          const isActive = mainView.type === 'feature' && mainView.id === child.id;
                          return (
                            <div
                              key={child.id}
                              onClick={() => setMainView({ type: 'feature', id: child.id })}
                              style={{
                                padding: '6px 16px 6px 32px',
                                cursor: 'pointer',
                                background: isActive ? `${accent}14` : 'transparent',
                                borderLeft: isActive ? `3px solid ${accent}` : '3px solid transparent',
                                transition: 'background 0.15s',
                              }}
                            >
                              <Text
                                size="sm"
                                weight={isActive ? 'medium' : 'normal'}
                                style={{
                                  color: isActive ? accent : textPrimary,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {child.label}
                              </Text>
                            </div>
                          );
                        })}
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Left resize handle */}
            <div
              onMouseDown={(e) => startDrag('left', e)}
              style={resizeHandle('left')}
              onMouseEnter={(e) =>
                ((e.target as HTMLElement).style.background = `${accent}33`)
              }
              onMouseLeave={(e) =>
                ((e.target as HTMLElement).style.background = 'transparent')
              }
            />
          </>
        )}

        {/* ═══ Main Content ═══ */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
            position: 'relative',
            display: 'flex',
          }}
        >
          {/* Left toggle: main container left-top (when left panel hidden) */}
          {!leftOpen && (
            <div
              style={{
                ...tabStyle,
                left: 0,
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: radius,
                borderTopRightRadius: radius,
              }}
              onClick={() => setLeftOpen(true)}
              title="显示左侧面板"
            >
              ▷
            </div>
          )}
          {/* Right toggle: main container right-top (when right panel hidden) */}
          {!rightOpen && (
            <div
              style={{
                ...tabStyle,
                right: 0,
                borderTopRightRadius: 0,
                borderBottomRightRadius: radius,
                borderTopLeftRadius: radius,
              }}
              onClick={() => setRightOpen(true)}
              title="显示右侧面板"
            >
              ◁
            </div>
          )}
          {/* ── Main: three-section layout ── */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              overflow: 'hidden',
            }}
          >
            {/* Top: session title bar (~3%) */}
            <div
              style={{
                flexShrink: 0,
                padding: '10px 20px',
                borderBottom: `1px solid ${border}`,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <Text weight="semibold" size="small" style={{ color: textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {(() => {
                  if (mainView.type === 'task') {
                    for (const p of projects) for (const t of p.tasks) if (t.id === mainView.id) return t.title;
                    return '任务详情';
                  }
                  if (mainView.type === 'feature') {
                    const f = featureItems.find((fi) => fi.id === mainView.id);
                    if (f) return f.label;
                    const child = featureItems.flatMap((fi) => fi.children).find((c) => c.id === mainView.id);
                    if (child) return child.label;
                    return '功能视图';
                  }
                  if (mainView.type === 'agent') return mainView.id;
                  return pages.find((p) => p.id === activePage)?.title ?? '会话';
                })()}
              </Text>
              <Text size="sm" style={{ color: textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                {(() => {
                  if (mainView.type === 'task') {
                    for (const p of projects) for (const t of p.tasks) if (t.id === mainView.id) return `${p.name} · ${t.status}`;
                    return '';
                  }
                  if (mainView.type === 'feature') return `${mainView.id} 视图`;
                  if (mainView.type === 'agent') return `L1 Agent 对话`;
                  return pages.find((p) => p.id === activePage)?.desc ?? '';
                })()}
              </Text>
            </div>

            {/* Middle: content area — switches based on mainView */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                overflowX: 'hidden',
                padding: 20,
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
              }}
            >
              {renderMainContent()}
            </div>

            {/* Bottom: dialog box container — only in conversation view */}
            <div
              style={{
                flexShrink: 0,
                borderTop: `1px solid ${border}`,
                display: mainView.type === 'conversation' ? 'flex' : 'none',
                flexDirection: 'column',
              }}
            >
              {/* Top sub-container: text input (expandable) */}
              <div
                style={{
                  padding: '10px 16px 6px',
                }}
              >
                <div
                  style={{
                    width: '100%',
                    minHeight: inputExpanded ? 120 : 36,
                    maxHeight: inputExpanded ? 240 : 36,
                    padding: '8px 12px',
                    borderRadius: radius,
                    border: `1px solid ${border}`,
                    background: bgInput,
                    fontSize: 13,
                    color: textTertiary,
                    overflowY: inputExpanded ? 'auto' : 'hidden',
                    transition: 'min-height 0.2s, max-height 0.2s',
                    whiteSpace: inputExpanded ? 'pre-wrap' : 'nowrap',
                  }}
                >
                  {inputExpanded ? '在此输入大段内容...' : '输入消息...'}
                </div>
              </div>

              {/* Bottom sub-container: action buttons */}
              <div
                style={{
                  padding: '4px 16px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                {/* Left: auxiliary buttons */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {/* Expand / collapse toggle */}
                  <div
                    onClick={() => setInputExpanded((v) => !v)}
                    title={inputExpanded ? '收起输入框' : '展开输入框'}
                    style={{
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: radius,
                      cursor: 'pointer',
                      fontSize: 13,
                      color: textSecondary,
                      background: inputExpanded ? `${accent}14` : 'transparent',
                      border: `1px solid ${border}`,
                      transition: 'background 0.15s',
                    }}
                  >
                    {inputExpanded ? '▾' : '▴'}
                  </div>
                  {/* Placeholder auxiliary buttons */}
                  {['📎', '🖼'].map((icon, i) => (
                    <div
                      key={i}
                      style={{
                        width: 28,
                        height: 28,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: radius,
                        cursor: 'pointer',
                        fontSize: 13,
                        border: `1px solid ${border}`,
                        color: textSecondary,
                      }}
                    >
                      {icon}
                    </div>
                  ))}
                </div>

                {/* Right: send button — purple rounded square */}
                <div
                  style={{
                    width: 32,
                    height: 32,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: radius,
                    background: accent,
                    color: '#fff',
                    fontSize: 14,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  ↑
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ═══ Right resize handle ═══ */}
        {rightOpen && (
          <div
            onMouseDown={(e) => startDrag('right', e)}
            style={resizeHandle('right')}
            onMouseEnter={(e) =>
              ((e.target as HTMLElement).style.background = `${accent}33`)
            }
            onMouseLeave={(e) =>
              ((e.target as HTMLElement).style.background = 'transparent')
            }
          />
        )}

        {/* ═══ Right Panel ═══ */}
        {rightOpen && (
          <div
            style={{
              width: rightWidth,
              flexShrink: 0,
              background: bgSecondary,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              position: 'relative',
              borderLeft: `1px solid ${border}`,
            }}
          >
            {/* Toggle: inside right panel, right-top corner */}
            <div
              style={{
                ...tabStyle,
                right: 8,
                borderTopRightRadius: radius,
                borderBottomRightRadius: radius,
              }}
              onClick={() => setRightOpen(false)}
              title="隐藏右侧面板"
            >
              ▷
            </div>

            {/* ── Preview options (tabs) ── */}
            <div
              style={{
                flexShrink: 0,
                padding: '40px 8px 6px',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 4,
                borderBottom: `1px solid ${border}`,
              }}
            >
              {previewOptions.map((opt) => {
                const isActive = activePreview === opt.id;
                return (
                  <div
                    key={opt.id}
                    onClick={() => { setVisitedTabs((v) => new Set(v).add(opt.id)); setActivePreview(opt.id); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '4px 8px',
                      borderRadius: radius,
                      cursor: 'pointer',
                      fontSize: 11,
                      background: isActive ? `${accent}22` : 'transparent',
                      border: `1px solid ${isActive ? accent : border}`,
                      color: isActive ? accent : textSecondary,
                      transition: 'all 0.15s',
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span>{opt.icon}</span>
                    <Text
                      size="sm"
                      weight={isActive ? 'medium' : 'normal'}
                      style={{ color: isActive ? accent : textSecondary, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {opt.label}
                    </Text>
                  </div>
                );
              })}
            </div>

            {/* ── Preview content container (cached tabs) ── */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                overflowX: 'hidden',
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {/* Agent: L1 Agent list — click switches main container */}
              {visitedTabs.has('agent') && (
              <PreviewCache visible={activePreview === 'agent'}>
                <Text weight="semibold" size="small" style={{ color: textSecondary, marginBottom: 4 }}>L1 Agent 列表</Text>
                {sampleAgents.map((a) => (
                  <div
                    key={a}
                    onClick={() => setMainView({ type: 'agent', id: a })}
                    style={{
                      padding: '8px 10px',
                      borderRadius: radius,
                      cursor: 'pointer',
                      border: `1px solid ${border}`,
                      background: bgSurface,
                      transition: 'border-color 0.15s',
                    }}
                  >
                    <Text size="sm" weight="medium" style={{ color: textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a}</Text>
                    <Text size="sm" style={{ color: textTertiary }}>点击切换主容器到此 Agent</Text>
                  </div>
                ))}
              </PreviewCache>
              )}
            
              {/* SubAgent */}
              {visitedTabs.has('subagent') && (
              <PreviewCache visible={activePreview === 'subagent'}>
                <Text weight="semibold" size="small" style={{ color: textSecondary, marginBottom: 4 }}>SubAgent</Text>
                {sampleSubAgents.map((s) => (
                  <div key={s} style={{ padding: '8px 10px', borderRadius: radius, border: `1px solid ${border}`, background: bgSurface }}>
                    <Text size="sm" style={{ color: textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s}</Text>
                  </div>
                ))}
              </PreviewCache>
              )}
            
              {/* Terminal */}
              {visitedTabs.has('terminal') && (
              <PreviewCache visible={activePreview === 'terminal'}>
                <div style={{ fontFamily: 'monospace', fontSize: 11, color: textSecondary, background: bgSurface, borderRadius: radius, padding: 10, border: `1px solid ${border}`, minHeight: 120 }}>
                  <div style={{ color: accent }}>$ civitas status</div>
                  <div>System: running</div>
                  <div>Agents: 5 active</div>
                  <div>Tasks: 3 pending</div>
                  <div style={{ color: textTertiary }}>_</div>
                </div>
              </PreviewCache>
              )}
            
              {/* Summary */}
              {visitedTabs.has('summary') && (
              <PreviewCache visible={activePreview === 'summary'}>
                <Text weight="semibold" size="small" style={{ color: textSecondary }}>工作区概要</Text>
                <div style={{ padding: 10, borderRadius: radius, border: `1px solid ${border}`, background: bgSurface }}>
                  <Text size="sm" style={{ color: textPrimary }}>当前工作区: Civitas-AI</Text>
                  <div style={{ marginTop: 4 }}><Text size="sm" style={{ color: textSecondary }}>活跃 Agent: 5</Text></div>
                  <div style={{ marginTop: 4 }}><Text size="sm" style={{ color: textSecondary }}>待处理任务: 3</Text></div>
                  <div style={{ marginTop: 4 }}><Text size="sm" style={{ color: textSecondary }}>运行时间: 2h 14m</Text></div>
                </div>
              </PreviewCache>
              )}
            
              {/* File viewer — click renderable file → render in file preview */}
              {visitedTabs.has('fileview') && (
              <PreviewCache visible={activePreview === 'fileview'}>
                <Text weight="semibold" size="small" style={{ color: textSecondary, marginBottom: 4 }}>文件查看</Text>
                {sampleFiles.map((f) => (
                  <div
                    key={f.name}
                    onClick={() => {
                      if (f.renderable) {
                        setPreviewFile(f.name);
                        setVisitedTabs((v) => new Set(v).add('filepreview'));
                        setActivePreview('filepreview');
                      }
                    }}
                    style={{
                      padding: '6px 10px',
                      borderRadius: radius,
                      cursor: f.renderable ? 'pointer' : 'default',
                      background: previewFile === f.name ? `${accent}14` : 'transparent',
                      borderLeft: previewFile === f.name ? `3px solid ${accent}` : '3px solid transparent',
                      opacity: f.renderable ? 1 : 0.5,
                    }}
                  >
                    <Text size="sm" style={{ color: f.renderable ? textPrimary : textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.name} {f.renderable ? '' : '(不可渲染)'}
                    </Text>
                  </div>
                ))}
              </PreviewCache>
              )}
            
              {/* File preview — renders content from file viewer selection */}
              {visitedTabs.has('filepreview') && (
              <PreviewCache visible={activePreview === 'filepreview'}>
                <Text weight="semibold" size="small" style={{ color: textSecondary, marginBottom: 4 }}>文件预览</Text>
                {previewFile ? (
                  <div style={{ padding: 10, borderRadius: radius, border: `1px solid ${border}`, background: bgSurface }}>
                    <Text size="sm" weight="medium" style={{ color: accent }}>{previewFile}</Text>
                    <div style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 11, color: textSecondary, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
                      {`// ${previewFile} 内容预览\nimport ...\n\nexport default ...`}
                    </div>
                  </div>
                ) : (
                  <Text size="sm" style={{ color: textTertiary }}>请在"文件查看"中点击可渲染文件</Text>
                )}
              </PreviewCache>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
