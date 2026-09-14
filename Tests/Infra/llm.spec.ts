/**
 * S3 Infra/Llm + Core/Model 模块测试
 *
 * 覆盖：providerBase / openaiProvider / modelRouter / retryPolicy / modelCaller
 * Gate G3：错误分类、重试策略、context_window 必填、真实连通性
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { LlmProvider, ProviderError } from '../../Src/Infra/Llm/Provider/providerBase.js';
import type { ProviderConfig, CallOptions, CallResult, StreamChunk, ModelSpec } from '../../Src/Infra/Llm/Provider/providerBase.js';
import { OpenAIProvider } from '../../Src/Infra/Llm/Provider/openaiProvider.js';
import { getRetryDecision, classifyNetworkError } from '../../Src/Infra/Llm/Provider/retryPolicy.js';
import {
  registerProvider, setRoutingConfig, resolveModel, getRegisteredModels,
  getProviders, getFallbackProviders, resetRouter,
} from '../../Src/Infra/Llm/Router/modelRouter.js';
import { callModel } from '../../Src/Core/Model/modelCaller.js';
import { parseSseStream, StreamTimeoutError } from '../../Src/Core/Model/streamParser.js';
import {
  createManagedAbortController, mergeAbortSignals, createTimeoutAbortController,
  isAborted, getAbortSource,
} from '../../Src/Core/Model/abortSignal.js';
import { callSlm } from '../../Src/Infra/Slm/slmCaller.js';
import type { Result } from '../../Src/Infra/types.js';

// ===== 测试用 Provider =====

const TEST_CONFIG: ProviderConfig = {
  provider: 'test-provider',
  base_url: 'https://api.test.com/v1',
  api_key_ref: 'env:TEST_API_KEY',
  display_name: 'Test Provider',
  models: [
    {
      id: 'test-model',
      context_window: 128000,
      max_output: 4096,
      supports_vision: false,
      supports_tools: true,
      cost_per_1k_input: 1.0,
      cost_per_1k_output: 2.0,
    },
  ],
};

const HUAWEI_CONFIG: ProviderConfig = {
  provider: 'huawei',
  base_url: 'https://api.modelarts-maas.com/plan/v2',
  api_key_ref: 'env:HUAWEI_MAAS_API_KEY',
  display_name: '华为云 MaaS',
  models: [
    {
      id: 'glm-5.1',
      context_window: 128000,
      max_output: 8192,
      supports_vision: false,
      supports_tools: true,
      cost_per_1k_input: 1.0,
      cost_per_1k_output: 2.0,
    },
  ],
};

describe('S3 Llm 模块', () => {
  afterEach(() => { resetRouter(); });

  // ===== providerBase =====
  describe('providerBase', () => {
    it('context_window 缺失时拒注', () => {
      const badConfig: ProviderConfig = {
        ...TEST_CONFIG,
        models: [{ id: 'bad-model', context_window: 0, max_output: 100, supports_vision: false, supports_tools: false, cost_per_1k_input: 0, cost_per_1k_output: 0 }],
      };
      expect(() => new OpenAIProvider(badConfig)).toThrow('context_window');
    });

    it('ProviderError 分类正确', () => {
      const authErr = new ProviderError('auth', '认证失败', 401);
      expect(authErr.retryable).toBe(false);
      expect(authErr.category).toBe('auth');

      const rateErr = new ProviderError('rate_limited', '速率限制', 429);
      expect(rateErr.retryable).toBe(true);

      const blockedErr = new ProviderError('content_blocked', '内容安全');
      expect(blockedErr.retryable).toBe(false);
    });
  });

  // ===== retryPolicy =====
  describe('retryPolicy', () => {
    it('auth 错误不重试', () => {
      const decision = getRetryDecision('auth');
      expect(decision.shouldRetry).toBe(false);
      expect(decision.maxRetries).toBe(0);
    });

    it('429 退避 5s 重试 1 次', () => {
      const decision = getRetryDecision('rate_limited');
      expect(decision.shouldRetry).toBe(true);
      expect(decision.maxRetries).toBe(1);
      expect(decision.backoffMs[0]).toBe(5000);
      expect(decision.fallbackToNext).toBe(true);
    });

    it('5xx 重试 2 次 1s/2s', () => {
      const decision = getRetryDecision('server_error');
      expect(decision.maxRetries).toBe(2);
      expect(decision.backoffMs).toEqual([1000, 2000]);
    });

    it('503 直接降级', () => {
      const decision = getRetryDecision('unavailable');
      expect(decision.fallbackToNext).toBe(true);
    });

    it('网络错误重试 2 次', () => {
      const decision = getRetryDecision('network');
      expect(decision.maxRetries).toBe(2);
    });

    it('classifyNetworkError 分类正确', () => {
      expect(classifyNetworkError(new Error('ECONNRESET'))).toBe('network');
      expect(classifyNetworkError(new Error('ETIMEDOUT'))).toBe('network');
      expect(classifyNetworkError(new Error('fetch failed'))).toBe('network');
      expect(classifyNetworkError(new Error('Aborted'))).toBe('timeout');
      expect(classifyNetworkError(new Error('something else'))).toBe('unknown');
    });
  });

  // ===== modelRouter =====
  describe('modelRouter', () => {
    it('注册 Provider 并解析模型', () => {
      const provider = new OpenAIProvider(TEST_CONFIG);
      const result = registerProvider(provider);
      expect(result.ok).toBe(true);

      const models = getRegisteredModels();
      expect(models).toContain('test-provider/test-model');
    });

    it('resolveModel 返回正确的 Provider + Spec', () => {
      const provider = new OpenAIProvider(TEST_CONFIG);
      registerProvider(provider);

      const resolved = resolveModel('test-provider/test-model');
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.spec.id).toBe('test-model');
        expect(resolved.value.spec.context_window).toBe(128000);
      }
    });

    it('resolveModel 未注册模型返回错误', () => {
      const resolved = resolveModel('nonexistent/model');
      expect(resolved.ok).toBe(false);
    });

    it('getFallbackProviders 按配置顺序', () => {
      const p1 = new OpenAIProvider({ ...TEST_CONFIG, provider: 'p1' });
      const p2 = new OpenAIProvider({ ...TEST_CONFIG, provider: 'p2' });
      registerProvider(p1);
      registerProvider(p2);

      setRoutingConfig({
        defaultModel: 'p1/test-model',
        directorModel: 'p1/test-model',
        workerModel: 'p1/test-model',
        verifierModel: 'p2/test-model',
        arbitrationModels: [],
        fallbackOrder: ['p1', 'p2'],
        timeoutMs: 60000,
        firstByteTimeoutMs: 10000,
        interChunkTimeoutMs: 15000,
      });

      const fallbacks = getFallbackProviders();
      expect(fallbacks.length).toBe(2);
      expect(fallbacks[0].name).toBe('p1');
      expect(fallbacks[1].name).toBe('p2');
    });
  });

  // ===== 真实连通性测试（Gate G3）=====
  describe('Gate G3 连通性', () => {
    it('华为云 GLM-5.1 非流式调用', async () => {
      // 跳过条件：环境变量未设置
      if (!process.env.HUAWEI_MAAS_API_KEY) {
        console.log('SKIP: HUAWEI_MAAS_API_KEY 未设置');
        return;
      }

      const provider = new OpenAIProvider(HUAWEI_CONFIG);
      registerProvider(provider);
      setRoutingConfig({
        defaultModel: 'huawei/glm-5.1',
        directorModel: 'huawei/glm-5.1',
        workerModel: 'huawei/glm-5.1',
        verifierModel: 'huawei/glm-5.1',
        arbitrationModels: ['huawei/glm-5.1'],
        fallbackOrder: ['huawei'],
        timeoutMs: 60000,
        firstByteTimeoutMs: 10000,
        interChunkTimeoutMs: 15000,
      });

      const result = await callModel('huawei/glm-5.1', [
        { role: 'user', content: '回复OK即可，不要其他内容' },
      ], { max_tokens: 20 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toContain('OK');
        expect(result.value.usage.total_tokens).toBeGreaterThan(0);
        expect(result.value.model).toBe('glm-5.1');
      }
    }, 30000);

    it('华为云 GLM-5.1 流式调用', async () => {
      if (!process.env.HUAWEI_MAAS_API_KEY) {
        console.log('SKIP: HUAWEI_MAAS_API_KEY 未设置');
        return;
      }

      const provider = new OpenAIProvider(HUAWEI_CONFIG);
      registerProvider(provider);

      const chunks: string[] = [];
      const result = await provider.chatStream(
        {
          model: 'glm-5.1',
          messages: [{ role: 'user', content: '回复OK即可' }],
          max_tokens: 20,
          stream: true,
        },
        (chunk: StreamChunk) => {
          if (chunk.delta) chunks.push(chunk.delta);
        },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toContain('OK');
        expect(chunks.length).toBeGreaterThan(0);
      }
    }, 30000);
  });

  // ===== streamParser =====
  describe('streamParser', () => {
    /** 构造模拟的 SSE ReadableStream */
    function makeSseStream(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      let idx = 0;
      return new ReadableStream({
        async pull(controller) {
          if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
          if (idx < chunks.length) {
            controller.enqueue(encoder.encode(chunks[idx]));
            idx++;
          } else {
            controller.close();
          }
        },
      });
    }

    it('解析标准 SSE 流', async () => {
      const sseLines = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" World"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const body = makeSseStream(sseLines);
      const collected: string[] = [];

      const result = await parseSseStream(body, (chunk) => {
        if (chunk.delta) collected.push(chunk.delta);
      }, { firstByteTimeoutMs: 5000, interChunkTimeoutMs: 5000 });

      expect(result.content).toBe('Hello World');
      expect(result.finish_reason).toBe('stop');
      expect(collected).toEqual(['Hello', ' World']);
    });

    it('解析带 reasoning_content 的流', async () => {
      const sseLines = [
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const body = makeSseStream(sseLines);
      const result = await parseSseStream(body, () => {}, { firstByteTimeoutMs: 5000, interChunkTimeoutMs: 5000 });

      expect(result.reasoning_content).toBe('thinking...');
      expect(result.content).toBe('answer');
    });

    it('首字节超时报错', async () => {
      // 构造一个延迟 200ms 才开始发送的流，超时设 50ms
      const sseLines = [
        'data: {"choices":[{"delta":{"content":"late"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const body = makeSseStream(sseLines, 200);

      await expect(
        parseSseStream(body, () => {}, { firstByteTimeoutMs: 50, interChunkTimeoutMs: 5000 }),
      ).rejects.toThrow(StreamTimeoutError);
    });

    it('外部 AbortSignal 中止流', async () => {
      const sseLines = [
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const body = makeSseStream(sseLines, 100);
      const controller = new AbortController();

      // 立即中止
      controller.abort();

      await expect(
        parseSseStream(body, () => {}, { firstByteTimeoutMs: 5000, interChunkTimeoutMs: 5000, signal: controller.signal }),
      ).rejects.toThrow();
    });

    it('解析 usage 字段', async () => {
      const sseLines = [
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
        'data: [DONE]\n\n',
      ];
      const body = makeSseStream(sseLines);
      const result = await parseSseStream(body, () => {}, { firstByteTimeoutMs: 5000, interChunkTimeoutMs: 5000 });

      expect(result.usage.total_tokens).toBe(15);
    });
  });

  // ===== abortSignal =====
  describe('abortSignal', () => {
    it('createManagedAbortController 带来源', () => {
      const ctrl = createManagedAbortController('pause');
      expect(ctrl.source).toBe('pause');
      expect(ctrl.signal.aborted).toBe(false);
      ctrl.abort();
      expect(ctrl.signal.aborted).toBe(true);
    });

    it('mergeAbortSignals 任一中止则组合中止', () => {
      const c1 = new AbortController();
      const c2 = new AbortController();
      const merged = mergeAbortSignals(c1.signal, c2.signal);

      expect(merged.signal.aborted).toBe(false);
      c2.abort();
      expect(merged.signal.aborted).toBe(true);
    });

    it('mergeAbortSignals 已中止的 signal 立即生效', () => {
      const c1 = new AbortController();
      c1.abort();
      const merged = mergeAbortSignals(c1.signal);
      expect(merged.signal.aborted).toBe(true);
    });

    it('createTimeoutAbortController 超时后中止', async () => {
      const { controller, clearTimer } = createTimeoutAbortController(50);
      expect(controller.signal.aborted).toBe(false);
      await new Promise(r => setTimeout(r, 100));
      expect(controller.signal.aborted).toBe(true);
      clearTimer();
    });

    it('createTimeoutAbortController clearTimer 阻止中止', async () => {
      const { controller, clearTimer } = createTimeoutAbortController(50);
      clearTimer();
      await new Promise(r => setTimeout(r, 100));
      expect(controller.signal.aborted).toBe(false);
    });

    it('isAborted 工具函数', () => {
      expect(isAborted()).toBe(false);
      const ctrl = new AbortController();
      expect(isAborted(ctrl.signal)).toBe(false);
      ctrl.abort();
      expect(isAborted(ctrl.signal)).toBe(true);
    });

    it('getAbortSource 识别来源', () => {
      expect(getAbortSource()).toBeUndefined();
      const ctrl = new AbortController();
      ctrl.abort(new Error('Timeout occurred'));
      expect(getAbortSource(ctrl.signal)).toBe('timeout');

      const ctrl2 = new AbortController();
      ctrl2.abort('pause signal');
      expect(getAbortSource(ctrl2.signal)).toBe('pause');

      const ctrl3 = new AbortController();
      ctrl3.abort();
      expect(getAbortSource(ctrl3.signal)).toBe('user');
    });
  });

  // ===== slmCaller =====
  describe('slmCaller', () => {
    it('未注册模型返回错误', async () => {
      const result = await callSlm({
        model: 'nonexistent/model',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect(result.ok).toBe(false);
    });

    it('SLM 真实调用（华为云 GLM-5.1）', async () => {
      if (!process.env.HUAWEI_MAAS_API_KEY) {
        console.log('SKIP: HUAWEI_MAAS_API_KEY 未设置');
        return;
      }

      const provider = new OpenAIProvider(HUAWEI_CONFIG);
      registerProvider(provider);

      const result = await callSlm({
        model: 'huawei/glm-5.1',
        messages: [{ role: 'user', content: '回复OK即可' }],
        max_tokens: 20,
        timeoutMs: 30000,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toContain('OK');
        expect(result.value.usage.total_tokens).toBeGreaterThan(0);
      }
    }, 30000);
  });
});
