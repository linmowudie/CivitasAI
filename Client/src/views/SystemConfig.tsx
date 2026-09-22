/**
 * SystemConfig —— 标准设置面板（替换原 JSON 片段只读视图）
 *
 * 交互模型对齐业界最佳实践：
 *   - 左侧分组导航（每组显示「已修改」计数）+ 全局搜索
 *   - 右侧按 section 分块，每个配置键渲染为语义化控件：
 *     toggle / slider(区间+默认刻度) / select / segmented / number / tags
 *   - 「默认值 vs 用户值」：用户值覆盖默认，修改项高亮 + 单项重置；顶部支持整组/全部重置
 *   - 导出合并后的 JSON（不落后端，避免直接改写受保护配置文件）
 *
 * 数据来源：schema 默认值（Docs/15 参数总典） + GET /api/configs/:name 文件当前值 + 本地覆盖层。
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Settings, Search, RotateCcw, Download, Lock, AlertTriangle, Check, X,
  RefreshCw, Cpu, GitBranch, Wallet, ShieldCheck, Scale, Database,
  HardDrive, History, Copy, Loader2, ChevronRight,
} from 'lucide-react';
import { useConfigStore, DEFAULT_MARK } from '@/stores/configStore';
import { CONFIG_GROUPS, CONFIG_SCHEMA, ALL_FIELDS } from '@/config/configSchema';
import type { FieldDef } from '@/config/schemaTypes';
import { FieldControl, formatValue, type FieldValue } from '@/components/Settings/fields';

const ICONS: Record<string, typeof Settings> = {
  Settings, RefreshCw, Cpu, GitBranch, Wallet, ShieldCheck, Scale, Search,
  Database, HardDrive, History, Lock,
};

/** ── 单个配置行 ───────────────────────────────── */
function FieldRow({ field }: { field: FieldDef }) {
  const effective = useConfigStore(s => s.effective(field.key));
  const modified = useConfigStore(s => s.isModified(field.key));
  const setValue = useConfigStore(s => s.setValue);
  const resetField = useConfigStore(s => s.resetField);
  const [copied, setCopied] = useState(false);

  const disabled = Boolean(field.locked);

  return (
    <div className={`setting-row${modified ? ' modified' : ''}${disabled ? ' locked' : ''}`}>
      <div className="setting-main">
        <div className="setting-head">
          <span className="setting-label">{field.label}</span>
          {modified && <span className="setting-badge-modified">已修改</span>}
          {disabled && <span className="setting-badge-locked"><Lock size={10} /> 锁定</span>}
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
  // 订阅 overrides / loaded 引用，任何修改/重置/重载都触发本组件重渲染，使计数实时
  const overrides = useConfigStore(s => s.overrides);
  const loaded = useConfigStore(s => s.loaded);
  const isModified = useConfigStore(s => s.isModified);

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
              标准设置面板 · 默认值 vs 用户值 · 核心行为参数
              {loading ? ' · 加载中…' : loadedAt ? ` · 已同步文件 ${new Date(loadedAt).toLocaleTimeString()}` : ''}
            </p>
          </div>
        </div>
        <div className="config-header-right">
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
                  <span>本组为 <b>L0 启动锁定</b>：修改需重启服务生效，运行期热更新会被拒绝并记 CONFIG_RELOAD_FAILED。</span>
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
              <h3 className="text-sm font-semibold text-text-primary">导出合并配置（默认值 + 用户覆盖）</h3>
              <button type="button" onClick={() => setExportOpen(false)}><X size={16} /></button>
            </div>
            <p className="text-[11px] text-text-muted mb-2">
              按源文件重建的嵌套 JSON。为避免直接改写受保护配置文件，请核对后手动应用到 Configs/。
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
          取值优先级：用户覆盖 &gt; 配置文件当前值 &gt; 出厂默认 · 当前 {totalModified} 项偏离默认
          {(() => {
            const real = Object.values(overrides).filter(v => v !== DEFAULT_MARK).length;
            return real > 0 ? `（其中 ${real} 项用户自定义）` : '';
          })()}
          · 控件与区间依据 Docs/15 参数总典 + 业界设置面板最佳实践
        </span>
      </footer>
    </div>
  );
}
