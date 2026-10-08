/**
 * Harness 工具视觉语言——工具名 → 视觉语义（动画）+ 人读描述。
 *
 * 设计（工具展示动画改造）：
 * - **五类视觉语义**：
 *   `gaze`  小眼睛查阅（读文件/检索/列目录）
 *   `flow`  从左到右「细→宽→细」的光流（写文件/编辑/更新）
 *   `erase` 方块阵列沉浮（删除/清空/移除）
 *   `pulse` 终端扫描线（执行命令/跑代码）
 *   `gear`  轨道环（系统类调用、工具派发）
 * - **动画只在"使用工具中"播放**（`generating` / `pending`）；出结果后回落为静态同义图标
 *   （状态由 `ToolGlyph` 依据 `status` 决定，本模块只做分类）。
 * - **探索态**：同一工具组内只要还有未完成的探索型（`gaze`）调用，就持续显示小眼睛；
 *   全部完成后 `summarizeToolGroup().exploring` 转 false——对应"接下来都是探索性内容"
 *   时"一致显示小眼睛直到探索完"的诉求。
 *
 * 本模块是**纯函数层**（不依赖 React / store），便于单测；渲染交给 `ToolGlyph.tsx`
 * 与 `ToolGroup.tsx`。
 *
 * 注意：分段匹配**区分大小写**（`Read_file` 不算 read），与既有
 * `Tests/AIComponents/subscribeAndToolGroup.spec.ts` 的断言口径一致；
 * 仅额外做驼峰切分（`readFile` → `read_File`）。
 */

import type { ComponentSubgroup } from '../types';

// ── 类型 ────────────────────────────────────────────────────────────

/** 工具视觉语义（动画形态） */
export type ToolVisualKind = 'gaze' | 'flow' | 'erase' | 'pulse' | 'gear';

/** 工具运行状态（与 `chatStore.ToolCallEntry['status']` 结构一致，避免反向依赖 store） */
export type ToolRunStatus = 'generating' | 'pending' | 'success' | 'error';

/** 工具组汇总状态 */
export type ToolGroupState = 'generating' | 'executing' | 'exploring' | 'done' | 'failed';

/** 单个工具的展示描述（`+工具+描述` 中的"描述"） */
export interface ToolDescription {
  /** 动作（中文）：读取文件 / 修改文件 / 删除内容 … */
  label: string;
  /** 作用对象（路径、查询、命令…），可能缺省 */
  target?: string;
  /** 附加量词：写入 1.2 KB / 3 项 / 6 行 … */
  detail?: string;
  /** 最终展示串：`label · target · detail` */
  text: string;
}

/** 工具组汇总 */
export interface ToolGroupSummary {
  total: number;
  /** 已出结果（success / error） */
  settled: number;
  /** 使用中（generating / pending） */
  running: number;
  /** 参数生成中 */
  generating: number;
  failed: number;
  /** 该组存在过探索型调用 */
  hasExploratory: boolean;
  /** 仍有未完成的探索型调用（→ 持续显示小眼睛） */
  exploring: boolean;
  /** 探索型调用全部完成 */
  explored: boolean;
  /** 各视觉语义计数 */
  counts: Record<ToolVisualKind, number>;
  /** 组头应展示的动画形态：探索中恒为 gaze，否则取运行中/最后一个工具 */
  visual: ToolVisualKind;
  state: ToolGroupState;
  /** 组头状态词 */
  label: string;
}

// ── 词表与匹配 ──────────────────────────────────────────────────────

const BOUNDARY = '[._\\-\\s/]';

/** 删除类（块阵列沉浮） */
const ERASE_WORDS = ['delete', 'remove', 'rm', 'unlink', 'drop', 'purge', 'clear', 'erase',
  'truncate', 'destroy', 'discard', 'wipe', 'clean'];

/** 写入类（光流） */
const FLOW_WORDS = ['write', 'create', 'edit', 'update', 'patch', 'append', 'save', 'apply',
  'replace', 'move', 'rename', 'mkdir', 'copy', 'upload', 'put', 'set', 'insert', 'add',
  'commit', 'mount', 'chmod', 'archive'];

/** 执行类（终端扫描） */
const PULSE_WORDS = ['exec', 'execute', 'run', 'eval', 'shell', 'bash', 'cmd', 'command',
  'spawn', 'launch', 'start', 'stop', 'restart', 'kill', 'install', 'build', 'test',
  'deploy', 'compile', 'lint', 'typecheck'];

/** 查阅/探索类（小眼睛） */
const GAZE_WORDS = ['read', 'open', 'view', 'cat', 'show', 'get', 'fetch', 'load', 'search',
  'find', 'grep', 'glob', 'list', 'ls', 'dir', 'query', 'inspect', 'scan', 'browse',
  'lookup', 'resolve', 'stat', 'head', 'tail', 'tree', 'peek', 'examine'];

