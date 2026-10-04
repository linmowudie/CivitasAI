/**
 * Harness 族入口——工具调用/中间件展示组件。
 */
import { ToolGroup } from './ToolGroup';

export { ToolGroup };

import type { ComponentRegistryAPI } from '../types';

/** 注册 Harness 族所有组件到注册表 */
export function registerAll(registry: ComponentRegistryAPI): void {
  registry.register({
    family: 'harness',
    component: ToolGroup as any,
    eventTypes: ['agent:tool_call', 'agent:tool_result'],
    metadata: { name: 'ToolGroup', description: '工具调用展示', version: '1.0.0' },
  });
}
