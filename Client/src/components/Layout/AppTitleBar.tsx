/**
 * AppTitleBar —— 窗口顶部标题栏（与 Windows 最小化/最大化/关闭三键同一栏）。
 *
 * 背景：应用使用无边框窗口（`frame: false` + `titleBarStyle: 'hidden'` +
 * `titleBarOverlay`，见 electron/main.ts），系统只绘制**右上角的三个窗口按钮**，
 * 标题栏本体（纯黑 34px 条）由前端负责：
 *  - 高度必须与 `--titlebar-height`（index.css）及 `titleBarOverlay.height` 一致；
 *  - 整条是**拖拽区**（`-webkit-app-region: drag`），双击可最大化（系统行为）；
 *  - 左侧放项目标识；**右侧 ~140px 必须留空**，否则会被系统窗口按钮盖住/挡住点击。
 */
import ProjectLogo from './ProjectLogo';

/** 系统窗口按钮（最小化/最大化/关闭）占用的宽度，右侧需留白 */
export const WINDOW_CONTROLS_RESERVE_PX = 140;

export default function AppTitleBar() {
  return (
    <div
      className="fixed top-0 left-0 right-0 z-[2147483646] flex items-center
                 bg-black select-none"
      style={{
        height: 'var(--titlebar-height)',
        // 整条可拖拽移动窗口；内部交互元素由 index.css 的 no-drag 规则兜底
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <div className="flex items-center pl-3 min-w-0">
        <ProjectLogo size={18} withWordmark />
      </div>
      {/* 右侧留给系统窗口按钮：不放置任何内容，避免被覆盖或挡住点击 */}
      <div style={{ width: WINDOW_CONTROLS_RESERVE_PX, flexShrink: 0 }} />
    </div>
  );
}
