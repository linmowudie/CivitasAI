/**
 * @module Interface/RestApi/taskApi
 * @description
 * 任务 API——Docs/09 §2.2。
 * 任务提交 / 查询 / 详情 / 取消。前端全部走服务接口，无直连 Infra。
 * F0.5：POST 触发 orchestrator.receiveTask()；DELETE 取消任务。
 */

import { json, apiError, registerRoute } from './router.js';
import { receiveTask } from '../../Core/Decision/orchestrator/orchestrator.js';
import { v4 as uuidv4 } from 'uuid';

// ── 任务提交 ────────────────────────────────────────────────────────

// 任务存储（Phase 0-2 内存；Phase 3 持久化）
const tasks: Map<string, TaskRecord> = new Map();

export interface TaskRecord {
  taskId: string;
  traceId: string;
  description: string;
  status: 'submitted' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  completedAt?: number;
  result?: string;
}

/**
 * POST /api/tasks — 提交任务（F0.5：触发 orchestrator 执行）
 */
export function submitTask(params: { description: string }): TaskRecord {
  const taskId = `task-${uuidv4().slice(0, 8)}`;
  const traceId = uuidv4();
  const task: TaskRecord = {
    taskId,
    traceId,
    description: params.description,
    status: 'submitted',
    createdAt: Date.now(),
  };
  tasks.set(task.taskId, task);

  // 异步触发编排（不阻塞 HTTP 响应，执行结果由事件流反馈）
  queueMicrotask(() => {
    task.status = 'running';
    const result = receiveTask({ taskId, traceId, taskDescription: params.description });
    if (result.ok) {
      task.status = 'completed';
      task.completedAt = Date.now();
      task.result = JSON.stringify({ status: result.value.status, routingMode: result.value.routingMode });
    } else {
      task.status = 'failed';
      task.completedAt = Date.now();
      task.result = result.error;
    }
  });

  return { taskId, traceId, description: params.description, status: 'submitted', createdAt: task.createdAt };
}

/**
 * GET /api/tasks — 查询任务列表
 */
export function listTasks(filter?: { status?: string }): TaskRecord[] {
  let all = [...tasks.values()];
  if (filter?.status) {
    all = all.filter(t => t.status === filter.status);
  }
  return all.map(t => ({ ...t }));
}

/**
 * GET /api/tasks/:taskId — 查询任务详情
 */
export function getTask(taskId: string): TaskRecord | undefined {
  const t = tasks.get(taskId);
  return t ? { ...t } : undefined;
}

/**
 * DELETE /api/tasks/:taskId — 取消任务（F0.5）
 */
export function cancelTask(taskId: string): TaskRecord | undefined {
  const t = tasks.get(taskId);
  if (!t) return undefined;
  if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
    return undefined;  // 终态不可取消
  }
  t.status = 'cancelled';
  t.completedAt = Date.now();
  t.result = 'cancelled_by_user';
  return { ...t };
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerTaskRoutes(): void {
  registerRoute('POST', '/api/tasks', async (req) => {
    const desc = req.body?.description as string;
    if (!desc) return apiError('description is required');
    const task = submitTask({ description: desc });
    return json(task, 201);
  });

  registerRoute('GET', '/api/tasks', async (req) => {
    const filter = req.query.status ? { status: req.query.status } : undefined;
    return json(listTasks(filter));
  });

  registerRoute('GET', '/api/tasks/:taskId', async (req) => {
    const taskId = req.params.taskId;
    if (!taskId) return apiError('taskId is required', 400);
    const task = getTask(taskId);
    if (!task) return apiError('Task not found', 404);
    return json(task);
  });

  // F0.5：取消任务
  registerRoute('DELETE', '/api/tasks/:taskId', async (req) => {
    const taskId = req.params.taskId;
    if (!taskId) return apiError('taskId is required', 400);
    const task = cancelTask(taskId);
    if (!task) return apiError('Task not found or already terminal', 404);
    return json(task);
  });
}

// ── 重置（测试用）──────────────────────────────────────────────────

export function resetTaskApi(): void {
  tasks.clear();
}
