/**
 * @module Infra/Contracts/index
 * @description
 * 跨层共享内核契约统一导出。
 *
 * 本目录承载需被多层共同向下依赖的纯类型契约（零运行时、零上层 import），
 * 用于消除层间反向依赖。详见各契约模块头部说明与 ADR-0006。
 */

export * from './middlewareTypes.js';
