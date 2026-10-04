/**
 * @module Loop/loopEconomy
 * @description
 * 单轮迭代的经济记账（FE-065 实装）——把主循环与 Token 经济接线：
 *  ① 消耗明细（定价成本 + 税）→ 钱包扣费 + ConsumptionRecord（`recordConsumption`）；
 *  ② 双预算档位（warm/soft/expand/hard）→ 档位事件（`recordUsageAndDetect`）；
 *  ③ `TOKEN_CONSUMED` / `TAX_PAID` 事件发布（此前 TokenEconomy 域内 0 事件发布方）。
 *
 * 修复背景：`recordConsumption`（0 生产调用）/ `dualBudget`（0 消费）此前均为孤岛——
 * 钱包余额恒定、税率无数据输入、预算档位永不产生。
 *
 * fail-soft：经济为旁路能力——定价缺失 / 余额不足 / 未初始化一律仅告警/调试日志，
 * **绝不阻断 LLM 循环**（与钱包创建失败不阻断 Agent 创建的既有降级策略一致）。
 */

import { logger } from '../../Infra/Logging/logger.js';
import { EventType } from '../../Services/EventBus/eventTypes.js';
import { createEvent, publish } from '../../Services/EventBus/eventBus.js';
import { recordConsumption } from '../../Services/TokenEconomy/consumptionRecorder.js';
import { recordUsageAndDetect, type BudgetEvent } from '../../Services/TokenEconomy/dualBudget.js';
import { getCurrentTaxRate } from '../../Services/TokenEconomy/taxCollector.js';
import { recordConsumption as recordAnomalyConsumption } from '../../Services/Audit/anomalyDetector.js';

export interface IterationEconomyInput {
  traceId: string;
  agentId: string;
  iteration: number;
  /** 模型全限定名（provider/model）；非全限定格式跳过记账 */
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * 记录单轮迭代的经济账（fail-soft，无返回值）。
 */
export function recordIterationEconomy(input: IterationEconomyInput): void {
  try {
    const totalTokens = input.promptTokens + input.completionTokens;
    if (totalTokens <= 0) return;

    const slash = input.model.indexOf('/');
    const provider = slash > 0 ? input.model.slice(0, slash) : '';
    const modelId = slash > 0 ? input.model.slice(slash + 1) : input.model;

    if (!provider) {
      logger.debug('模型名非全限定格式，跳过经济记账', {
        source: 'Loop/loopEconomy',
        model: input.model,
      });
    } else {
      // ① 消耗明细 + 扣费（含税；定价缺失/余额不足 → err，降级不阻断）
      const taxRate = getCurrentTaxRate();
      const record = recordConsumption({
        traceId: input.traceId,
        agentId: input.agentId,
        operationId: `llm-${input.iteration}`,
        provider,
        model: modelId,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        currentTaxRate: taxRate,
      });

      if (record.ok) {
        publish(createEvent({
          eventType: EventType.TOKEN_CONSUMED,
          source: 'runIteration/⑥ModelCall',
          traceId: input.traceId,
          payload: {
            agentId: input.agentId,
            model: input.model,
            promptTokens: input.promptTokens,
            completionTokens: input.completionTokens,
            calculatedCost: record.value.calculatedCost,
            taxAmount: record.value.taxAmount,
            netDeduction: record.value.netDeduction,
          },
        }));
        if (record.value.taxAmount > 0) {
          publish(createEvent({
            eventType: EventType.TAX_PAID,
            source: 'runIteration/⑥ModelCall',
            traceId: input.traceId,
            payload: { agentId: input.agentId, taxAmount: record.value.taxAmount },
          }));
        }
      } else {
        logger.debug('Token 消耗未记账（降级：定价缺失或余额不足）', {
          source: 'Loop/loopEconomy',
          model: input.model,
          error: record.error,
        });
      }
    }

    // ② 双预算档位（trace 累计在 dualBudget 内部维护；阶段变化才产生事件）
    const budgetEvent = recordUsageAndDetect(input.traceId, totalTokens);
    if (budgetEvent) {
      publishBudgetEvent(input.traceId, budgetEvent);
    }

    // ③ 异常检测器数据流入（FE-061：真实消耗进检测器——此前 anomalyDetector.recordConsumption 0 消费）
    recordAnomalyConsumption(input.agentId, totalTokens);
  } catch (e) {
    logger.warn('经济记账异常（已忽略）', {
      source: 'Loop/loopEconomy',
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** 预算档位事件映射发布（expand_request 的扩展审批属后续专项，如实记录不伪造） */
function publishBudgetEvent(traceId: string, event: BudgetEvent): void {
  const eventTypeByKind: Partial<Record<BudgetEvent['type'], EventType>> = {
    BUDGET_WARMING: EventType.BUDGET_WARMING,
    BUDGET_SOFT_REACHED: EventType.BUDGET_SOFT_REACHED,
    BUDGET_HARD_REACHED: EventType.BUDGET_HARD_REACHED,
  };

  const eventType = eventTypeByKind[event.type];
  if (!eventType) {
    logger.warn('预算进入 expand_request 档（扩展审批未接线，仅记录）', {
      source: 'Loop/loopEconomy',
      traceId,
      tokensUsed: (event as { tokensUsed?: number }).tokensUsed,
    });
    return;
  }

  publish(createEvent({
    eventType,
    source: 'runIteration/⑥ModelCall',
    traceId,
    payload: { ...event },
  }));
}
