/**
 * 工具 Traits 模块导出桶
 */

export type {
  ToolSpec, ToolDefinition, ToolExecutor, ToolResult, ToolExecutionContext,
  ToolError, ArtifactEntry, JsonSchema,
  Idempotency, Reversibility, SideEffectScope, SandboxMode, UserRole, RateLimit,
} from './toolSpec.js';
export { toolSuccess, toolError } from './toolSpec.js';

export { validateToolSpec, validateInput } from './specValidator.js';
export type { ValidationResult } from './specValidator.js';
