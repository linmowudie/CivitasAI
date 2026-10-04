/**
 * 逐模型可用性探测：用套餐下真实调用，定位哪些模型被授权。
 * 运行：npx tsx .verify/be-model-probe.ts
 */
import { loadConfig, getConfigValueOr } from '../Src/Infra/Config/configLoader.js';
import { OpenAIProvider, registerProvider, resolveModel } from '../Src/Infra/Llm/index.js';

const configResult = loadConfig();
if (!configResult.ok) { console.log('loadConfig failed', configResult.error); process.exit(1); }
const config = configResult.value;

const providersRaw = getConfigValueOr<Record<string, unknown>[]>(config, 'providers', []);
const modelIds: string[] = [];
for (const pConfig of providersRaw) {
  const pc = pConfig as Record<string, unknown>;
  registerProvider(new OpenAIProvider({
    provider: pc['provider'] as string,
    base_url: pc['base_url'] as string,
    api_key_ref: pc['api_key_ref'] as string,
    display_name: pc['display_name'] as string,
    models: (pc['models'] ?? []) as never[],
  }));
  const providerName = String(pc['provider']);
  for (const m of (pc['models'] ?? []) as Array<{ id: string }>) {
    modelIds.push(`${providerName}/${m.id}`);
  }
}

const results: Array<Record<string, unknown>> = [];
for (const qualified of modelIds) {
  const resolved = resolveModel(qualified as never);
  if (!resolved.ok) { results.push({ model: qualified, ok: false, stage: 'resolve', error: String(resolved.error) }); continue; }
  const provider = (resolved.value as { provider: { chatStream: (o: unknown, cb: (c: unknown) => void) => Promise<{ ok: boolean; value?: { content: string }; error?: string; severity?: string }> } }).provider;
  // 与应用主链路一致：使用裸模型 id（Src/Core/Model/modelCaller.ts → model: spec.id）
  const bareId = (resolved.value as { spec: { id: string } }).spec.id;
  const chunks: string[] = [];
  const t0 = Date.now();
  let out: { ok: boolean; value?: { content: string }; error?: string; severity?: string };
  try {
    out = await provider.chatStream(
      { model: bareId, messages: [{ role: 'user', content: '回答一个字：好' }], max_tokens: 16, stream: true },
      (c: { delta?: string }) => { if (c?.delta) chunks.push(c.delta); },
    );
  } catch (e) {
    out = { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
  results.push({
    model: qualified,
    sentModel: bareId,
    ok: out.ok,
    elapsedMs: Date.now() - t0,
    content: out.value?.content ?? chunks.join(''),
    error: out.error ? String(out.error).slice(0, 220) : undefined,
    severity: out.severity,
  });
}

console.log(JSON.stringify({ results }, null, 2));
process.exit(0);
