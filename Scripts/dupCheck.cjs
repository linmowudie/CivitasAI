// 诊断：检测后端是否对同一 chunk 双重推送
const WebSocket = require('ws');
const sid = process.argv[2] || 'sess-24c779f3';
const ws = new WebSocket('ws://localhost:3001');
const seq = [];
ws.on('open', async () => {
  await fetch(`http://localhost:3000/api/sessions/${sid}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'user', content: '只回复：AB' }),
  });
  ws.send(JSON.stringify({ type: 'generate_reply', payload: { sessionId: sid, userMessage: '只回复：AB', messageId: 'msg-dup-' + Date.now() } }));
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'agent:stream_chunk') {
    seq.push({ c: m.data.chunk ?? '', r: (m.data.reasoning ?? '').length });
  } else if (m.type === 'agent:stream_end') {
    const content = seq.map(x => x.c).join('');
    console.log('chunk事件数:', seq.length);
    console.log('前端拼接content:', JSON.stringify(content));
    console.log('前10事件:', JSON.stringify(seq.slice(0, 10)));
    ws.close(); process.exit(0);
  }
});
setTimeout(() => { console.log('TIMEOUT seq=', seq.length); process.exit(0); }, 30000);
