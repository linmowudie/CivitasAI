/**
 * 模型路由器（Docs/02 §10.4）
 *
 * 职责：
 * - 注册 Provider 及其模型
 * - 路由调用到正确的 Provider
 * - context_window 缺失拒注（启动失败）
 * - 支持 fallback 顺序
 */

import type { Result } from '../../types.js';
import { ok, err } from '../../types.js';
import { LlmProvider } from '../Provider/providerBase.js';
import type { ModelSpec } from '../Provider/providerBase.js';

// ===== 类型定义 =====

/** 路由配置 */
export interface RoutingConfig {
  readonly defaultModel: string;
  readonly directorModel: string;
  readonly workerModel: string;
  readonly verifierModel: string;
  readonly arbitrationModels: string[];
  readonly fallbackOrder: string[];
  readonly timeoutMs: number;
  readonly firstByteTimeoutMs: number;
  readonly interChunkTimeoutMs: number;
}

/** 模型全限定名 = provider/model */
export type QualifiedModelName = string;

// ===== 内部状态 =====

const providers = new Map<string, LlmProvider>();
const modelRegistry = new Map<QualifiedModelName, { provider: LlmProvider; spec: ModelSpec }>();
let routingConfig: RoutingConfig | null = null;

// ===== 公开 API =====

/**
 * 注册 Provider（启动时调用）
 *
 * context_window 缺失的模型会被拒绝注册。
 */
export function registerProvider(provider: LlmProvider): Result<void> {
  try {
    providers.set(provider.name, provider);

    for (const spec of provider.getModels()) {
      const qualified = `${provider.name}/${spec.id}`;
      modelRegistry.set(qualified, { provider, spec });
    }

    return ok(undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`注册 Provider 失败: ${message}`, 'FATAL');
  }
}

/**
 * 设置路由配置
 */
export function setRoutingConfig(config: RoutingConfig): void {
  routingConfig = config;
}

/**
 * 获取路由配置
 */
export function getRoutingConfig(): RoutingConfig | null {
  return routingConfig;
}

/**
 * 解析模型全限定名到 Provider + Spec
 */
export function resolveModel(qualifiedName: QualifiedModelName): Result<{ provider: LlmProvider; spec: ModelSpec }> {
  const entry = modelRegistry.get(qualifiedName);
  if (!entry) {
    return err(`模型 ${qualifiedName} 未注册`, 'ERROR');
  }
  return ok(entry);
}

/**
 * 获取所有已注册的 Provider
 */
export function getProviders(): LlmProvider[] {
  return Array.from(providers.values());
}

/**
 * 获取所有已注册的模型
 */
export function getRegisteredModels(): QualifiedModelName[] {
  return Array.from(modelRegistry.keys());
}

/**
 * 获取 fallback 顺序的 Provider 列表
 */
export function getFallbackProviders(): LlmProvider[] {
  if (!routingConfig) return getProviders();
  return routingConfig.fallbackOrder
    .map(name => providers.get(name))
    .filter((p): p is LlmProvider => p !== undefined);
}

/**
 * 重置注册状态（测试用）
 */
export function resetRouter(): void {
  providers.clear();
  modelRegistry.clear();
  routingConfig = null;
}
