/**
 * ui.* 段读取入口 —— 把设置面板上的「界面节流」项接到真实消费方
 *
 * REV-265 的口径：面板能改的键必须有消费者。`ui.*` 由渲染层本机即时消费，
 * 因此读取放在消费处（轮询钩子、流式缓冲、事件缓冲），而不是只存在 schema 里。
 *
 * 取值优先级与面板一致：本地期望值 > 后端运行态值 > schema 出厂默认。
 * 后端不可达时前两级为空，落到默认值，行为与未接配置前一致。
 */
import { useConfigStore, FIELD_MAP } from "@/stores/configStore";

const SOURCE = "default";

/**
 * schema 里 ui.* 的 path 自带段前缀（`ui.maxEventBufferSize`），key 因此是
 * `default::ui.maxEventBufferSize`；调用方传短名即可，这里统一补段名。
 *
 * 未声明时**不抛**：这里被渲染钩子与流式/事件缓冲的定时器读取，抛错会打断界面；
 * 只点名一次并落回出厂默认，配置层缺失不该演变成运行时崩溃。
 */
const warned = new Set<string>();

function keyOf(path: string): string {
  const key = `${SOURCE}::${path.startsWith("ui.") ? path : `ui.${path}`}`;
  if (!FIELD_MAP[key] && !warned.has(key)) {
    warned.add(key);
    console.warn(
      "[uiSettings] ui 配置项未在 configSchema 声明，已落回默认值",
      key,
    );
  }
  return key;
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 非钩子场景（store 内部、按次调用）读取即时值 */
export function uiNumber(path: string, fallback: number): number {
  return toPositiveNumber(
    useConfigStore.getState().effective(keyOf(path)),
    fallback,
  );
}

/** 组件场景：配置变化会重渲染，用于重启定时器等副作用 */
export function useUiNumber(path: string, fallback: number): number {
  const value = useConfigStore((s) => s.effective(keyOf(path)));
  return toPositiveNumber(value, fallback);
}
