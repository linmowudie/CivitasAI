/**
 * Infra/Llm 模块导出桶
 */

// Provider
export { LlmProvider, ProviderError } from './Provider/providerBase.js';
export type { ModelSpec, ProviderConfig, ChatMessage, CallOptions, CallResult, StreamChunk, ErrorCategory } from './Provider/providerBase.js';
export { OpenAIProvider, createOpenAIProvider } from './Provider/openaiProvider.js';

// Retry
export { getRetryDecision, delay, classifyNetworkError } from './Provider/retryPolicy.js';
export type { RetryDecision } from './Provider/retryPolicy.js';

// Router
export { registerProvider, setRoutingConfig, getRoutingConfig, resolveModel, getProviders, getRegisteredModels, getFallbackProviders, resetRouter } from './Router/modelRouter.js';
export type { RoutingConfig, QualifiedModelName } from './Router/modelRouter.js';

// Slm (re-export)
export { callSlm, callSlmBatch } from '../Slm/slmCaller.js';
export type { SlmCallOptions, SlmCallResult } from '../Slm/slmCaller.js';

// Embedding (re-export)
export { getEmbeddings, getEmbedding } from '../Embedding/embeddingClient.js';
export type { EmbeddingOptions, EmbeddingResult } from '../Embedding/embeddingClient.js';
