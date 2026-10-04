/**
 * @module Interface/WebServer/routes
 * @description
 * 路由注册入口——统一注册所有 REST API 路由。
 */

import { registerTaskRoutes } from '../RestApi/taskApi.js';
import { registerAgentRoutes } from '../RestApi/agentApi.js';
import { registerTokenRoutes } from '../RestApi/tokenApi.js';
import { registerApprovalRoutes } from '../RestApi/approvalApi.js';
import { registerLoopRoutes } from '../RestApi/loopApi.js';
import { registerChatRoutes } from '../RestApi/chatApi.js';
import { registerConfigRoutes } from '../RestApi/configApi.js';
import { registerMemoryRoutes } from '../RestApi/memoryApi.js';
import { registerSyncRoutes } from '../RestApi/syncApi.js';
import { registerToolsRoutes } from '../RestApi/toolsApi.js';
import { registerSkillsRoutes } from '../RestApi/skillsApi.js';
import { registerPlaceholderRoutes } from '../RestApi/placeholderApi.js';
import { registerGovernanceRoutes } from '../RestApi/governanceApi.js';
import { registerRegulationRoutes } from '../RestApi/regulationApi.js';
import { registerAuditRoutes } from '../RestApi/auditApi.js';
import { registerArbitrationRoutes } from '../RestApi/arbitrationApi.js';
import { clearRoutes } from '../RestApi/router.js';

/**
 * 注册所有 API 路由。
 */
export function registerAllRoutes(): void {
  clearRoutes();
  registerTaskRoutes();
  registerAgentRoutes();
  registerTokenRoutes();
  registerApprovalRoutes();
  registerLoopRoutes();
  registerChatRoutes();  // F0.7
  registerConfigRoutes();  // F5.4
  registerMemoryRoutes();  // Phase 5
  registerSyncRoutes();    // 账号同步（本地统计派生）
  registerToolsRoutes();   // Phase 5
  registerSkillsRoutes();  // Phase 5
  registerPlaceholderRoutes();  // Phase 5 占位
  registerGovernanceRoutes();  // 治理动作留痕查询（2026-10-04，G-10）
  registerRegulationRoutes();  // 监管域动作（FE-060：法典/广播/干预/终审）
  registerAuditRoutes();       // 审计域（FE-061：冻结/巡检/稽查）
  registerArbitrationRoutes(); // 仲裁域（FE-062：六步闭环手动驱动/干预/恢复查询）
}
