/**
 * 内置工具注册器
 *
 * 扫描所有 Builtin/ + Custom/ 工具，批量注册到 Registry。
 * 启动 ⑫ 步调用。
 */

import type { Result } from "../Infra/types.js";

import type { ToolDefinition } from "./Traits/toolSpec.js";
import { registerTools } from "./Registry/toolRegistry.js";

// Builtin/Read
import { fileReader } from "./Builtin/Read/fileReader.js";
import { dirLister } from "./Builtin/Read/dirLister.js";
import { grepTool } from "./Builtin/Read/grepTool.js";

// Builtin/Write
import { fileWriter } from "./Builtin/Write/fileWriter.js";
import { fileEditor } from "./Builtin/Write/fileEditor.js";

// Builtin/Execute
import { shellRunner } from "./Builtin/Execute/shellRunner.js";
import { codeSandbox } from "./Builtin/Execute/codeSandbox.js";

// Builtin/System（工具探索与统一派发：头部冻结 + 追加式工具）
import { toolExecutor } from "./Builtin/System/toolExecutor.js";
import { toolSearcher } from "./Builtin/System/toolSearcher.js";

// Builtin/Plan（Agent 计划清单：多 agent 各自归属，无副作用）
import { todoWriter } from "./Builtin/Plan/todoWriter.js";

// Builtin/Search
import { webSearch } from "./Builtin/Search/webSearch.js";
import { vectorSearch } from "./Builtin/Search/vectorSearch.js";
import { memoryWrite } from "./Builtin/Memory/memoryWrite.js";
// Builtin/Multimodal（多模态路径 a：文本主模型 + 视觉工具）
import { sightUse } from "./Builtin/Multimodal/sightUse.js";

// Custom
import { agentRecruiter } from "./Custom/agentRecruiter.js";
import { submitForReview } from "./Custom/submitForReview.js";
import { orchestratorCompose } from "./Custom/orchestratorCompose.js";
import { orchestratorSelect } from "./Custom/orchestratorSelect.js";
import { agentSplit } from "./Custom/agentSplit.js";
import { agentMerge } from "./Custom/agentMerge.js";

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
  memoryWrite,
  // Multimodal (SAFE) —— 视觉工具（多模态路径 a：文本主模型 + 视觉工具）
  sightUse,
  // Custom（编排类：招募 + 评审提交，均已实装）
  agentRecruiter,
  submitForReview,
  // Custom（组装闭环类：C6 的工具身份 —— 改结构与选件，仅 L1 外层）
  orchestratorCompose,
  orchestratorSelect,
  // Custom（分裂/自合并类：兄弟账本链路 —— **内层** L1 可达，不含改结构）
  agentSplit,
  agentMerge,
];

/**
 * 注册所有内置工具
 *
 * @returns 成功注册的工具数量
 */
export function registerBuiltinTools(): Result<number> {
  return registerTools(BUILTIN_TOOLS);
}
