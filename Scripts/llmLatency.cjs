// 诊断：实测华为云 MaaS 各模型流式首响延迟
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ['GLM-5.1', 'GLM-5', 'DeepSeek-V4-Flash'];
const KEY = process.env.HUAWEI_MAAS_API_KEY;
const URL = 'https://api.modelarts-maas.com/plan/v2/chat/completions';

async function testModel(model) {
  const t0 = Date.now();
  let firstContent = null, firstAny = null, total = null, chunks = 0;
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: '只回复两个字：你好' }],
    }),
  });
  if (!res.ok) { console.log(`${model}: HTTP ${res.status} ${await res.text()}`); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ') || t === 'data: [DONE]') continue;
      try {
        const j = JSON.parse(t.slice(6));
        const d = j.choices?.[0]?.delta;
        if (d) {
          chunks++;
          if (!firstAny) firstAny = (Date.now() - t0) / 1000;
          if (d.content && !firstContent) firstContent = (Date.now() - t0) / 1000;
        }
        if (j.choices?.[0]?.finish_reason && total === null) total = (Date.now() - t0) / 1000;
      } catch { /* skip */ }
    }
  }
  console.log(`${model}: firstChunk(any)=${firstAny?.toFixed(2) ?? '-'}s firstContent=${firstContent?.toFixed(2) ?? '-'}s total=${total?.toFixed(2) ?? '-'}s chunks=${chunks}`);
}

(async () => {
  for (const m of MODELS) await testModel(m);
})();
