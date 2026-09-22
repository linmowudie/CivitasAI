/**
 * 配置 Schema —— 类型定义与工具
 *
 * 设计依据（业界最佳实践）：
 *   - VSCode `contributes.configuration`：每个设置项含 type / default / minimum /
 *     maximum / enum / enumDescriptions / description；UI 呈现「默认值 vs 用户值」
 *     双态，用户值覆盖默认值，配 "已修改" 标记与 "重置为默认" 动作。
 *   - NNGroup《Sliders & Knobs》：滑块必须①显示当前数值 ②标注 min/max 端点
 *     ③给默认值画刻度 ④配独立数字输入做精确调整 ⑤提供重置。
 *   - Setproduct《Settings UI》：toggle 用于二元开关；select 选项 5–7 个；
 *     互斥少量选项用分段按钮组。
 *
 * 因此本文件把「一个配置键」抽象为一个 FieldDef，控件类型由 control 决定，
 * 区间/枚举/单位/约束全部结构化，供设置面板数据驱动渲染。
 */

export type FieldType = 'boolean' | 'number' | 'enum' | 'string' | 'string[]';

export type Control =
  | 'toggle'    // 布尔开关
  | 'slider'    // number + [min,max] 连续/离散区间（带数字输入联动）
  | 'number'    // 纯数字步进输入
  | 'select'    // 枚举下拉（>4 项）
  | 'segmented' // 枚举分段按钮（≤4 项互斥）
  | 'text'      // 单行文本
  | 'tags';     // 字符串数组（可增删）

/** 单个配置字段的可渲染元数据 */
export interface FieldDef {
  /** 全局唯一键 = `${source}::${path}` */
  key: string;
  /** 源配置文件名（不含 .json），对应 GET /api/configs/:name */
  source: string;
  /** 在该 JSON 内的点分路径，如 'loopDefaults.max_iterations' */
  path: string;
  label: string;
  type: FieldType;
  control: Control;
  /** 出厂默认值（来自 Docs/15 参数总典，作为「默认值」基准） */
  default: number | string | boolean | string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** 枚举取值（与参数总典「枚举全集」逐字符一致） */
  options?: string[];
  /** 枚举选项的中文说明 */
  enumLabels?: Record<string, string>;
  description?: string;
  /** 硬约束提示（违反 = 启动失败/门禁拦截，Docs/15 §7） */
  constraint?: string;
  /** 锁定原因；存在即只读（如 Phase 0–2 禁 Redis、L0 安全项、fail-closed 项） */
  locked?: string;
  section: string;
}

/** 一个分组（对应侧边栏一项） */
export interface ConfigGroup {
  id: string;
  label: string;
  icon: string;          // lucide 图标名，视图侧映射
  source: string;        // 主源文件（用于加载）
  desc: string;
  /** 该组是否 L0 启动锁定（改后需重启），组级横幅提示 */
  l0?: boolean;
}

/** 取字段生效值：从嵌套对象按点分路径读取 */
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object' && k in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);
}

/** 沿点分路径写入（返回新对象，不改动入参） */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const clone = (Array.isArray(obj) ? [...obj] : { ...(obj as object) }) as Record<string, unknown>;
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = cur[k];
    cur[k] = (next && typeof next === 'object'
      ? (Array.isArray(next) ? [...next] : { ...next })
      : {}) as Record<string, unknown>;
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
  return clone as T;
}

/** 数值是否以「比例 0–1」存储（展示层 ×100 显示为百分比） */
export function isRatioField(f: FieldDef): boolean {
  return f.type === 'number' && f.min === 0 && f.max === 1;
}
