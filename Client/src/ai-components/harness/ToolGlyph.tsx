/**
 * Harness.ToolGlyph——工具执行的视觉语义动画。
 *
 * 规格：`+工具+描述` 里的"工具"位。**只在工具使用中**（generating / pending）播放动画，
 * 出结果后回落为同义静态图标（保持界面安静，也便于快速扫读结果）。
 *
 * | 语义    | 形态                         | 触发词（见 toolVisuals）        |
 * |---------|------------------------------|--------------------------------|
 * | gaze    | 小眼睛左右扫视 + 眨眼        | 读/查/列/搜/取（探索型）        |
 * | flow    | 从左到右「细→宽→细」的光流    | 写/编辑/更新/创建               |
 * | erase   | 方块阵列沉浮                 | 删除/清空/移除                  |
 * | pulse   | 终端扫描线                   | 执行命令/跑代码                 |
 * | gear    | 轨道环旋转                   | 系统类调用 / 工具派发           |
 *
 * - `data-mode`：`running`（执行中）/ `preparing`（模型还在生成参数，更慢更淡）/ `settled`
 * - `data-visual`：语义名，供样式与测试定位
 * - 装饰性图形统一 `aria-hidden`，语义由同一行的工具名 + 描述文本承载；
 *   `prefers-reduced-motion` 下停用全部动画但保留图形（状态仍可读）。
 */

import type { CSSProperties } from 'react';
import { Eye, Pencil, Play, Settings, Trash2 } from 'lucide-react';
import type { ToolRunStatus, ToolVisualKind } from './toolVisuals';
import { classifyToolVisual } from './toolVisuals';
import styles from './ToolGlyph.module.css';

// ── Props ───────────────────────────────────────────────────────────

interface ToolGlyphProps {
  /** 工具名（用于推断语义） */
  toolName: string;
  status: ToolRunStatus;
  /** 强制指定语义（组头"探索中"用：即使无 running 也显示小眼睛） */
  visual?: ToolVisualKind;
  /** 图形尺寸（px），默认 12（与既有图标一致） */
  size?: number;
  className?: string;
}

/** 出结果后回落使用的静态图标 */
const STATIC_ICONS: Record<ToolVisualKind, typeof Eye> = {
  gaze: Eye,
  flow: Pencil,
  erase: Trash2,
  pulse: Play,
  gear: Settings,
};

export function ToolGlyph({ toolName, status, visual, size = 12, className }: ToolGlyphProps) {
  const kind = visual ?? classifyToolVisual(toolName);
  const active = status === 'generating' || status === 'pending';

  // 已出结果：静态图标（不播放动画）
  if (!active) {
    const Icon = STATIC_ICONS[kind];
    return (
      <Icon
        size={size}
        className={[className, styles.settled].filter(Boolean).join(' ')}
        data-testid="tool-glyph"
        data-visual={kind}
        data-mode="settled"
        aria-hidden="true"
      />
    );
  }

  const mode = status === 'generating' ? 'preparing' : 'running';
  const vars = { '--glyph-size': `${size}px` } as CSSProperties;

  return (
    <span
      className={[styles.glyph, className].filter(Boolean).join(' ')}
      style={vars}
      data-testid="tool-glyph"
      data-visual={kind}
      data-mode={mode}
      data-animated="true"
      aria-hidden="true"
    >
      {renderShape(kind)}
    </span>
  );
}

// ── 各语义的动画图形 ────────────────────────────────────────────────

function renderShape(kind: ToolVisualKind) {
  switch (kind) {
    // 小眼睛：瞳孔左右扫视 + 定时眨眼
    case 'gaze':
      return (
        <span className={styles.eyeOuter}>
          <span className={styles.eyePupil} />
        </span>
      );

    // 光流：两道错相光条连续穿过，途中由细变宽再变细（避免单道时"半程空窗"）
    case 'flow':
      return (
        <span className={styles.track}>
          <span className={styles.beam} />
          <span className={styles.beamAlt} />
        </span>
      );

    // 方块阵列沉浮：错峰上下浮动
    case 'erase':
      return (
        <span className={styles.blocks}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={styles.block}
              style={{ '--i': i } as CSSProperties}
            />
          ))}
        </span>
      );

    // 终端扫描线
    case 'pulse':
      return (
        <span className={styles.term}>
          <span className={styles.termLine} />
          <span className={styles.termLine} />
          <span className={styles.termScan} />
        </span>
      );

    // 轨道环
    case 'gear':
      return (
        <span className={styles.orbit}>
          <span className={styles.orbitDot} />
        </span>
      );
  }
}
