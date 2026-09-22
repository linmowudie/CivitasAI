/**
 * 设置面板 · 控件层
 *
 * 每个控件遵循业界最佳实践：
 *   - Toggle：二元开关，On/Off 态 + 颜色反馈（Setproduct）
 *   - Slider：区间 + 当前值 + min/max 端点标签 + 默认值刻度 + 联动数字输入（NNGroup）
 *   - Segmented：≤4 互斥选项
 *   - Select：>4 枚举
 *   - Number：步进 + min/max 夹紧
 *   - Tags：字符串数组增删
 */
import { useState } from 'react';
import type { FieldDef } from '@/config/schemaTypes';

/** 通用值类型 */
export type FieldValue = number | string | boolean | string[];

/** ── Toggle ───────────────────────────────────── */
function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => !disabled && onChange(!value)}
      className="settings-toggle"
      data-on={value}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      <span className="settings-toggle-knob" />
      <span className="settings-toggle-text">{value ? 'ON' : 'OFF'}</span>
    </button>
  );
}

/** ── Slider（区间 + 数字输入联动 + 默认刻度）────── */
function Slider({ field, value, onChange, disabled }: {
  field: FieldDef; value: number; onChange: (v: number) => void; disabled?: boolean;
}) {
  const min = field.min ?? 0;
  const max = field.max ?? 100;
  const step = field.step ?? 1;
  const pct = ((Math.min(Math.max(value, min), max) - min) / (max - min)) * 100;
  const defPct = typeof field.default === 'number'
    ? ((Math.min(Math.max(field.default, min), max) - min) / (max - min)) * 100 : 0;
  const isRatio = min === 0 && max === 1;
  const disp = isRatio ? Math.round(value * 100) : value;
  const clamp = (n: number) => Math.min(Math.max(n, min), max);

  return (
    <div className="settings-slider">
      <div className="settings-slider-track-wrap">
        <input
          type="range"
          min={min} max={max} step={step} value={value} disabled={disabled}
          onChange={e => onChange(clamp(Number(e.target.value)))}
          className="settings-range"
          style={{ ['--fill' as string]: `${pct}%` }}
        />
        <span className="settings-slider-default" style={{ left: `${defPct}%` }}
          title={`默认 ${isRatio ? `${Math.round(Number(field.default) * 100)}%` : field.default}`} />
      </div>
      <div className="settings-slider-side">
        {isRatio ? (
          <div className="settings-num-wrap">
            <input
              type="number" className="settings-input settings-input-sm"
              min={0} max={100} step="any"
              value={disp} disabled={disabled}
              onChange={e => onChange(clamp(Number(e.target.value) / 100))}
            />
            <span className="settings-unit">%</span>
          </div>
        ) : (
          <div className="settings-num-wrap">
            <input
              type="number" className="settings-input settings-input-sm"
              min={min} max={max} step="any"
              value={value} disabled={disabled}
              onChange={e => onChange(clamp(Number(e.target.value)))}
            />
            {field.unit && <span className="settings-unit">{field.unit}</span>}
          </div>
        )}
      </div>
      <div className="settings-slider-range">
        <span>{isRatio ? '0%' : `${min}${field.unit ?? ''}`}</span>
        <span>{isRatio ? '100%' : `${max}${field.unit ?? ''}`}</span>
      </div>
    </div>
  );
}

