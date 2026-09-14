/**
 * 联调诊断脚本：模拟前端 WS 行为，测量 generate_reply 全链路时序。
 * 用法: node Scripts/wsDiagnose.js <sessionId>
 */
const WebSocket = require('ws');

const sessionId = process.argv[2] || 'sess-24c779f3';
const t0 = Date.now();
const log = (tag, extra) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(2)}s] ${tag}${extra ? ' ' + extra : ''}`);

const ws = new WebSocket('ws://localhost:3001');
let chunks = 0, firstChunkAt = null, firstReasoningAt = null, firstContentAt = null, ended = false;

ws.on('open', async () => {
  log('WS open');
  // 模拟前端完整行为：先 REST 落库用户消息
  await fetch(`http://localhost:3000/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'user', content: '联调诊断：请只回复"OK"两个字母' }),
  });
  log('user message persisted via REST');
  // 按后端契约格式发送（payload 包裹）
  ws.send(JSON.stringify({
    type: 'generate_reply',
    payload: {
      sessionId,
      userMessage: '联调诊断：请只回复"OK"两个字母',
      messageId: 'msg-diag-' + Date.now(),
    },
  }));
  log('generate_reply sent (payload format)');
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'agent:stream_chunk') {
    chunks++;
    const d = msg.data ?? {};
    if (d.reasoning && !firstReasoningAt) { firstReasoningAt = (Date.now() - t0) / 1000; log(`FIRST REASONING at ${firstReasoningAt.toFixed(2)}s`); }
    if (d.chunk && !firstContentAt) { firstContentAt = (Date.now() - t0) / 1000; log(`FIRST CONTENT at ${firstContentAt.toFixed(2)}s`); }
    if (!firstChunkAt) { firstChunkAt = (Date.now() - t0) / 1000; }
  } else if (msg.type === 'agent:stream_end') {
    log(`stream_end chunks=${chunks} firstReasoning=${firstReasoningAt?.toFixed(2)}s firstContent=${firstContentAt?.toFixed(2)}s`, JSON.stringify(msg.data).slice(0, 200));
    ended = true;
    ws.close();
  } else if (msg.type === 'error' || msg.type === 'generation_started') {
    log(msg.type, JSON.stringify(msg.data ?? msg).slice(0, 300));
  } else if (msg.type !== 'pong') {
    log(msg.type, JSON.stringify(msg.data ?? '').slice(0, 120));
  }
});

ws.on('error', (e) => { log('WS error: ' + e.message); process.exit(1); });

setTimeout(() => {
  if (!ended) log(`TIMEOUT chunks=${chunks} firstChunkAt=${firstChunkAt}`);
  process.exit(0);
}, 90000);