/** 显式覆盖（跨词表歧义 / 语义特例，优先于词表） */
const EXPLICIT_VISUALS: ReadonlyArray<readonly [string, ToolVisualKind]> = [
  // 工具派发不是"跑命令"，走系统轨道
  ['tool.execute', 'gear'],
  // 工具检索是探索行为
  ['tool.search', 'gaze'],
  ['agent.recruit', 'gear'],
  ['agent.submit_review', 'gear'],
];

function makeMatcher(words: readonly string[]): RegExp {
  return new RegExp(`(?:^|${BOUNDARY})(?:${words.join('|')})(?:$|${BOUNDARY})`);
}

const MATCHERS: ReadonlyArray<readonly [ToolVisualKind, RegExp]> = [
  ['erase', makeMatcher(ERASE_WORDS)],
  ['flow', makeMatcher(FLOW_WORDS)],
  ['pulse', makeMatcher(PULSE_WORDS)],
  ['gaze', makeMatcher(GAZE_WORDS)],
];

/** 驼峰切分为下划线（`readFile` → `read_File`），大小写保持不变 */
function splitCamel(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
}

/**
 * 工具名 → 视觉语义。
 *
 * 判定顺序：显式覆盖 → 删除 → 写入 → 执行 → 查阅 → 系统。
 * 大小写敏感，按 `.`/`_`/`-`/`/`/空格 分词（含驼峰切分）。
 */
export function classifyToolVisual(toolName: string): ToolVisualKind {
  if (!toolName) return 'gear';
  for (const [prefix, kind] of EXPLICIT_VISUALS) {
    if (toolName === prefix || toolName.startsWith(`${prefix}.`)) return kind;
  }
  const probe = splitCamel(toolName);
  for (const [kind, matcher] of MATCHERS) {
    if (matcher.test(probe)) return kind;
  }
  return 'gear';
}

/** 探索型工具：需要"小眼睛"的查阅/检索/列举类调用 */
export function isExploratoryTool(toolName: string): boolean {
  return classifyToolVisual(toolName) === 'gaze';
}

/** 视觉语义 → 组件子分组（保持 `ComponentSubgroup` 四态不变） */
export function subgroupOfVisual(kind: ToolVisualKind): ComponentSubgroup {
  switch (kind) {
    case 'gaze': return 'read';
    case 'flow': return 'write';
    case 'erase': return 'write';
    case 'pulse': return 'exec';
    case 'gear': return 'system';
  }
}

/**
 * 工具名 → 子分组（读/写/执行/系统）。
 *
 * 兼容旧的名称前缀口径，并扩展点号/驼峰命名（`file.read` → read）。
 * 仍保持大小写敏感：`Read_file` → system。
 */
export function inferSubgroup(toolName: string): ComponentSubgroup {
  return subgroupOfVisual(classifyToolVisual(toolName));
}

// ── 中文动作词 ──────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  'file.read': '读取文件',
  'file.write': '写入文件',
  'file.edit': '修改文件',
  'file.delete': '删除文件',
  'file.grep': '搜索文件内容',
  'dir.list': '列出目录',
  'shell.exec': '执行命令',
  'code.eval': '执行代码',
  'web.search': '联网搜索',
  'vector.search': '语义检索',
  'tool.search': '查找工具',
  'tool.execute': '调用工具',
  'todo.write': '更新待办',
  'agent.recruit': '招募智能体',
  'agent.submit_review': '提交评审',
  // 兼容下划线/旧式命名（历史模型输出与测试夹具）
  read_file: '读取文件',
  read_dir: '列出目录',
  list_dir: '列出目录',
  write_file: '写入文件',
  edit_file: '修改文件',
  delete_file: '删除文件',
  remove_file: '删除文件',
  run_command: '执行命令',
  exec_command: '执行命令',
  shell_command: '执行命令',
  search_files: '搜索文件内容',
  grep_files: '搜索文件内容',
  web_search: '联网搜索',
};

const VISUAL_LABELS: Record<ToolVisualKind, string> = {
  gaze: '查阅',
  flow: '写入',
  erase: '删除',
  pulse: '执行',
  gear: '调用',
};

// ── 描述构建 ────────────────────────────────────────────────────────

/** 各语义下"作用对象"参数的取值优先级 */
const TARGET_PRIORITY: Record<ToolVisualKind, readonly string[]> = {
  gaze: ['path', 'filePath', 'file_path', 'file', 'dir', 'directory', 'root',
    'pattern', 'query', 'keyword', 'url', 'name'],
  flow: ['path', 'filePath', 'file_path', 'file', 'dir', 'directory', 'target', 'url', 'name'],
  erase: ['path', 'filePath', 'file_path', 'file', 'target'],
  pulse: ['command', 'cmd', 'script', 'path', 'file'],
  gear: ['name', 'tool', 'toolName', 'agentId', 'role', 'target'],
};

const MAX_TARGET = 46;
const MAX_INLINE = 18;

function shorten(value: string, max = MAX_TARGET): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // 路径类保留尾部（文件名/最后一段更有信息量）
  return `…${flat.slice(flat.length - (max - 1))}`;
}

