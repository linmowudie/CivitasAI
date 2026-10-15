export {
  type PreSupervisionInput,
  type PreSupervisionResult,
  runPreSupervision,
} from "./preSupervision.js";
export type { RateLimitConfig } from "../../Infra/Contracts/rateLimitTypes.js";
export {
  type CompressSupervisionResult,
  runCompressSupervision,
} from "./compressSupervision.js";
export {
  type SummarySupervisionResult,
  runSummarySupervision,
} from "./summarySupervision.js";
export {
  type ReasoningSupervisionResult,
  runReasoningSupervision,
} from "./reasoningSupervision.js";
export {
  type LoopSupervisionResult,
  type IterationRecord,
  runLoopSupervision,
  detectDeadlock,
} from "./loopSupervision.js";
export {
  type PostSupervisionInput,
  type ExitDecision,
  type PostSupervisionResult,
  runPostSupervision,
} from "./postSupervision.js";

// ── 管理策略机族（《一些思考3》§1.6/§5.1：多台可插拔策略机 + 选择器）──
export {
  BUILTIN_STRATEGIES,
  countMessageTokens,
  countMessagesTokens,
  tailStartIndex,
  safeSplitIndex,
  buildSummaryMessages,
  microPruneStrategy,
  subtaskIsolationStrategy,
  memoryFlushStrategy,
  structuredSummaryStrategy,
  emergencyTruncateStrategy,
} from "./compactionStrategies.js";
export {
  registerStrategy,
  registerStrategies,
  unregisterStrategy,
  getStrategies,
  getStrategyCount,
  clearStrategies,
  resetStrategies,
  selectStrategies,
} from "./strategyRegistry.js";
