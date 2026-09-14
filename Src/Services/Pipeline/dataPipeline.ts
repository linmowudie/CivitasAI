/**
 * @module Pipeline/dataPipeline
 * @description
 * 数据管道——处理数据类请求的标准化管道�?
 */

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';

/** 数据管道阶段 */
export type DataPipelineStage = 'validate' | 'transform' | 'enrich' | 'persist' | 'notify';

/** 数据管道上下�?*/
export interface DataPipelineContext {
  stage: DataPipelineStage;
  data: Record<string, unknown>;
  errors: string[];
  metadata: Record<string, unknown>;
}

/** 数据管道处理�?*/
export type DataPipelineHandler = (ctx: DataPipelineContext) => Promise<DataPipelineContext>;

const handlers: Map<DataPipelineStage, DataPipelineHandler[]> = new Map();

/** 注册管道处理�?*/
export function registerDataHandler(stage: DataPipelineStage, handler: DataPipelineHandler): void {
  const list = handlers.get(stage) || [];
  list.push(handler);
  handlers.set(stage, list);
}

/** 执行数据管道 */
export async function executeDataPipeline(
  initialData: Record<string, unknown>,
): Promise<Result<DataPipelineContext>> {
  const stages: DataPipelineStage[] = ['validate', 'transform', 'enrich', 'persist', 'notify'];
  let ctx: DataPipelineContext = {
    stage: 'validate',
    data: initialData,
    errors: [],
    metadata: {},
  };

  for (const stage of stages) {
    ctx.stage = stage;
    const stageHandlers = handlers.get(stage) || [];

    for (const handler of stageHandlers) {
      try {
        ctx = await handler(ctx);
      } catch (e) {
        ctx.errors.push(`${stage}: ${e instanceof Error ? e.message : String(e)}`);
        return err('PIPELINE_ERROR', `数据管道 ${stage} 阶段失败: ${ctx.errors.join(', ')}`);
      }
    }
  }

  return ok(ctx);
}

/** 清空所有处理器 */
export function clearDataHandlers(): void {
  handlers.clear();
}
