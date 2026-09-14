/**
 * @module TokenEconomy/consumptionRecorder
 * @description
 * 消耗记录器——Docs/04 §3.1。
 * 精确记录每次 LLM 调用的 Token 消耗，计算成本 + 税额。
 * 每次消耗产生 ConsumptionRecord + 钱包扣减 + 交易记录。
 */

import type { ConsumptionRecord, ModelPricing } from './types.js';
import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { debit, recordTaxPayment } from './walletManager.js';

// ── 内部状态 ────────────────────────────────────────────────────────

const records: ConsumptionRecord[] = [];
const pricingTable: Map<string, ModelPricing> = new Map();

// ── 定价表管理 ──────────────────────────────────────────────────────

/**
 * 注册模型定价——从 modelRouter.json 加载
 */
export function registerPricing(pricing: ModelPricing): void {
  const key = `${pricing.provider}/${pricing.modelId}`;
  pricingTable.set(key, { ...pricing });
}

/**
 * 获取模型定价
 */
export function getPricing(provider: string, modelId: string): ModelPricing | undefined {
  return pricingTable.get(`${provider}/${modelId}`);
}

// ── 消耗记录 ────────────────────────────────────────────────────────

export interface RecordConsumptionInput {
  traceId: string;
  agentId: string;
  operationId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  currentTaxRate: number;
}

/**
 * 记录一次 LLM 调用的消耗
 *
 * 流程：
 * 1. 查找模型定价
 * 2. 计算消耗 Token 成本
 * 3. 计算税额
 * 4. 扣减钱包（消耗 + 税）
 * 5. 记录 ConsumptionRecord
 */
export function recordConsumption(
  input: RecordConsumptionInput,
): Result<ConsumptionRecord> {
  const pricing = getPricing(input.provider, input.model);
  if (!pricing) {
    return err(`模型 ${input.provider}/${input.model} 未注册定价`);
  }

  const now = Date.now();
  const totalTokens = input.promptTokens + input.completionTokens;

  // 成本计算（Docs/04 §6.2）
  const inputCost = input.promptTokens * pricing.costPer1kInput / 1000;
  const outputCost = input.completionTokens * pricing.costPer1kOutput / 1000;
  const calculatedCost = Math.ceil(inputCost + outputCost);
  const taxAmount = Math.ceil(calculatedCost * input.currentTaxRate);
  const netDeduction = calculatedCost + taxAmount;

  // 扣减钱包
  const debitResult = debit(input.agentId, netDeduction, input.traceId, 'LLM_CONSUMPTION', {
    provider: input.provider,
    model: input.model,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    calculatedCost,
    taxAmount,
  });

  if (!debitResult.ok) return err(debitResult.error);

  // 记录纳税
  if (taxAmount > 0) {
    recordTaxPayment(input.agentId, taxAmount, input.traceId);
  }

  const record: ConsumptionRecord = {
    recordId: `cr-${now}-${records.length}`,
    traceId: input.traceId,
    agentId: input.agentId,
    operationId: input.operationId,
    provider: input.provider,
    model: input.model,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens,
    unitCostPer1K: pricing.costPer1kInput,
    calculatedCost,
    taxAmount,
    netDeduction,
    startedAt: now,
    completedAt: Date.now(),
  };

  records.push(record);
  return ok(record);
}

// ── 查询 ────────────────────────────────────────────────────────────

export function getConsumptionRecords(filter?: {
  agentId?: string;
  traceId?: string;
}): ConsumptionRecord[] {
  let result = records;
  if (filter?.agentId) result = result.filter(r => r.agentId === filter.agentId);
  if (filter?.traceId) result = result.filter(r => r.traceId === filter.traceId);
  return [...result];
}

export function getTotalConsumption(agentId?: string): number {
  const filtered = agentId ? records.filter(r => r.agentId === agentId) : records;
  return filtered.reduce((sum, r) => sum + r.netDeduction, 0);
}

/**
 * 清空记录（测试用）
 */
export function clearConsumptionRecords(): void {
  records.length = 0;
  pricingTable.clear();
}
