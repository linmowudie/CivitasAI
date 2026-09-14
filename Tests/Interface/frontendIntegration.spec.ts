/**
 * F6.1 — 前端集成契约测试。
 * 验证前端依赖的所有 API 函数存在且返回正确结构。
 * 后端路由/签名变更即失败（契约保护）。
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ── Router ──────────────────────────────────────────
import { matchRoute, clearRoutes } from '../../Src/Interface/RestApi/router.js';

// ── 各 API 函数 ─────────────────────────────────────
import { listAgents, registerAgentRoutes } from '../../Src/Interface/RestApi/agentApi.js';
import { submitTask, listTasks, registerTaskRoutes, resetTaskApi } from '../../Src/Interface/RestApi/taskApi.js';
import { getTokenOverview, listWallets, listTransactions, registerTokenRoutes } from '../../Src/Interface/RestApi/tokenApi.js';
import { listPendingApprovals, registerApprovalRoutes } from '../../Src/Interface/RestApi/approvalApi.js';
import { getEvents, getDashboardOverview, listArbitrationCases, registerLoopRoutes } from '../../Src/Interface/RestApi/loopApi.js';
import { registerConfigRoutes } from '../../Src/Interface/RestApi/configApi.js';
import { listConfigs, getConfig } from '../../Src/Interface/RestApi/configApi.js';

// ── 路由注册 ────────────────────────────────────────
import { registerAllRoutes } from '../../Src/Interface/WebServer/routes.js';

// ── 重置 ────────────────────────────────────────────
import { resetEventBus } from '../../Src/Interface/../Services/EventBus/eventBus.js';

function registerAll(): void {
  clearRoutes();
  resetTaskApi();
  registerAllRoutes();
}

describe('F6.1 · 前端集成契约测试', () => {
  beforeEach(() => {
    registerAll();
  });

  // ── Agent 契约 ──────────────────────────────────────
  describe('Agent 契约', () => {
    it('GET /api/agents 路由已注册', () => {
      const matched = matchRoute('GET', '/api/agents');
      expect(matched).not.toBeNull();
    });

    it('listAgents() 返回数组', () => {
      const result = listAgents();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── Task 契约 ──────────────────────────────────────
  describe('Task 契约', () => {
    it('GET /api/tasks 路由已注册', () => {
      expect(matchRoute('GET', '/api/tasks')).not.toBeNull();
    });

    it('POST /api/tasks 路由已注册', () => {
      expect(matchRoute('POST', '/api/tasks')).not.toBeNull();
    });

    it('listTasks() 返回数组', () => {
      const result = listTasks();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── Token 契约 ──────────────────────────────────────
  describe('Token 契约', () => {
    it('GET /api/tokens/overview 路由已注册', () => {
      expect(matchRoute('GET', '/api/tokens/overview')).not.toBeNull();
    });

    it('getTokenOverview() 返回正确结构', () => {
      const result = getTokenOverview();
      expect(result).toHaveProperty('systemPool');
      expect(result).toHaveProperty('totalTaxCollected');
      expect(result).toHaveProperty('totalDestroyed');
      expect(result).toHaveProperty('currentTaxRate');
      expect(result).toHaveProperty('walletCount');
    });

    it('GET /api/tokens/transactions 路由已注册', () => {
      expect(matchRoute('GET', '/api/tokens/transactions')).not.toBeNull();
    });

    it('listTransactions() 返回数组', () => {
      const result = listTransactions();
      expect(Array.isArray(result)).toBe(true);
    });

    it('GET /api/tokens/wallets 路由已注册', () => {
      expect(matchRoute('GET', '/api/tokens/wallets')).not.toBeNull();
    });

    it('listWallets() 返回数组', () => {
      const result = listWallets();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── Approval 契约 ──────────────────────────────────
  describe('Approval 契约', () => {
    it('GET /api/approvals 路由已注册', () => {
      expect(matchRoute('GET', '/api/approvals')).not.toBeNull();
    });

    it('POST /api/approvals/:id/decide 路由已注册', () => {
      expect(matchRoute('POST', '/api/approvals/test-id/decide')).not.toBeNull();
    });

    it('listPendingApprovals() 返回数组', () => {
      const result = listPendingApprovals();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── Loop 契约 ──────────────────────────────────────
  describe('Loop 契约', () => {
    it('GET /api/loops/events 路由已注册', () => {
      expect(matchRoute('GET', '/api/loops/events')).not.toBeNull();
    });

    it('getEvents() 返回数组', () => {
      const result = getEvents();
      expect(Array.isArray(result)).toBe(true);
    });

    it('GET /api/loops/dashboard 路由已注册', () => {
      expect(matchRoute('GET', '/api/loops/dashboard')).not.toBeNull();
    });

    it('getDashboardOverview() 返回正确结构', () => {
      const result = getDashboardOverview();
      expect(result).toHaveProperty('activeAgents');
      expect(result).toHaveProperty('totalAgents');
      expect(result).toHaveProperty('activeArbitrationCases');
      expect(result).toHaveProperty('totalArbitrationCases');
      expect(result).toHaveProperty('recentEvents');
    });

    it('GET /api/loops/arbitration 路由已注册', () => {
      expect(matchRoute('GET', '/api/loops/arbitration')).not.toBeNull();
    });

    it('listArbitrationCases() 返回数组', () => {
      const result = listArbitrationCases();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── Config 契约 ──────────────────────────────────────
  describe('Config 契约', () => {
    it('GET /api/configs 路由已注册', () => {
      expect(matchRoute('GET', '/api/configs')).not.toBeNull();
    });

    it('listConfigs() 返回数组', () => {
      const result = listConfigs();
      expect(Array.isArray(result)).toBe(true);
    });

    it('getConfig("default.json") 返回对象', () => {
      const result = getConfig('default.json');
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    it('getConfig("nonexistent.json") 返回 undefined', () => {
      const result = getConfig('nonexistent.json');
      expect(result).toBeUndefined();
    });
  });

  // ── 契约完整性验证 ──────────────────────────────────
  describe('前端依赖路由完整性', () => {
    it('所有前端 store 依赖的 API 路由均已注册', () => {
      const requiredRoutes: [string, string][] = [
        ['GET', '/api/agents'],           // agentStore.hydrate
        ['GET', '/api/tasks'],            // taskStore.hydrate
        ['POST', '/api/tasks'],           // taskStore.submitTask
        ['GET', '/api/tokens/overview'],  // tokenStore.hydrate
        ['GET', '/api/tokens/transactions'], // tokenStore.hydrateTransactions
        ['GET', '/api/tokens/wallets'],   // TokenLedger
        ['GET', '/api/approvals'],        // approvalStore.hydrate
        ['GET', '/api/loops/events'],     // loopStore.hydrate
        ['GET', '/api/loops/dashboard'],  // systemStore.hydrate
        ['GET', '/api/loops/arbitration'], // ArbitrationView
        ['GET', '/api/configs'],          // SystemConfig
      ];

      for (const [method, path] of requiredRoutes) {
        const matched = matchRoute(method as any, path);
        expect(matched, `${method} ${path} 路由未注册——前端 store 将无法正常 hydrate`).not.toBeNull();
      }
    });
  });
});
