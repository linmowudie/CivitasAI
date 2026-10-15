/**
 * 工作方式（WorkingMode）显示标签。
 *
 * 抽到独立模块：Composer（底栏选择器）、NewTaskSetup（新任务空态）与 TaskPanel 都要用，
 * 避免多处各写一份导致文案漂移。
 *
 * 只列**编排器当前真能执行**的四种（与后端 `taskApi.SUBMITTABLE_MODES` 对齐）：
 * LITIGATION / REGULATION 在 `RoutingMode` 里存在但 switch 无分支（S12 未实现），
 * AUDIT 从来不是工作方式。给它们做选项等于提供点了必然失败的选择。
 *
 * 非 DIRECT 在对话流里会**转交编排器执行**（回执带后台任务号，见 ipcBridge
 * `yieldToOrchestrator`），不是"选了也没用"。
 */
import type { WorkingMode } from "@/stores/chatStore";

export const WORKING_MODE_LABELS: Record<WorkingMode, string> = {
  DIRECT: "直接执行",
  DELEGATION: "委托模式（后台任务）",
  ASSEMBLY_LINE: "流水线（后台任务）",
  CONSORTIUM: "协作攻坚（后台任务）",
};

/** 有序的工作方式选项（供 <select> 渲染） */
export const WORKING_MODE_OPTIONS = Object.entries(
  WORKING_MODE_LABELS,
) as Array<[WorkingMode, string]>;

export function isWorkingMode(value: unknown): value is WorkingMode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(WORKING_MODE_LABELS, value)
  );
}
