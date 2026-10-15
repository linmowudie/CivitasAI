/**
 * SystemConfig —— 标准设置面板（替换原 JSON 片段只读视图）
 *
 * 交互模型：
 *   - 左侧分组导航（每组显示「已修改」计数）+ 全局搜索
 *   - 右侧按 section 分块，每个配置键渲染为语义化控件：
 *     toggle / slider(区间+默认刻度) / select / segmented / number / tags
 *   - 「默认值 vs 当前值」：修改项高亮 + 单项重置（重置 = 请后端删除用户覆盖）
 *   - 顶部支持整组/全部重置、导出合并 JSON（便于核对与迁移）
 *
 * 生效口径（REV-265/266）：**界面不自行宣称生效**。
 *   - 取值来自 `GET /api/configs/effective`：`running`=后端进程在用，`onDisk`=重启后会读到
 *   - 每项的「已生效 / 待重启生效 / 待提交 / 后端不接受 / 写入被拒」由这两份视图比对得出
 *   - 写入走 `PUT /api/configs/user`，白名单与启动校验器试跑都在后端
 *   - 策略标签表示**什么时候提交**给后端，不表示什么时候生效
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Settings, Search, RotateCcw, Download, Lock, AlertTriangle, Check, X,
  RefreshCw, Cpu, GitBranch, Wallet, ShieldCheck, Scale, Database,
  HardDrive, History, Copy, Loader2, ChevronRight, Cloud, CloudOff, Zap,
} from 'lucide-react';
import { useConfigStore, deriveFieldState, isPathAccepted, DEFAULT_MARK, type FieldEffectKind } from '@/stores/configStore';
import { useHotReloadStore } from '@/stores/hotReloadStore';
import { CONFIG_GROUPS, CONFIG_SCHEMA, ALL_FIELDS } from '@/config/configSchema';
import type { FieldDef, ReloadStrategy } from '@/config/schemaTypes';
import { FieldControl, formatValue, type FieldValue } from '@/components/Settings/fields';
import ModelProviderPanel from '@/components/Settings/ModelProviderPanel';

const ICONS: Record<string, typeof Settings> = {
  Settings, RefreshCw, Cpu, GitBranch, Wallet, ShieldCheck, Scale, Search,
  Database, HardDrive, History, Lock,
};

/** 提交时机标签：说明「什么时候把改动写给后端」，不说明「什么时候生效」 */
const STRATEGY_LABELS: Record<ReloadStrategy, { label: string; color: string }> = {
  immediate: { label: '即时提交', color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  afterReply: { label: '回复后提交', color: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  onNavigate: { label: '离开时提交', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  onRestart: { label: '即时提交·重启生效', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
};

/** 生效态标签：全部由后端 running/onDisk 视图推导，界面不自造 */
const EFFECT_LABELS: Record<FieldEffectKind, { label: string; color: string }> = {
  live: { label: '已生效', color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  queued: { label: '待提交', color: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  saving: { label: '提交中', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  'pending-restart': { label: '待重启生效', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
  'not-accepted': { label: '不可写', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
  rejected: { label: '写入被拒', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
  'backend-offline': { label: '仅本机未提交', color: 'bg-neutral-500/20 text-neutral-400 border-neutral-500/30' },
};

/** ── 单个配置行 ───────────────────────────────── */
function FieldRow({ field }: { field: FieldDef }) {
  const effective = useConfigStore(s => s.effective(field.key));
  const modified = useConfigStore(s => s.isModified(field.key));
  const setValue = useConfigStore(s => s.setValue);
  const resetField = useConfigStore(s => s.resetField);
  const dismissPending = useHotReloadStore(s => s.dismissPending);

  // 生效态输入**逐项订阅原始值**：返回对象的 selector 每次都是新引用，会让面板反复重渲染
  const hasDesired = useConfigStore(s => field.key in s.overrides);
  const desired = useConfigStore(s => s.overrides[field.key]);
  const running = useConfigStore(s => s.loaded[field.key]);
  const disk = useConfigStore(s => s.disk[field.key]);
  const pendingRestart = useConfigStore(s => s.restartPending.some(p => p.path === field.path));
  const willBe = useConfigStore(s => s.restartPending.find(p => p.path === field.path)?.onDisk);
  const saving = useConfigStore(s => s.saving[field.key] === true);
  const error = useConfigStore(s => s.writeErrors[field.key]);
  const policy = useConfigStore(s => s.policy);
  const backendReachable = useConfigStore(s => s.backendReachable);
  const [copied, setCopied] = useState(false);

  const state = deriveFieldState({
    path: field.path, hasDesired, desired, running, disk,
    pendingRestart, saving, error, policy, backendReachable,
  });

  const disabled = Boolean(field.locked);
  const strategy = field.reloadStrategy ?? 'afterReply';
  const strategyInfo = STRATEGY_LABELS[strategy];
  const effectInfo = EFFECT_LABELS[state.kind];

  return (
    <div className={`setting-row${modified ? ' modified' : ''}${disabled ? ' locked' : ''}`}>
      <div className="setting-main">
        <div className="setting-head">
          <span className="setting-label">{field.label}</span>
          {modified && <span className="setting-badge-modified">已修改</span>}
          {disabled && <span className="setting-badge-locked"><Lock size={10} /> 锁定</span>}
          <span className={`setting-badge-strategy ${effectInfo.color}`}>{effectInfo.label}</span>
          <span className={`setting-badge-strategy ${strategyInfo.color}`}>
            {strategyInfo.label}
          </span>
        </div>
        <code className="setting-path">{field.source}.json · {field.path}</code>
        {field.description && <p className="setting-desc">{field.description}</p>}
        {field.constraint && (
          <p className="setting-constraint"><AlertTriangle size={11} className="inline" /> {field.constraint}</p>
        )}
        {field.locked && <p className="setting-locked-reason">🔒 {field.locked}</p>}
        {modified && (
          <p className="setting-default-hint">
            默认：{formatValue(field, field.default as FieldValue)}
          </p>
        )}
        {/* 生效态说明一律来自后端视图，不在前端猜 */}
        {state.kind === 'queued' && (
          <p className="setting-restart-hint">
            <Zap size={11} className="inline" /> 尚未提交给后端：到达「{strategyInfo.label}」时机时才写入
            <button type="button" className="setting-reset" onClick={() => dismissPending(field.key)}>
              <X size={11} /> 撤销这项待提交
            </button>
          </p>
        )}
        {state.kind === 'saving' && <p className="setting-restart-hint"><Loader2 size={11} className="inline animate-spin" /> 正在写入后端用户配置层…</p>}
        {state.kind === 'pending-restart' && (
          <p className="setting-restart-hint">
            <AlertTriangle size={11} className="inline text-red-400" /> 已写入配置文件，后端进程仍在用旧值；
            重启后将读到 {formatValue(field, (willBe ?? field.default) as FieldValue)}
          </p>
        )}
        {state.kind === 'not-accepted' && (
          <p className="setting-restart-hint">
            <AlertTriangle size={11} className="inline text-red-400" />
            该键不在后端可写白名单内（启动锁定/安全红线项），改动只记录在界面，<b>不会生效</b>
          </p>
        )}
        {state.kind === 'rejected' && (
          <p className="setting-restart-hint">
            <X size={11} className="inline text-red-400" /> 后端拒绝写入：{state.reason}
          </p>
        )}
        {state.kind === 'backend-offline' && (
          <p className="setting-restart-hint">
            <AlertTriangle size={11} className="inline text-red-400" />
            后端不可达（读不到 /api/configs/effective），改动只留在本机，<b>不会生效</b>
          </p>
        )}
      </div>

      <div className="setting-control">
        <FieldControl
          field={field}
          value={effective}
          disabled={disabled}
          onChange={v => setValue(field.key, v)}
        />
        <div className="setting-actions">
          {modified && !disabled && (
            <button type="button" className="setting-reset" title="重置为默认值"
              onClick={() => resetField(field.key)}>
              <RotateCcw size={12} /> 重置
            </button>
          )}
          <button type="button" className="setting-copy" title="复制键名"
            onClick={() => { navigator.clipboard?.writeText(field.path); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>
    </div>
  );
}

/** ── section 分块 ─────────────────────────────── */
function Section({ title, fields }: { title: string; fields: FieldDef[] }) {
  return (
    <div className="setting-section">
      <div className="setting-section-title">
        <ChevronRight size={14} className="text-brand-400" />
        {title}
        <span className="setting-section-count">{fields.length}</span>
      </div>
      <div className="setting-section-body">
        {fields.map(f => <FieldRow key={f.key} field={f} />)}
      </div>
    </div>
  );
}

export default function SystemConfig() {
  const [activeGroup, setActiveGroup] = useState('loop');
  const [query, setQuery] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const hydrated = useRef(false);

  const loading = useConfigStore(s => s.loading);
  const loadedAt = useConfigStore(s => s.loadedAt);
  const hydrate = useConfigStore(s => s.hydrate);
  const resetGroup = useConfigStore(s => s.resetGroup);
  const resetAll = useConfigStore(s => s.resetAll);
  const exportMerged = useConfigStore(s => s.exportMerged);
  const dirty = useConfigStore(s => s.dirty);
  const backendReachable = useConfigStore(s => s.backendReachable);
  // 订阅 overrides 引用 + 后端视图引用：修改/重置/刷新都会重渲染，计数才不会滞后
  const overrides = useConfigStore(s => s.overrides);
  const isModified = useConfigStore(s => s.isModified);
  const restartPending = useConfigStore(s => s.restartPending);
  const policy = useConfigStore(s => s.policy);

  // 提交时机队列（数组本身，不代表生效状态）
  const pending = useHotReloadStore(s => s.pending);

  useEffect(() => {
    if (!hydrated.current) { hydrated.current = true; hydrate(); }
  }, [hydrate]);

  const searching = query.trim().length > 0;

  // 搜索结果：跨所有分组按 label/description/path 匹配
  const searchResults = useMemo(() => {
    if (!searching) return [];
    const q = query.trim().toLowerCase();
    return Object.values(CONFIG_SCHEMA).flat().filter(f =>
      f.label.toLowerCase().includes(q)
      || f.path.toLowerCase().includes(q)
      || (f.description ?? '').toLowerCase().includes(q),
    );
  }, [query, searching]);

  const group = CONFIG_GROUPS.find(g => g.id === activeGroup)!;
  const groupFields = CONFIG_SCHEMA[activeGroup] ?? [];
  const groupModified = groupFields.filter(f => isModified(f.key)).length;
  const totalModified = ALL_FIELDS.filter(f => isModified(f.key)).length;

  // 状态统计：待提交（本地队列）/ 待重启生效（后端 running≠onDisk）/ 后端不接受（白名单）
  const totalQueued = pending.length;
  const afterReplyQueued = pending.filter(p => p.strategy === 'afterReply').length;
  const onNavigateQueued = pending.filter(p => p.strategy === 'onNavigate').length;
  const totalRestartPending = restartPending.length;
  const totalNotAccepted = policy
    ? ALL_FIELDS.filter(f => !f.locked && !isPathAccepted(policy, f.path)).length
    : 0;
  /** 首帧 hydrate 尚未完成时不下「后端不可达」的结论 */
  const backendOffline = !backendReachable && !loading && loadedAt !== null;

  // 按 section 聚合当前组字段（保持声明顺序）
  const sections = useMemo(() => {
    const map = new Map<string, FieldDef[]>();
    for (const f of groupFields) {
      if (!map.has(f.section)) map.set(f.section, []);
      map.get(f.section)!.push(f);
    }
    return [...map.entries()];
  }, [groupFields]);

  const exportJson = useMemo(() => {
    if (!exportOpen) return '';
    return JSON.stringify(exportMerged(), null, 2);
  }, [exportOpen, exportMerged]);

  return (
    <div className="config-page">
      {/* ── 顶栏 ─────────────────────────────── */}
      <header className="config-header">
        <div className="config-header-left">
          <Settings size={18} className="text-brand-400" />
          <div>
            <h1 className="text-lg font-bold text-text-primary">系统配置</h1>
            <p className="text-[11px] text-text-muted">
              标准设置面板 · 取值来自后端运行态视图
              {loading ? ' · 加载中…' : backendReachable
                ? ` · 已读取后端生效态 ${loadedAt ? new Date(loadedAt).toLocaleTimeString() : ''}`
                : backendOffline ? ' · 后端不可达（改动不会生效）' : ''}
            </p>
          </div>
        </div>
        <div className="config-header-right">
          {/* 状态指示：全部由后端视图 / 提交队列得出，不宣称未确认的生效 */}
          {(backendOffline || totalQueued > 0 || totalRestartPending > 0 || totalNotAccepted > 0) && (
            <div className="config-reload-status">
              {backendOffline && (
                <span className="config-status-badge config-status-restart">
                  <AlertTriangle size={11} /> 后端不可达 · 改动仅存本机
                </span>
              )}
              {totalQueued > 0 && (
                <span className="config-status-badge config-status-pending">
                  <Zap size={11} />
                  {totalQueued} 项待提交
                  {` (${afterReplyQueued} 回复后, ${onNavigateQueued} 离开时)`}
                </span>
              )}
              {totalRestartPending > 0 && (
                <span className="config-status-badge config-status-restart">
                  <AlertTriangle size={11} /> {totalRestartPending} 项已落盘、重启后生效
                </span>
              )}
              {totalNotAccepted > 0 && (
                <span className="config-status-badge config-status-dirty">
                  <Lock size={11} /> {totalNotAccepted} 项后端不接受
                </span>
              )}
            </div>
          )}
          {/* 云端同步状态 */}
          <div className="config-sync-status">
            {dirty ? (
              <span className="config-status-badge config-status-dirty">
                <CloudOff size={11} /> 未同步
              </span>
            ) : totalModified > 0 ? (
              <span className="config-status-badge config-status-synced">
                <Cloud size={11} /> 已同步
              </span>
            ) : null}
          </div>
          <div className="config-search">
            <Search size={14} />
            <input
              placeholder="搜索配置项…" value={query}
              onChange={e => setQuery(e.target.value)}
            />
            {searching && (
              <button type="button" className="config-search-clear" onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            )}
          </div>
          <button type="button" className="config-btn" onClick={() => hydrate()} disabled={loading}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 重新加载
          </button>
          <button type="button" className="config-btn" onClick={() => { if (confirm('将所有配置项重置为出厂默认值？')) resetAll(); }}>
            <RotateCcw size={14} /> 全部重置
          </button>
          <button type="button" className="config-btn config-btn-primary" onClick={() => setExportOpen(true)}>
            <Download size={14} /> 导出 JSON
          </button>
        </div>
      </header>

      <div className="config-body">
        {/* ── 左侧分组导航 ───────────────────── */}
        {!searching && (
          <nav className="config-nav">
            {CONFIG_GROUPS.map(g => {
              const Icon = ICONS[g.icon] ?? Settings;
              const n = (CONFIG_SCHEMA[g.id] ?? []).filter(f => isModified(f.key)).length;
              return (
                <button key={g.id} type="button"
                  className={`config-nav-item${g.id === activeGroup ? ' active' : ''}`}
                  onClick={() => setActiveGroup(g.id)}>
                  <Icon size={15} className="config-nav-icon" />
                  <span className="config-nav-label">{g.label}</span>
                  {g.l0 && <Lock size={10} className="config-nav-l0" />}
                  {n > 0 && <span className="config-nav-count">{n}</span>}
                </button>
              );
            })}
            {/* 模型供应商入口 */}
            <button type="button"
              className={`config-nav-item${activeGroup === 'models' ? ' active' : ''}`}
              onClick={() => setActiveGroup('models')}>
              <Cpu size={15} className="config-nav-icon" />
              <span className="config-nav-label">模型供应商</span>
            </button>
          </nav>
        )}

        {/* ── 右侧内容 ───────────────────────── */}
        <main className="config-content">
          {searching ? (
            <div className="config-search-results">
              <div className="config-group-head">
                <h2 className="text-base font-bold text-text-primary">搜索结果</h2>
                <span className="text-xs text-text-muted">{searchResults.length} 项匹配 “{query}”</span>
              </div>
              {searchResults.length === 0
                ? <div className="config-empty">未找到匹配的配置项</div>
                : <Section title="匹配项" fields={searchResults} />}
            </div>
          ) : activeGroup === 'models' ? (
            <ModelProviderPanel />
          ) : (
            <>
              <div className="config-group-head">
                <div>
                  <h2 className="text-base font-bold text-text-primary">{group.label}</h2>
                  <p className="text-xs text-text-muted mt-0.5">{group.desc}</p>
                </div>
                <div className="config-group-head-right">
                  {groupModified > 0 && (
                    <span className="badge badge-warning text-[10px]">{groupModified} 项已修改</span>
                  )}
                  <button type="button" className="config-btn config-btn-sm"
                    onClick={() => { if (confirm(`将「${group.label}」全部重置为默认值？`)) resetGroup(group.id); }}>
                    <RotateCcw size={12} /> 重置本组
                  </button>
                </div>
              </div>

              {group.l0 && (
                <div className="config-l0-banner">
                  <Lock size={13} />
                  <span>本组为 <b>L0 启动锁定</b>：后端可写白名单<b>不包含</b>这些键，界面改动不会落盘；
                  如需变更请受控编辑 <code>Configs/</code> 后重启（运行期热更新会被拒绝并记 CONFIG_RELOAD_FAILED）。</span>
                </div>
              )}

              {sections.map(([title, fields]) => (
                <Section key={title} title={title} fields={fields} />
              ))}
            </>
          )}
        </main>
      </div>

      {/* ── 导出弹窗 ─────────────────────────── */}
      {exportOpen && (
        <div className="config-modal-mask" onClick={() => setExportOpen(false)}>
          <div className="config-modal" onClick={e => e.stopPropagation()}>
            <div className="config-modal-head">
              <h3 className="text-sm font-semibold text-text-primary">导出合并配置（后端当前值 + 本地期望值）</h3>
              <button type="button" onClick={() => setExportOpen(false)}><X size={16} /></button>
            </div>
            <p className="text-[11px] text-text-muted mb-2">
              按源文件重建的嵌套 JSON，仅作核对与迁移用。白名单内的键已由 <code>PUT /api/configs/user</code> 写入用户配置层
              （<code>{'<DATA_ROOT>'}/Configs/local.json</code>）；本视图含白名单外的项，那些只会出现在这里，不会落盘。
            </p>
            <pre className="config-export-pre">{exportJson}</pre>
            <div className="config-modal-foot">
              <button type="button" className="config-btn config-btn-primary"
                onClick={() => navigator.clipboard?.writeText(exportJson)}>
                <Copy size={14} /> 复制到剪贴板
              </button>
              <button type="button" className="config-btn"
                onClick={() => {
                  const blob = new Blob([exportJson], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url; a.download = 'civitas-configs.json'; a.click();
                  URL.revokeObjectURL(url);
                }}>
                <Download size={14} /> 下载
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 底部提示 */}
      <footer className="config-footer">
        <span className="text-[11px] text-text-muted">
          取值优先级：本地期望值 &gt; 后端运行态值 &gt; 出厂默认 · 当前 {totalModified} 项偏离默认
          {(() => {
            const real = Object.values(overrides).filter(v => v !== DEFAULT_MARK).length;
            return real > 0 ? `（其中 ${real} 项用户自定义）` : '';
          })()}
          {totalRestartPending > 0 && ` · ${totalRestartPending} 项已落盘待重启`}
          {backendOffline && ' · 后端不可达，改动不落盘'}
          <br />
          后端只在启动时读取配置：写入成功后必须重启进程才会进入运行态，界面对此逐项标注，不做「已生效」的推断。
        </span>
      </footer>
    </div>
  );
}
