/**
 * IPC 事件广播回归测试（2026-10-07）。
 *
 * 背景（真实 bug，开发态启动日志实测）：
 * `setIpcMainProvider` 只注入 `ipcMain`，后端据此拼出一个**残缺的假 electron 模块**，
 * 于是事件广播处 `BrowserWindow.getAllWindows()` 每次必抛
 * `TypeError: Cannot read properties of undefined (reading 'getAllWindows')`，
 * 表现为 UnhandledPromiseRejection，**后端 → 渲染进程的 `backend-event` 推送整条失效**。
 *
 * 修复：改为注入"广播能力函数"（`setWindowBroadcaster`），且广播内部吞掉所有异常。
 * 本测试锁住两点：① 注入的实现优先被调用；② 没有任何实现/实现抛异常时**绝不向上抛**。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { setWindowBroadcaster, broadcastToRendererWindows } from '../../Src/Interface/IpcBridge/ipcBridge.js';

beforeEach(() => {
  // 每个用例从"未注入"状态开始
  setWindowBroadcaster(null);
  vi.restoreAllMocks();
});

describe('IPC 事件广播（backend-event）', () => {
  it('注入的广播实现被优先调用，并透传 channel 与 payload', () => {
    const broadcast = vi.fn(() => 1);
    setWindowBroadcaster(broadcast);

    const sent = broadcastToRendererWindows('backend-event', { type: 'TASK_ASSIGNED' });

    expect(sent).toBe(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('backend-event', { type: 'TASK_ASSIGNED' });
  });

  it('未注入任何实现时不抛异常（历史 bug：这里会 TypeError 变成未处理拒绝）', () => {
    let sent = -1;
    expect(() => { sent = broadcastToRendererWindows('backend-event', { type: 'X' }); }).not.toThrow();
    expect(sent).toBe(0);
  });

  it('广播实现自身抛异常时也被吞掉，调用方不受影响', () => {
    setWindowBroadcaster(() => { throw new Error('窗口已销毁'); });

    let sent = -1;
    expect(() => { sent = broadcastToRendererWindows('backend-event', { type: 'Y' }); }).not.toThrow();
    expect(sent).toBe(0);
  });

  it('可清除注入（回到"无实现"的安全行为）', () => {
    const broadcast = vi.fn(() => 2);
    setWindowBroadcaster(broadcast);
    expect(broadcastToRendererWindows('backend-event', {})).toBe(2);

    setWindowBroadcaster(null);
    expect(broadcastToRendererWindows('backend-event', {})).toBe(0);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});
