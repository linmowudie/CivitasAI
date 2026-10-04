/**
 * 内置工具注册器
 *
 * 扫描所有 Builtin/ + Custom/ 工具，批量注册到 Registry。
 * 启动 ⑫ 步调用。
 */

import type { Result } from '../Infra/types.js';

import type { ToolDefinition } from './Traits/toolSpec.js';
import { registerTools } from './Registry/toolRegistry.js';

// Builtin/Read
import { fileReader } from './Builtin/Read/fileReader.js';
import { dirLister } from './Builtin/Read/dirLister.js';
import { grepTool } from './Builtin/Read/grepTool.js';

// Builtin/Write
import { fileWriter } from './Builtin/Write/fileWriter.js';
import { fileEditor } from './Builtin/Write/fileEditor.js';

// Builtin/Execute
import { shellRunner } from './Builtin/Execute/shellRunner.js';
import { codeSandbox } from './Builtin/Execute/codeSandbox.js';

// Builtin/System（工具探索与统一派发：头部冻结 + 追加式工具）
import { toolExecutor } from './Builtin/System/toolExecutor.js';
import { toolSearcher } from './Builtin/System/toolSearcher.js';

// Builtin/Plan（Agent 计划清单：多 agent 各自归属，无副作用）
import { todoWriter } from './Builtin/Plan/todoWriter.js';

// Builtin/Search
import { webSearch } from './Builtin/Search/webSearch.js';
import { vectorSearch } from './Builtin/Search/vectorSearch.js';

// Custom
import { agentRecruiter } from './Custom/agentRecruiter.js';
import { submitForReview } from './Custom/submitForReview.js';

/** 所有内置工具定义 */
export const BUILTIN_TOOLS: ToolDefinition[] = [
  // Read (SAFE)
  fileReader,
  dirLister,
  grepTool,
  // Write (CONTROLLED)
  fileWriter,
  fileEditor,
  // Execute (DANGEROUS)
  shellRunner,
  codeSandbox,
  // System：工具探索 + 统一派发（元工具，永远在头部）
  toolSearcher,
  toolExecutor,
  // Plan (SAFE) —— Agent 计划清单（按 agentId 归属）
  todoWriter,
  // Search (SAFE)
  webSearch,
  vectorSearch,
  // Custom（编排类：招募 + 评审提交，均已实装）
  agentRecruiter,
  submitForReview,
];

/**
 * 注册所有内置工具
 *
 * @returns 成功注册的工具数量
 */
export function registerBuiltinTools(): Result<number> {
  return registerTools(BUILTIN_TOOLS);
}
