/**
 * T3: 热工具清单配置化测试。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildToolHeader, setToolHeaderConfig, resetToolHeaderConfig, DEFAULT_HOT_TOOLS, META_TOOLS } from '../../Src/Tools/Registry/toolHeader';
import { registerBuiltinTools } from '../../Src/Tools/builtinLoader';
import type { UserRole } from '../../Src/Infra/types';

const ROLE: UserRole = 'prime_director';

describe('T3: 热工具清单配置化', () => {
  beforeEach(() => {
    registerBuiltinTools();
    resetToolHeaderConfig();
  });

  it('未注入配置时为默认集合（与 DEFAULT_HOT_TOOLS 一致）', () => {
    const header = buildToolHeader(ROLE);
    const names = header.map(s => s.name);
    for (const name of names) {
      const isDefault = DEFAULT_HOT_TOOLS.includes(name) || META_TOOLS.includes(name);
      expect(isDefault).toBe(true);
    }
  });

  it('注入自定义 hot 后，buildToolHeader 返回该集合 ∩ 角色可见 ∪ 元工具', () => {
    setToolHeaderConfig({ hotTools: ['file.read', 'shell.exec'] });
    const header = buildToolHeader(ROLE);
    const names = header.map(s => s.name);
    // 元工具必须存在
    for (const m of META_TOOLS) {
      expect(names).toContain(m);
    }
  });

  it('maxHeaderTools=3 时，返回条数 ≤ 3 且元工具仍在内', () => {
    setToolHeaderConfig({
      hotTools: ['file.read', 'file.write', 'file.edit', 'dir.list', 'shell.exec'],
      maxHeaderTools: 3,
    });
    const header = buildToolHeader(ROLE);
    expect(header.length).toBeLessThanOrEqual(3);
    // 元工具优先保留
    const names = header.map(s => s.name);
    for (const m of META_TOOLS) {
      expect(names).toContain(m);
    }
  });
});
