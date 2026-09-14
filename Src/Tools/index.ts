/**
 * Tools 层导出桶
 */

// Traits
export type {
  ToolSpec, ToolDefinition, ToolExecutor, ToolResult, ToolExecutionContext,
  ToolError, ArtifactEntry, JsonSchema,
  Idempotency, Reversibility, SideEffectScope, SandboxMode, UserRole, RateLimit,
} from './Traits/toolSpec.js';
export { toolSuccess, toolError } from './Traits/toolSpec.js';
export { validateToolSpec, validateInput } from './Traits/specValidator.js';
export type { ValidationResult } from './Traits/specValidator.js';

// Registry
export {
  registerTool, registerTools, getTool, executeTool,
  getRegisteredToolNames, getAllToolSpecs, getToolsByDangerLevel,
  getToolCount, clearRegistry, isToolRegistered,
} from './Registry/toolRegistry.js';

// Factory
export { getVisibleTools, getVisibleToolNames, isToolVisible } from './Factory/toolFactory.js';
export type { RoleToolConfig } from './Factory/toolFactory.js';

// Builtin Loader
export { registerBuiltinTools, BUILTIN_TOOLS } from './builtinLoader.js';