function formatSize(chars: number): string {
  if (chars < 1024) return `${chars} 字符`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

function pickTarget(kind: ToolVisualKind, args: Record<string, unknown>): string | undefined {
  for (const key of TARGET_PRIORITY[kind]) {
    const raw = args[key];
    if (typeof raw === 'string' && raw.trim() !== '') return shorten(raw);
    if (Array.isArray(raw) && raw.length > 0) {
      const first = raw.find((v) => typeof v === 'string' && v.trim() !== '');
      if (typeof first === 'string') return `${shorten(first)} 等 ${raw.length} 项`;
    }
  }
  return undefined;
}

function buildDetail(kind: ToolVisualKind, args: Record<string, unknown>): string | undefined {
  // 写入：内容体量
  if (typeof args.content === 'string' && (kind === 'flow' || kind === 'erase')) {
    return `写入 ${formatSize(args.content.length)}`;
  }
  // 编辑：查找替换
  if (kind === 'flow' && typeof args.search === 'string' && typeof args.replace === 'string') {
    return '查找替换';
  }
  // 检索：命中模式
  if (kind === 'gaze' && typeof args.pattern === 'string' && args.pattern.trim() !== '') {
    return `「${shorten(args.pattern, MAX_INLINE)}」`;
  }
  // 执行代码：行数
  if (kind === 'pulse' && typeof args.code === 'string') {
    const lines = args.code.split('\n').length;
    return `${lines} 行`;
  }
  // 批量对象：条数
  const bulk = args.paths ?? args.todos ?? args.items;
  if (Array.isArray(bulk)) return `${bulk.length} 项`;
  return undefined;
}

/**
 * 工具调用 → 人读描述（`+工具+描述` 里的"描述"）。
 *
 * 例：`file.read { path: 'Src/main.ts' }` → `读取文件 · Src/main.ts`；
 *     `file.write { path, content }`   → `写入文件 · a.ts · 写入 1.2 KB`；
 *     `shell.exec { command: 'npm test' }` → `执行命令 · npm test`。
 */
export function describeToolCall(
  toolName: string,
  args: Record<string, unknown> = {},
): ToolDescription {
  const kind = classifyToolVisual(toolName);
  const label = TOOL_LABELS[toolName] ?? VISUAL_LABELS[kind];
  const target = pickTarget(kind, args);
  const detail = buildDetail(kind, args);
  const text = [label, target, detail].filter(Boolean).join(' · ');
  return { label, target, detail, text };
}

// ── 工具组汇总 ──────────────────────────────────────────────────────

const EMPTY_COUNTS: Record<ToolVisualKind, number> = { gaze: 0, flow: 0, erase: 0, pulse: 0, gear: 0 };

/**
 * 汇总一组工具调用的运行态，供组头渲染。
 *
 * `visual`：探索中恒为 `gaze`（小眼睛持续显示）；否则取运行中工具，
 * 都已出结果时取最后一个工具（静态图标）。
 */
export function summarizeToolGroup(
  calls: ReadonlyArray<{ name: string; status: ToolRunStatus }>,
): ToolGroupSummary {
  const counts = { ...EMPTY_COUNTS };
  let running = 0;
  let generating = 0;
  let settled = 0;
  let failed = 0;
  let hasExploratory = false;
  let exploring = false;
  const runningKinds: ToolVisualKind[] = [];
  let lastKind: ToolVisualKind = 'gear';

  for (const call of calls) {
    const kind = classifyToolVisual(call.name);
    counts[kind] += 1;
    if (kind === 'gaze') hasExploratory = true;
    lastKind = kind;

    if (call.status === 'generating' || call.status === 'pending') {
      running += 1;
      if (call.status === 'generating') generating += 1;
      runningKinds.push(kind);
      if (kind === 'gaze') exploring = true;
    } else {
      settled += 1;
      if (call.status === 'error') failed += 1;
    }
  }

  const state: ToolGroupState = exploring
    ? 'exploring'
    : running > 0
      ? (generating === running ? 'generating' : 'executing')
      : failed > 0
        ? 'failed'
        : 'done';

  const label = state === 'exploring'
    ? '探索中…'
    : state === 'generating'
      ? '准备中…'
      : state === 'executing'
        ? '执行中…'
        : state === 'failed'
          ? `${failed} 项失败`
          : '已完成';

  return {
    total: calls.length,
    settled,
    running,
    generating,
    failed,
    hasExploratory,
    exploring,
    explored: hasExploratory && !exploring,
    counts,
    visual: exploring ? 'gaze' : (runningKinds[0] ?? lastKind),
    state,
    label,
  };
}

/** 组头紧凑计数串：`读取 2 · 写入 1`（0 计数的语义不显示） */
export function formatCounts(counts: Record<ToolVisualKind, number>): string {
  const parts: string[] = [];
  for (const kind of ['gaze', 'flow', 'erase', 'pulse', 'gear'] as ToolVisualKind[]) {
    const n = counts[kind];
    if (n > 0) parts.push(`${VISUAL_LABELS[kind]} ${n}`);
  }
  return parts.join(' · ');
}
