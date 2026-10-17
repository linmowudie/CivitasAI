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
// ── 互等死锁看门（SUP-ENV-DEADLOCKWIRE，设计 §3.3）──
// 与 loopSupervision.detectDeadlock 的分工：
// - `detectDeadlock`（既有）只判 A↔B 二元互等，供循环监督的记录视图使用；
// - `detectWaitDeadlock`（本模块）做**有向图环检测**（支持多跳环），是运行期看门的判定核；
// - `checkLoopDeadlock` 是运行期入口（留痕 + 事件 + 告警），由主循环每轮 ② 步调用。
export {
  type WaitPair,
  type DeadlockCheckResult,
  detectDeadlock as detectWaitDeadlock,
  findDeadlockCycle,
  registerAgentWait,
  clearAgentWait,
  collectWaitingPairs,
  resetDeadlockWatch,
  checkLoopDeadlock,
} from "./deadlockWatch.js";
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