/** ── Number（步进输入）─────────────────────────── */
function NumberField({ field, value, onChange, disabled }: {
  field: FieldDef; value: number; onChange: (v: number) => void; disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  // 外部值变化（如重置）时同步
  const [lastExt, setLastExt] = useState(value);
  if (value !== lastExt) { setText(String(value)); setLastExt(value); }
  const commit = (raw: string) => {
    let n = Number(raw);
    if (Number.isNaN(n)) { setText(String(value)); return; }
    if (field.min !== undefined) n = Math.max(n, field.min);
    if (field.max !== undefined) n = Math.min(n, field.max);
    onChange(n); setText(String(n));
  };
  const bump = (dir: 1 | -1) => {
    const step = field.step ?? 1;
    let n = (Number(text) || value) + dir * step;
    if (field.min !== undefined) n = Math.max(n, field.min);
    if (field.max !== undefined) n = Math.min(n, field.max);
    onChange(n); setText(String(n));
  };
  return (
    <div className="settings-stepper">
      <input
        type="number" className="settings-input"
        value={text} disabled={disabled}
        min={field.min} max={field.max} step="any"
        onChange={e => setText(e.target.value)}
        onBlur={e => commit(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
      />
      {field.unit && <span className="settings-unit">{field.unit}</span>}
      <div className="settings-stepper-btns">
        <button type="button" disabled={disabled} onClick={() => bump(1)} aria-label="增加">▲</button>
        <button type="button" disabled={disabled} onClick={() => bump(-1)} aria-label="减少">▼</button>
      </div>
    </div>
  );
}

/** ── Select ───────────────────────────────────── */
function SelectField({ field, value, onChange, disabled }: {
  field: FieldDef; value: string; onChange: (v: string) => void; disabled?: boolean;
}) {
  return (
    <select
      className="settings-select" value={value} disabled={disabled}
      onChange={e => onChange(e.target.value)}
    >
      {(field.options ?? []).map(o => (
        <option key={o} value={o}>{field.enumLabels?.[o] ? `${field.enumLabels[o]} (${o})` : o}</option>
      ))}
    </select>
  );
}

/** ── Segmented ────────────────────────────────── */
function SegmentedField({ field, value, onChange, disabled }: {
  field: FieldDef; value: string; onChange: (v: string) => void; disabled?: boolean;
}) {
  return (
    <div className="settings-segmented" role="tablist">
      {(field.options ?? []).map(o => (
        <button key={o} type="button" role="tab" aria-selected={value === o} disabled={disabled}
          className={`settings-seg-btn${value === o ? ' active' : ''}`}
          onClick={() => onChange(o)}>
          {field.enumLabels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

/** ── Text ─────────────────────────────────────── */
function TextField({ value, onChange, disabled }: {
  value: string; onChange: (v: string) => void; disabled?: boolean;
}) {
  return (
    <input type="text" className="settings-input settings-input-wide"
      value={value} disabled={disabled} onChange={e => onChange(e.target.value)} />
  );
}

/** ── Tags（字符串数组）────────────────────────── */
function TagsField({ value, onChange, disabled }: {
  value: string[]; onChange: (v: string[]) => void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft('');
  };
  return (
    <div className="settings-tags">
      <div className="settings-tags-list">
        {value.length === 0 && <span className="settings-tags-empty">（空）</span>}
        {value.map(t => (
          <span key={t} className="settings-tag">
            <code>{t}</code>
            {!disabled && (
              <button type="button" className="settings-tag-x" aria-label={`移除 ${t}`}
                onClick={() => onChange(value.filter(v => v !== t))}>×</button>
            )}
          </span>
        ))}
      </div>
      {!disabled && (
        <div className="settings-tags-add">
          <input type="text" className="settings-input settings-input-wide" placeholder="输入后回车添加…"
            value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
          <button type="button" className="settings-mini-btn" onClick={add}>添加</button>
        </div>
      )}
    </div>
  );
}

/** ── 控件分发 ─────────────────────────────────── */
export function FieldControl({ field, value, onChange, disabled }: {
  field: FieldDef; value: FieldValue; onChange: (v: FieldValue) => void; disabled?: boolean;
}) {
  switch (field.control) {
    case 'toggle':
      return <Toggle value={Boolean(value)} onChange={onChange} disabled={disabled} />;
    case 'slider':
      return <Slider field={field} value={Number(value) || 0} onChange={onChange} disabled={disabled} />;
    case 'number':
      return <NumberField field={field} value={Number(value) || 0} onChange={onChange} disabled={disabled} />;
    case 'select':
      return <SelectField field={field} value={String(value)} onChange={onChange} disabled={disabled} />;
    case 'segmented':
      return <SegmentedField field={field} value={String(value)} onChange={onChange} disabled={disabled} />;
    case 'tags':
      return <TagsField value={Array.isArray(value) ? value : []} onChange={onChange} disabled={disabled} />;
    case 'text':
    default:
      return <TextField value={String(value ?? '')} onChange={onChange} disabled={disabled} />;
  }
}

/** 展示值（用于「默认 vs 当前」文案） */
export function formatValue(field: FieldDef, v: FieldValue): string {
  const isRatio = field.type === 'number' && field.min === 0 && field.max === 1;
  if (typeof v === 'boolean') return v ? '开' : '关';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '（空）';
  if (typeof v === 'number' && isRatio) return `${Math.round(v * 100)}%`;
  if (typeof v === 'number') return `${v}${field.unit ? ' ' + field.unit : ''}`;
  return field.enumLabels?.[String(v)] ?? String(v);
}
