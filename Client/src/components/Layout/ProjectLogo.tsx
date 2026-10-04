/**
 * ProjectLogo —— 「Civitas-AI · 智体城邦」项目标识（内联 SVG，矢量）。
 *
 * 设计概念（对应系统架构，而不是随手画的图形）：
 *  - **六边形外框**：城邦/城墙边界 —— "Civitas"（城邦）即一个自洽的治理单元；
 *  - **中心实心节点 + 三个卫星节点**：一个主控（prime director）与若干 agent；
 *  - **节点之间的连线**：agent 之间的协作/通信关系，连线**不带方向箭头**，
 *    对应"部分 agent 是**平级**关系"（无强制层级）；
 *  - **右上角留白缺口**：六边形并非闭合城墙 —— 表示可招募新 agent / 对外开放。
 *
 * 实现：内联 SVG，尺寸由 `size` 决定（默认 22px），颜色取设计令牌
 * （`--color-brand-*`），因此与主题一致、任意缩放都清晰，无需位图资源。
 */

interface ProjectLogoProps {
  /** 正方形边长（px），默认 22 */
  size?: number;
  /** 是否显示右侧文字标识（CIVITAS / 智体城邦） */
  withWordmark?: boolean;
  /** 附加类名（布局用） */
  className?: string;
}

/** 六边形顶点（28×28 视图，中心 14,14，半径 12）：右上角留一处缺口 */
const HEX_PATH = 'M 14 2 L 24.4 8 L 24.4 20 L 14 26 L 3.6 20 L 3.6 8 Z';
/** 缺口：从右上顶点起跳过的短边（表示"可扩展、未闭合"） */
const HEX_GAP = 'M 22.6 5.6 L 24.4 8';

export default function ProjectLogo({ size = 22, withWordmark = false, className = '' }: ProjectLogoProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 28 28"
        role="img"
        aria-label="Civitas-AI 智体城邦"
        // 矢量：任意缩放不糊；颜色全部取自设计令牌
        style={{ flexShrink: 0 }}
      >
        <defs>
          <linearGradient id="civitas-logo-stroke" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-brand-300)" />
            <stop offset="100%" stopColor="var(--color-brand-600)" />
          </linearGradient>
          <radialGradient id="civitas-logo-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--color-brand-200)" />
            <stop offset="100%" stopColor="var(--color-brand-500)" />
          </radialGradient>
        </defs>

        {/* 城邦边界（右上留缺口 → 可招募/开放） */}
        <path d={HEX_PATH} fill="none" stroke="url(#civitas-logo-stroke)" strokeWidth="1.6" strokeLinejoin="round" />
        <path d={HEX_GAP} fill="none" stroke="var(--color-surface-900)" strokeWidth="2.6" strokeLinecap="round" />

        {/* agent 协作网络：中心主控 + 三个平级节点（无方向连线） */}
        <g stroke="var(--color-brand-500)" strokeWidth="1" opacity="0.75">
          <line x1="14" y1="14" x2="14" y2="7.4" />
          <line x1="14" y1="14" x2="8.2" y2="19.2" />
          <line x1="14" y1="14" x2="19.8" y2="19.2" />
          {/* 平级节点之间的横向连线（peer-to-peer） */}
          <line x1="8.2" y1="19.2" x2="19.8" y2="19.2" opacity="0.55" />
        </g>

        {/* 中心节点：主控（prime director） */}
        <circle cx="14" cy="14" r="2.6" fill="url(#civitas-logo-core)" />
        {/* 卫星节点：平级/执行 agent */}
        <circle cx="14" cy="7.4" r="1.7" fill="var(--color-brand-300)" />
        <circle cx="8.2" cy="19.2" r="1.7" fill="var(--color-brand-300)" />
        <circle cx="19.8" cy="19.2" r="1.7" fill="var(--color-brand-300)" />
      </svg>

      {withWordmark && (
        <span className="min-w-0 leading-none">
          <span className="block text-[11px] font-semibold tracking-[0.16em] text-text-primary">CIVITAS</span>
          <span className="block text-[8px] tracking-[0.22em] text-brand-400 mt-[3px]">智体城邦 · AI</span>
        </span>
      )}
    </span>
  );
}
