/**
 * 工作方式（WorkingMode）显示标签。
 *
 * 抽到独立模块：Composer（底栏选择器）与新任务空态的 NewTaskSetup 都要用，
 * 避免两处各写一份导致文案漂移。
 */
import type { WorkingMode } from '@/stores/chatStore';

export const WORKING_MODE_LABELS: Record<WorkingMode, string> = {
  DIRECT: '直接执行',
  DELEGATION: '委托模式',
  ASSEMBLY_LINE: '流水线',
  CONSORTIUM: 'consortium',
  LITIGATION: '诉讼模式',
  REGULATION: '监管模式',
  AUDIT: '审计模式',
};

/** 有序的工作方式选项（供 <select> 渲染） */
export const WORKING_MODE_OPTIONS = Object.entries(WORKING_MODE_LABELS) as Array<[WorkingMode, string]>;
