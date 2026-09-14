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
}
