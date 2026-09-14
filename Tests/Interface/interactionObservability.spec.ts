/**
 * S13 交互与可观测测试——Gate G13 验证
 *
 * 覆盖：
 * - Router（路由匹配 + 查询解析）
 * - TaskApi（任务 CRUD）
 * - AgentApi（Agent 查询）
 * - TokenApi（Token 总览 + 钱包）
 * - ApprovalApi（审批队列）
 * - LoopApi（事件日志 + 大屏概览）
 * - WsServer（WebSocket 客户端管理 + 推送）
 * - WsHandler（消息处理）
 * - WebServer（请求处理 + 日志）
 * - DedupMiddleware（5 道防风暴）
 * - Gate G13 综合验证
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── Router ──────────────────────────────────────────
import {
  registerRoute, matchRoute, parseQuery, clearRoutes,
  json, apiError,
} from '../../Src/Interface/RestApi/router.js';

// ── TaskApi ─────────────────────────────────────────
import {
  submitTask, listTasks, getTask, registerTaskRoutes, resetTaskApi,
} from '../../Src/Interface/RestApi/taskApi.js';

// ── AgentApi ────────────────────────────────────────
import {
  listAgents, getAgentDetail, registerAgentRoutes,
} from '../../Src/Interface/RestApi/agentApi.js';

// ── TokenApi ────────────────────────────────────────
import {
  getTokenOverview, listWallets, registerTokenRoutes,
} from '../../Src/Interface/RestApi/tokenApi.js';

// ── ApprovalApi ─────────────────────────────────────
import {
  listPendingApprovals, registerApprovalRoutes,
} from '../../Src/Interface/RestApi/approvalApi.js';

// ── LoopApi ─────────────────────────────────────────
import {
  getEvents, getDashboardOverview, listArbitrationCases, registerLoopRoutes,
} from '../../Src/Interface/RestApi/loopApi.js';

// ── WsServer ────────────────────────────────────────
import {
  initWsServer, connectClient, disconnectClient, pushToClient,
  broadcastToAll, consumeMessages, getConnectedClients, getClientCount,
  resetWsServer,
} from '../../Src/Interface/WebSocket/wsServer.js';

// ── WsHandler ───────────────────────────────────────
import {
  handleClientMessage,
} from '../../Src/Interface/WebSocket/wsHandler.js';

// ── WebServer ───────────────────────────────────────
import {
  handleRequest, getRequestLogs, getRequestCount, resetWebServer,
} from '../../Src/Interface/WebServer/webServer.js';

// ── Routes ──────────────────────────────────────────
import { registerAllRoutes } from '../../Src/Interface/WebServer/routes.js';

// ── DedupMiddleware ─────────────────────────────────
import {
  initDedupMiddleware, computeDedupKey, checkDedup, checkCooldown,
  checkIdempotency, storeIdempotency, acquireConcurrencySlot,
  releaseConcurrencySlot, checkCircuitBreaker, dedupCheck,
  getDedupStats, resetDedupMiddleware,
} from '../../Src/Interface/InputDeduplication/dedupMiddleware.js';

// ── EventBus ────────────────────────────────────────
import { resetEventBus, getEventLog } from '../../Src/Services/EventBus/eventBus.js';
import { createEvent, publish } from '../../Src/Services/EventBus/eventBus.js';
import { EventType } from '../../Src/Services/EventBus/eventTypes.js';

// ═══════════════════════════════════════════════════════
// 1. Router 路由匹配
// ═══════════════════════════════════════════════════════

describe('Router 路由匹配', () => {
  beforeEach(() => {
    clearRoutes();
  });

  it('注册 + 匹配静态路由', () => {
    registerRoute('GET', '/api/test', async () => json({ msg: 'ok' }));
    const match = matchRoute('GET', '/api/test');
    expect(match).not.toBeNull();
  });

  it('注册 + 匹配动态路由（路径参数）', () => {
    registerRoute('GET', '/api/items/:itemId', async () => json({}));
    const match = matchRoute('GET', '/api/items/abc-123');
    expect(match).not.toBeNull();
    expect(match!.params.itemId).toBe('abc-123');
  });

  it('不匹配返回 null', () => {
    const match = matchRoute('GET', '/api/nonexistent');
    expect(match).toBeNull();
  });

  it('方法不匹配返回 null', () => {
    registerRoute('POST', '/api/test', async () => json({}));
    const match = matchRoute('GET', '/api/test');
    expect(match).toBeNull();
  });

  it('解析查询字符串', () => {
    const q = parseQuery('?status=running&limit=10');
    expect(q.status).toBe('running');
    expect(q.limit).toBe('10');
  });

  it('空查询字符串返回空对象', () => {
    expect(parseQuery('')).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════
// 2. TaskApi 任务接口
// ═══════════════════════════════════════════════════════

describe('TaskApi 任务接口', () => {
  beforeEach(() => {
    resetTaskApi();
  });

  it('提交任务 → 返回任务记录', () => {
    const task = submitTask({ description: '测试任务' });
    expect(task.taskId).toBeDefined();
    expect(task.status).toBe('submitted');
    expect(task.description).toBe('测试任务');
  });

  it('查询任务列表', () => {
    submitTask({ description: '任务 1' });
    submitTask({ description: '任务 2' });
    const tasks = listTasks();
    expect(tasks.length).toBe(2);
  });

  it('按状态筛选', () => {
    submitTask({ description: '任务 1' });
    const filtered = listTasks({ status: 'completed' });
    expect(filtered.length).toBe(0);
  });

  it('查询任务详情', () => {
    const task = submitTask({ description: '详情测试' });
    const detail = getTask(task.taskId);
    expect(detail).toBeDefined();
    expect(detail!.description).toBe('详情测试');
  });

  it('查询不存在的任务 → undefined', () => {
    expect(getTask('nonexistent')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// 3. AgentApi Agent 查询
// ═══════════════════════════════════════════════════════

describe('AgentApi Agent 查询', () => {
  it('查询 Agent 列表（空注册表）', () => {
    const agents = listAgents();
    expect(Array.isArray(agents)).toBe(true);
  });

  it('查询不存在的 Agent → undefined', () => {
    expect(getAgentDetail('nonexistent')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// 4. TokenApi Token 总览
// ═══════════════════════════════════════════════════════

describe('TokenApi Token 总览', () => {
  it('获取 Token 总览', () => {
    const overview = getTokenOverview();
    expect(overview).toHaveProperty('systemPool');
    expect(overview).toHaveProperty('currentTaxRate');
    expect(overview).toHaveProperty('walletCount');
  });

  it('查询钱包列表', () => {
    const wallets = listWallets();
    expect(Array.isArray(wallets)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 5. ApprovalApi 审批队列
// ═══════════════════════════════════════════════════════

describe('ApprovalApi 审批队列', () => {
  it('查询待审批列表（空）', () => {
    const approvals = listPendingApprovals();
    expect(Array.isArray(approvals)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 6. LoopApi 事件与大屏
// ═══════════════════════════════════════════════════════

describe('LoopApi 事件与大屏', () => {
  beforeEach(() => {
    resetEventBus();
  });

  it('查询事件日志', () => {
    publish(createEvent({
      eventType: EventType.TASK_RECEIVED,
      source: 'test',
    }));
    const events = getEvents();
    expect(events.length).toBeGreaterThan(0);
  });

  it('按事件类型过滤', () => {
    publish(createEvent({
      eventType: EventType.TASK_RECEIVED,
      source: 'test',
    }));
    publish(createEvent({
      eventType: EventType.TASK_COMPLETED,
      source: 'test',
    }));
    const filtered = getEvents({ eventType: EventType.TASK_RECEIVED });
    expect(filtered.length).toBe(1);
  });

  it('大屏概览数据完整', () => {
    const dashboard = getDashboardOverview();
    expect(dashboard).toHaveProperty('activeAgents');
    expect(dashboard).toHaveProperty('totalAgents');
    expect(dashboard).toHaveProperty('activeArbitrationCases');
    expect(dashboard).toHaveProperty('arbitratorPool');
  });

  it('仲裁案件列表', () => {
    const cases = listArbitrationCases();
    expect(Array.isArray(cases)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// 7. WsServer WebSocket 服务端
// ═══════════════════════════════════════════════════════

describe('WsServer WebSocket 服务端', () => {
  beforeEach(() => {
    resetWsServer();
    resetEventBus();
    initWsServer({ maxBufferSize: 10 });
  });

  it('连接客户端', () => {
    const client = connectClient();
    expect(client.clientId).toBeDefined();
    expect(getClientCount()).toBe(1);
  });

  it('断开客户端', () => {
    const client = connectClient();
    const result = disconnectClient(client.clientId);
    expect(result.ok).toBe(true);
    expect(getClientCount()).toBe(0);
  });

  it('推送消息 + 消费', () => {
    const client = connectClient();
    pushToClient(client.clientId, {
      type: 'test',
      data: { msg: 'hello' },
      timestamp: Date.now(),
    });

    const messages = consumeMessages(client.clientId);
    expect(messages.length).toBe(1);
    expect((messages[0].data as any).msg).toBe('hello');

    // 消费后队列为空
    expect(consumeMessages(client.clientId).length).toBe(0);
  });

  it('广播到所有客户端', () => {
    const c1 = connectClient();
    const c2 = connectClient();

    broadcastToAll({
      type: 'broadcast',
      data: { msg: 'all' },
      timestamp: Date.now(),
    });

    expect(consumeMessages(c1.clientId).length).toBe(1);
    expect(consumeMessages(c2.clientId).length).toBe(1);
  });

  it('缓冲区超限丢弃最旧', () => {
    initWsServer({ maxBufferSize: 3 });
    const client = connectClient();

    for (let i = 0; i < 5; i++) {
      pushToClient(client.clientId, {
        type: 'msg', data: { i }, timestamp: Date.now(),
      });
    }

    const messages = consumeMessages(client.clientId);
    expect(messages.length).toBe(3); // 只保留最后 3 条
    expect((messages[0].data as any).i).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════
// 8. WsHandler 消息处理
// ═══════════════════════════════════════════════════════

describe('WsHandler 消息处理', () => {
  beforeEach(() => {
    resetWsServer();
    resetEventBus();
  });

  it('ping → pong', () => {
    const client = connectClient();
    const result = handleClientMessage(client.clientId, { type: 'ping' });
    expect(result.ok).toBe(true);

    const messages = consumeMessages(client.clientId);
    expect(messages.some(m => m.type === 'pong')).toBe(true);
  });

  it('get_dashboard → dashboard 数据', () => {
    const client = connectClient();
    handleClientMessage(client.clientId, { type: 'get_dashboard' });

    const messages = consumeMessages(client.clientId);
    const dashboard = messages.find(m => m.type === 'dashboard');
    expect(dashboard).toBeDefined();
  });

  it('未知消息类型 → 错误', () => {
    const client = connectClient();
    const result = handleClientMessage(client.clientId, { type: 'unknown' as any });
    expect(result.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 9. WebServer 请求处理
// ═══════════════════════════════════════════════════════

describe('WebServer 请求处理', () => {
  beforeEach(() => {
    resetWebServer();
    resetTaskApi();
    clearRoutes();
    registerAllRoutes();
  });

  it('GET /api/tasks → 200 + 空列表', async () => {
    const resp = await handleRequest({ method: 'GET', url: '/api/tasks' });
    expect(resp.status).toBe(200);
    expect((resp.body as any).ok).toBe(true);
    expect((resp.body as any).data).toEqual([]);
  });

  it('POST /api/tasks → 201 + 创建任务', async () => {
    const resp = await handleRequest({
      method: 'POST',
      url: '/api/tasks',
      body: { description: '新任务' },
    });
    expect(resp.status).toBe(201);
    expect((resp.body as any).data.description).toBe('新任务');
  });

  it('GET /api/tasks/:taskId → 任务详情', async () => {
    const task = submitTask({ description: '详情' });
    const resp = await handleRequest({
      method: 'GET',
      url: `/api/tasks/${task.taskId}`,
    });
    expect(resp.status).toBe(200);
    expect((resp.body as any).data.description).toBe('详情');
  });

  it('GET /api/tasks/:taskId → 404', async () => {
    const resp = await handleRequest({
      method: 'GET',
      url: '/api/tasks/nonexistent',
    });
    expect(resp.status).toBe(404);
  });

  it('GET /api/nonexistent → 404', async () => {
    const resp = await handleRequest({
      method: 'GET',
      url: '/api/nonexistent',
    });
    expect(resp.status).toBe(404);
  });

  it('GET /api/loops/dashboard → 大屏数据', async () => {
    const resp = await handleRequest({
      method: 'GET',
      url: '/api/loops/dashboard',
    });
    expect(resp.status).toBe(200);
    expect((resp.body as any).data).toHaveProperty('activeAgents');
  });

  it('GET /api/tokens/overview → Token 总览', async () => {
    const resp = await handleRequest({
      method: 'GET',
      url: '/api/tokens/overview',
    });
    expect(resp.status).toBe(200);
    expect((resp.body as any).data).toHaveProperty('systemPool');
  });

  it('请求日志记录', async () => {
    await handleRequest({ method: 'GET', url: '/api/tasks' });
    await handleRequest({ method: 'GET', url: '/api/agents' });
    expect(getRequestCount()).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════
// 10. DedupMiddleware 去重中间件
// ═══════════════════════════════════════════════════════

describe('DedupMiddleware 去重中间件', () => {
  beforeEach(() => {
    resetDedupMiddleware();
    initDedupMiddleware({
      dedupTtlMs: 5000,
      cooldownMs: 1000,
      maxConcurrent: 5,
      maxPerUser: 2,
      circuitBreakerThreshold: 10,
      circuitBreakerCooldownMs: 5000,
    });
  });

  it('去重键计算', () => {
    const key = computeDedupKey('agent-1', 'submit_task', 'task-1');
    expect(key).toBe('agent-1:submit_task:task-1');
  });

  it('去重：相同键 5s 内重复', () => {
    const r1 = checkDedup('key-1');
    expect(r1.duplicate).toBe(false);

    const r2 = checkDedup('key-1');
    expect(r2.duplicate).toBe(true);
  });

  it('冷却期：同 Agent 1s 内阻塞', () => {
    const r1 = checkCooldown('agent-1');
    expect(r1.blocked).toBe(false);

    const r2 = checkCooldown('agent-1');
    expect(r2.blocked).toBe(true);
    expect(r2.remainingMs).toBeGreaterThan(0);
  });

  it('幂等 ID：相同 ID 返回缓存', () => {
    const r1 = checkIdempotency('idem-1');
    expect(r1.alreadyProcessed).toBe(false);

    storeIdempotency('idem-1', { result: 'done' });

    const r2 = checkIdempotency('idem-1');
    expect(r2.alreadyProcessed).toBe(true);
    expect(r2.cachedResult).toEqual({ result: 'done' });
  });

  it('并发控制：超限拒绝', () => {
    const r1 = acquireConcurrencySlot('user-1');
    expect(r1.ok).toBe(true);
    const r2 = acquireConcurrencySlot('user-1');
    expect(r2.ok).toBe(true);
    const r3 = acquireConcurrencySlot('user-1');
    expect(r3.ok).toBe(false); // 超过 maxPerUser=2
  });

  it('释放并发槽位', () => {
    acquireConcurrencySlot('user-1');
    acquireConcurrencySlot('user-1');
    releaseConcurrencySlot('user-1');

    const r = acquireConcurrencySlot('user-1');
    expect(r.ok).toBe(true);
  });

  it('熔断器：超阈值触发', () => {
    for (let i = 0; i < 10; i++) {
      checkCircuitBreaker();
    }
    const result = checkCircuitBreaker();
    expect(result.open).toBe(true);
  });

  it('完整 dedupCheck 流程', () => {
    const r = dedupCheck({
      source: 'agent-1',
      intent: 'submit',
      target: 'task-1',
      agentId: 'agent-1',
    });
    expect(r.ok).toBe(true);
  });

  it('dedupCheck 重复请求 → 错误', () => {
    dedupCheck({
      source: 'agent-1', intent: 'submit', target: 'task-1', agentId: 'agent-1',
    });
    const r = dedupCheck({
      source: 'agent-1', intent: 'submit', target: 'task-1', agentId: 'agent-1',
    });
    expect(r.ok).toBe(false);
  });

  it('统计信息', () => {
    const stats = getDedupStats();
    expect(stats).toHaveProperty('dedupKeysCount');
    expect(stats).toHaveProperty('circuitOpen');
    expect(stats).toHaveProperty('globalConcurrent');
  });
});

// ═══════════════════════════════════════════════════════
// Gate G13 综合验证
// ═══════════════════════════════════════════════════════

describe('Gate G13 综合验证', () => {
  beforeEach(() => {
    resetTaskApi();
    resetWsServer();
    resetWebServer();
    resetDedupMiddleware();
    resetEventBus();
    clearRoutes();
    registerAllRoutes();
    initWsServer();
    initDedupMiddleware({ cooldownMs: 0 });
  });

  it('G13-1: 前端全部操作走同一套服务接口', async () => {
    // 任务提交
    const taskResp = await handleRequest({
      method: 'POST', url: '/api/tasks',
      body: { description: '端到端任务' },
    });
    expect(taskResp.status).toBe(201);
    const taskId = (taskResp.body as any).data.taskId;

    // 任务查询
    const getResp = await handleRequest({
      method: 'GET', url: `/api/tasks/${taskId}`,
    });
    expect(getResp.status).toBe(200);
    expect((getResp.body as any).data.description).toBe('端到端任务');

    // Agent 列表
    const agentResp = await handleRequest({ method: 'GET', url: '/api/agents' });
    expect(agentResp.status).toBe(200);

    // Token 总览
    const tokenResp = await handleRequest({ method: 'GET', url: '/api/tokens/overview' });
    expect(tokenResp.status).toBe(200);

    // 审批队列
    const approvalResp = await handleRequest({ method: 'GET', url: '/api/approvals' });
    expect(approvalResp.status).toBe(200);

    // 大屏概览
    const dashResp = await handleRequest({ method: 'GET', url: '/api/loops/dashboard' });
    expect(dashResp.status).toBe(200);
  });

  it('G13-2: WebSocket 客户端接收实时推送', () => {
    const client = connectClient();

    // 通过 WS 获取大屏数据
    handleClientMessage(client.clientId, { type: 'get_dashboard' });
    const messages = consumeMessages(client.clientId);
    expect(messages.some(m => m.type === 'dashboard')).toBe(true);

    // 广播推送
    broadcastToAll({
      type: 'event',
      data: { eventType: 'task:completed', taskId: 'task-1' },
      timestamp: Date.now(),
    });
    const pushed = consumeMessages(client.clientId);
    expect(pushed.length).toBe(1);
  });

  it('G13-3: 输入去重防风暴', () => {
    // 第一次请求通过
    const r1 = dedupCheck({
      source: 'agent-1', intent: 'submit', target: 'task-1', agentId: 'agent-1',
    });
    expect(r1.ok).toBe(true);

    // 重复请求被拦截
    const r2 = dedupCheck({
      source: 'agent-1', intent: 'submit', target: 'task-1', agentId: 'agent-1',
    });
    expect(r2.ok).toBe(false);

    // 不同请求通过
    const r3 = dedupCheck({
      source: 'agent-2', intent: 'query', target: 'task-2', agentId: 'agent-2',
    });
    expect(r3.ok).toBe(true);
  });

  it('G13-4: 请求日志可观测', async () => {
    await handleRequest({ method: 'GET', url: '/api/tasks' });
    await handleRequest({ method: 'GET', url: '/api/agents' });
    await handleRequest({ method: 'GET', url: '/api/tokens/overview' });

    const logs = getRequestLogs();
    expect(logs.length).toBe(3);
    expect(logs[0].path).toBe('/api/tasks');
    expect(logs[0].status).toBe(200);
  });
});
