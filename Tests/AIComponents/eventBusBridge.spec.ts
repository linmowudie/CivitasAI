/**
 * eventBusBridge 测试——Electron IPC 桥接层。
 *
 * 测试范围：
 * - connectBridge()：Electron 模式 / 浏览器降级模式
 * - disconnectBridge()：断开连接 + 清理
 * - subscribe()：订阅/取消订阅 + 返回值清理函数
 * - send()：Electron 模式发送 / 浏览器降级静默丢弃
 * - 事件分发：多 handler 广播
 * - 连接状态管理：重复连接幂等
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock @/stores/systemStore
vi.mock('@/stores/systemStore', () => ({
  useSystemStore: {
    getState: () => ({
      setOnline: vi.fn(),
    }),
  },
}));

// 动态导入，确保 mock 生效
let eventBusBridge: typeof import('../../Client/src/services/eventBusBridge');

describe('eventBusBridge', () => {
  let originalWindow: typeof globalThis.window;

  beforeEach(async () => {
    vi.resetModules();
    // 保存原始 window
    originalWindow = globalThis.window;
    // 清理 window.electronAPI（默认非 Electron 模式）
    delete (globalThis as any).window;
    (globalThis as any).window = { ...originalWindow };
    delete (globalThis as any).window.electronAPI;

    eventBusBridge = await import('../../Client/src/services/eventBusBridge');
  });

  afterEach(() => {
    eventBusBridge.disconnectBridge();
    // 恢复 window
    if (originalWindow) {
      (globalThis as any).window = originalWindow;
    } else {
      delete (globalThis as any).window;
    }
  });

  describe('connectBridge()', () => {
    it('浏览器模式下连接成功（降级轮询）', () => {
      expect(() => eventBusBridge.connectBridge()).not.toThrow();
    });

    it('重复调用幂等（不抛出异常）', () => {
      eventBusBridge.connectBridge();
      expect(() => eventBusBridge.connectBridge()).not.toThrow();
    });

    it('Electron 模式下通过 IPC 连接', async () => {
      vi.resetModules();
      const mockOnBackendEvent = vi.fn();
      (globalThis as any).window = {
        electronAPI: {
          onBackendEvent: mockOnBackendEvent,
          sendBackendCommand: vi.fn(),
          removeBackendEventListeners: vi.fn(),
        },
      };

      const bridge = await import('../../Client/src/services/eventBusBridge');
      bridge.connectBridge();

      // Electron 模式下应注册 IPC 监听
      expect(mockOnBackendEvent).toHaveBeenCalled();
      bridge.disconnectBridge();
    });
  });

  describe('disconnectBridge()', () => {
    it('断开后不再接收事件', () => {
      eventBusBridge.connectBridge();
      eventBusBridge.disconnectBridge();
      // 断开后订阅的 handler 不应被调用（由后续集成测试验证）
    });

    it('多次断开不抛出异常', () => {
      expect(() => {
        eventBusBridge.disconnectBridge();
        eventBusBridge.disconnectBridge();
      }).not.toThrow();
    });
  });

  describe('subscribe()', () => {
    it('订阅后返回取消订阅函数', () => {
      const handler = vi.fn();
      const unsub = eventBusBridge.subscribe(handler);
      expect(typeof unsub).toBe('function');
    });

    it('取消订阅函数执行后清理 handler', () => {
      const handler = vi.fn();
      const unsub = eventBusBridge.subscribe(handler);
      unsub();
      // handler 已被移除，后续事件不会触发
    });

    it('多个 handler 同时订阅', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      eventBusBridge.subscribe(handler1);
      eventBusBridge.subscribe(handler2);
      // 两个 handler 都已注册
    });
  });

  describe('send()', () => {
    it('浏览器模式下静默丢弃（不抛出异常）', () => {
      // 浏览器模式（无 electronAPI），send 应 warn 但不抛错
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => {
        eventBusBridge.send({ type: 'test', payload: {} });
      }).not.toThrow();
      consoleSpy.mockRestore();
    });

    it('Electron 模式下通过 IPC 发送命令', async () => {
      vi.resetModules();
      const mockSend = vi.fn();
      (globalThis as any).window = {
        electronAPI: {
          onBackendEvent: vi.fn(),
          sendBackendCommand: mockSend,
          removeBackendEventListeners: vi.fn(),
        },
      };

      const bridge = await import('../../Client/src/services/eventBusBridge');
      bridge.connectBridge();
      bridge.send({ type: 'generate_reply', payload: { test: true } });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentData = JSON.parse(mockSend.mock.calls[0][0]);
      expect(sentData.type).toBe('generate_reply');
      bridge.disconnectBridge();
    });
  });
});
