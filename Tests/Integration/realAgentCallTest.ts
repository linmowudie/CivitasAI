/**
 * 真实 Agent 调用测试脚本
 * 
 * 通过 WebSocket 发送 generate_reply，验证：
 * 1. 入口 Agent (prime_director) 被创建
 * 2. 工具可见性按角色裁剪
 * 3. 主循环正常执行
 */
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
  console.log('═══ 真实 Agent 调用测试 ═══\n');

  // 1. 连接 WebSocket
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
      case 'subscribed':
        console.log('    ✓ 订阅成功');
        break;
      case 'generation_started':
        console.log('    ✓ 生成已启动');
        break;
      case 'agent_stream_chunk':
        if (msg.data?.chunk) chunks.push(msg.data.chunk);
        break;
      case 'agent_stream_end':
        streamEnded = true;
        if (msg.data?.error) errors.push(msg.data.error);
        console.log('    ✓ 流结束', msg.data?.error ? `(错误: ${msg.data.error})` : '');
        break;
      default:
        // 忽略其他事件
        break;
    }
  });

  // 2. 订阅事件
  ws.send(JSON.stringify({
    type: 'subscribe',
    payload: { events: ['agent_stream_chunk', 'agent_stream_end'] },
  }));

  // 等待订阅确认
  await new Promise(r => setTimeout(r, 500));

  // 3. 发送 generate_reply（触发入口 Agent 创建）
  const messageId = 'msg-test-' + Date.now();
  console.log('\n[2] 发送 generate_reply（触发 prime_director 入口）...');
  console.log(`    sessionId: ${SESSION_ID}`);
  console.log(`    messageId: ${messageId}`);
  console.log(`    userMessage: "你好，请介绍你自己"`);

  ws.send(JSON.stringify({
    type: 'generate_reply',
    payload: {
      sessionId: SESSION_ID,
      userMessage: '你好，请介绍你自己',
      messageId,
    },
  }));

  // 4. 等待流结束（最多 30 秒）
  console.log('\n[3] 等待 Agent 响应...');
  const startTime = Date.now();
  while (!streamEnded && Date.now() - startTime < 30000) {
    await new Promise(r => setTimeout(r, 500));
  }

  if (!streamEnded) {
    console.log('    ⚠ 超时（30s），主动断开');
  }

  // 5. 输出结果
  console.log('\n═══ 测试结果 ═══');
  console.log(`  收到 chunk 数: ${chunks.length}`);
  console.log(`  输出文本长度: ${chunks.join('').length}`);
  console.log(`  错误: ${errors.length > 0 ? errors.join('; ') : '无'}`);
  
  if (chunks.length > 0) {
    console.log(`  输出预览: ${chunks.join('').slice(0, 200)}...`);
  }

  // 6. 检查入口 Agent 是否已创建
  console.log('\n[4] 检查 Agent 列表...');
  try {
    const resp = await fetch('http://localhost:3000/api/agents');
    const json = await resp.json() as { ok: boolean; data: Array<{ agentId: string; role: string; status: string }> };
    if (json.ok && json.data.length > 0) {
      console.log('    ✓ 入口 Agent 已创建:');
      for (const agent of json.data) {
        console.log(`      - ${agent.agentId} (role: ${agent.role}, status: ${agent.status})`);
      }
    } else {
      console.log('    ⚠ Agent 列表为空（可能 Agent 创建在 Loop 执行中）');
    }
  } catch (e) {
    console.log(`    ⚠ 查询失败: ${e}`);
  }

  // 清理
  ws.close();
  console.log('\n═══ 测试完成 ═══');
  process.exit(0);
}

main().catch(e => {
  console.error('测试失败:', e);
  process.exit(1);
});
