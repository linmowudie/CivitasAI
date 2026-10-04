// E2E（最终）：点「⚖治理」tab → 校验留痕面板（含后端回填）
import WebSocket from 'ws';
import fs from 'node:fs';

const list = await (await fetch('http://127.0.0.1:9444/json/list')).json();
const page = list.find((t) => t.type === 'page' && String(t.url).includes('5173'));
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 1 << 28 });
let id = 0; const pending = new Map();
ws.on('message', (r) => { const m = JSON.parse(r.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.on('open', r));
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 确保面板展开
await ev(`(() => { const b = document.querySelector('button[title="展开右侧面板"]'); if (b) b.click(); return 1; })()`);
await sleep(1200);

// 点「⚖治理」
console.log('点治理 tab:', await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '⚖治理' || (x.textContent||'').includes('治理'));
  if (!b) return 'NO_TAB';
  b.click();
  return 'clicked';
})()`));
await sleep(2500);

const panel = await ev(`(() => {
  const t = document.body.innerText;
  return JSON.stringify({
    hasCount: /共 \\d+ 条/.test(t),
    hasDeniedStat: /拒绝 \\d+/.test(t),
    hasActionLabel: /裁决审批/.test(t),
    hasFilters: /全部/.test(t) && /放行/.test(t),
    hasAuditorOrRole: /auditor|worker|regulatory_authority|user/.test(t),
    hasReason: /身份|校验|Agent/.test(t),
  });
})()`);
console.log('面板内容:', panel);

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('.verify/governance-panel.png', Buffer.from(shot.result.data, 'base64'));
console.log('截图: .verify/governance-panel.png');
ws.close(); process.exit(0);
