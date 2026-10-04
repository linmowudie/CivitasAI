/**
 * 真实 Agent 调用测试脚本
 * 
 * Phase 0 更新：WebSocket 已替换为 IPC 桥接。
 * 本脚本需通过 Electron 环境运行（IPC 通信）。
 * 
 * 验证：
 * 1. 入口 Agent (prime_director) 被创建
 * 2. 工具可见性按角色裁剪
 * 3. 主循环正常执行
 * 
 * TODO: 重写为 Electron 测试脚本（通过 ipcRenderer 通信）
 */

console.log('═══ 真实 Agent 调用测试 ═══');
console.log('');
console.log('⚠ 本测试脚本需要重写：');
console.log('  WebSocket 已替换为 Electron IPC 桥接（Phase 0 架构简化）。');
console.log('  请在 Electron 环境中通过 ipcRenderer 进行通信测试。');
console.log('');
console.log('替代方案：');
console.log('  1. 通过 Electron 应用界面直接发送消息测试');
console.log('  2. 使用 vitest 运行 Tests/Interface/ipcBridge.spec.ts');
console.log('');

// 以下为旧版 WebSocket 代码，保留供重写参考
/*
import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3001';
const SESSION_ID = 'test-session-' + Date.now();

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', (e) => reject(e));
  });
}

async function main() {
  console.log('[1] 连接 WebSocket...');
  const ws = await connect();
  console.log('    ✓ 已连接', WS_URL);

  // 收集事件
  const chunks: string[] = [];
  const errors: string[] = [];
  let streamEnded = false;

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    switch (msg.type) {
      case 'generation_started':
        console.log('    ✓ 生成已启动');
        break;
      case 'agent_stream_chunk':
        if (msg.data?.chunk) chunks.push(msg.data.chunk);
        break;
      case 'agent_stream_end':
        streamEnded = true;
        break;
    }
  });

  // 发送 generate_reply
  const messageId = 'msg-test-' + Date.now();
  ws.send(JSON.stringify({
    type: 'generate_reply',
    payload: {
      sessionId: SESSION_ID,
      userMessage: '你好，请介绍你自己',
      messageId,
    },
  }));

  // 等待流结束
  console.log('[3] 等待 Agent 响应...');
  const startTime = Date.now();
  while (!streamEnded && Date.now() - startTime < 30000) {
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`  收到 chunk 数: ${chunks.length}`);
  console.log(`  输出文本长度: ${chunks.join('').length}`);

  ws.close();
  process.exit(0);
}

main().catch(e => {
  console.error('测试失败:', e);
  process.exit(1);
});
*/

process.exit(0);
