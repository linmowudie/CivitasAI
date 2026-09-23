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
  // Search (SAFE)
  webSearch,
  vectorSearch,
  // Custom (stub)
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
