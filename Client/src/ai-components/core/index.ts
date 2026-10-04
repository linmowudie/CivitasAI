/**
 * Core 族入口——高频组件，启动时注册。
 */
import { StreamBuffer } from './StreamBuffer';
import { CoTFolder } from './CoTFolder';
import { MessageShell } from './MessageShell';

export { StreamBuffer, CoTFolder, MessageShell };

import type { ComponentRegistryAPI } from '../types';

/** 注册 Core 族所有组件到注册表 */
export function registerAll(registry: ComponentRegistryAPI): void {
  registry.register({
    family: 'core',
    component: StreamBuffer as any,
    eventTypes: ['agent:stream_chunk', 'agent:stream_end'],
    metadata: { name: 'StreamBuffer', description: '流式输出缓冲', version: '1.0.0' },
  });
  registry.register({
    family: 'core',
    component: CoTFolder as any,
    eventTypes: ['agent:reasoning_chunk', 'agent:reasoning_end'],
    metadata: { name: 'CoTFolder', description: '思维链折叠区', version: '1.0.0' },
  });
  registry.register({
    family: 'core',
    component: MessageShell as any,
    eventTypes: ['agent:message_start', 'agent:message_end'],
    metadata: { name: 'MessageShell', description: '消息外壳', version: '1.0.0' },
  });
}
