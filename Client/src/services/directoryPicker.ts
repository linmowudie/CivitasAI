/**
 * 目录选择（Electron 原生对话框 / 浏览器降级）。
 *
 * 抽出来共享给两处：TitleBar 的 WorkDirBar（已有对话时只读）与
 * 新任务空态的 NewTaskSetup（选定工作目录后才允许发第一条消息）。
 */

/** Electron 预加载脚本暴露的目录选择能力（浏览器下不存在） */
interface ElectronDirAPI {
  pickDirectory?: () => Promise<string | null>;
}

/**
 * 让用户选一个目录。
 *
 * @returns
 * - `null`：用户取消（调用方应保持原目录不变）
 * - `''`  ：用户显式清空（调用方按"重置为默认目录"处理）
 * - 其它  ：选中的绝对路径
 */
export async function pickDirectory(current: string | null): Promise<string | null> {
  const api = (window as unknown as { electronAPI?: ElectronDirAPI }).electronAPI;
  if (api?.pickDirectory) {
    return await api.pickDirectory();
  }
  // 浏览器降级：无原生对话框，手工输入路径
  const input = window.prompt('输入工作目录绝对路径（留空 = 重置为默认目录）', current ?? '');
  if (input === null) return null;
  return input.trim();
}
