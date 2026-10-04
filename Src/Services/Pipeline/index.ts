/**
 * @module Pipeline/index
 * @description
 * 标准化管道三件（命令 / 数据 / 事件）——Docs/Agent/13 §S8。
 *
 * **接线状态（FE-063 决策，2026-10-04）**：0 生产消费（仅测试锚定）——
 * 保留为**架构预留管道**。投产前需逐项决策：
 *  - 命令管道 与 工具派发（`Tools/Registry/toolDispatcher`）能力重叠；
 *  - 事件管道 与 `Services/EventBus` 能力重叠（本模块有独立的 registerEventHandler/publishEvent 语义）；
 *  - 数据管道 面向数据类请求的标准化处理（当前无使用场景）。
 * 使用方按需接入或收敛删除（决策记录于 FE-063 条目）。
 */

export { type DataPipelineStage, type DataPipelineContext, type DataPipelineHandler, registerDataHandler, executeDataPipeline, clearDataHandlers } from './dataPipeline.js';
export { type SystemEvent, type EventPayload, type EventHandler, registerEventHandler, publishEvent, getEventLog, clearEventPipeline } from './eventPipeline.js';
export { type SystemCommand, type CommandRequest, type CommandResult, type CommandHandler, registerCommandHandler, executeCommand, getRegisteredCommands, clearCommandHandlers } from './commandPipeline.js';
