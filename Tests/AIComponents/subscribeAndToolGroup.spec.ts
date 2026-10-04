/**
 * Subscribe 事件匹配 + ToolGroup 工具子分组推断 测试。
 *
 * 测试范围：
 * - matchEventType()：精确匹配、通配符匹配、边界情况
 * - inferSubgroup()：工具名称前缀推断 read/write/exec/system
 */
import { describe, it, expect } from 'vitest';
import { matchEventType } from '../../Client/src/ai-components/Subscribe';
import { inferSubgroup } from '../../Client/src/ai-components/harness/ToolGroup';

// ── matchEventType 测试 ─────────────────────────────────────────────

describe('matchEventType', () => {
  describe('精确匹配', () => {
    it('相同事件类型匹配', () => {
      expect(matchEventType('agent:stream_chunk', 'agent:stream_chunk')).toBe(true);
    });

    it('不同事件类型不匹配', () => {
      expect(matchEventType('agent:stream_chunk', 'agent:stream_end')).toBe(false);
    });

    it('大小写敏感', () => {
      expect(matchEventType('Agent:Stream_Chunk', 'agent:stream_chunk')).toBe(false);
    });

    it('空字符串精确匹配', () => {
      expect(matchEventType('', '')).toBe(true);
    });

    it('空模式不匹配非空事件', () => {
      expect(matchEventType('agent:stream_chunk', '')).toBe(false);
    });
  });

  describe('通配符匹配', () => {
    it('agent:* 匹配 agent:stream_chunk', () => {
      expect(matchEventType('agent:stream_chunk', 'agent:*')).toBe(true);
    });

    it('agent:* 匹配 agent:tool_call', () => {
      expect(matchEventType('agent:tool_call', 'agent:*')).toBe(true);
    });

    it('memory:* 匹配 memory:written', () => {
      expect(matchEventType('memory:written', 'memory:*')).toBe(true);
    });

    it('agent:* 不匹配 loop:iteration', () => {
      expect(matchEventType('loop:iteration', 'agent:*')).toBe(false);
    });

    it('* 匹配所有事件', () => {
      expect(matchEventType('anything:here', '*')).toBe(true);
      expect(matchEventType('other:event', '*')).toBe(true);
    });

    it('agent:tool_* 匹配 agent:tool_call', () => {
      expect(matchEventType('agent:tool_call', 'agent:tool_*')).toBe(true);
    });

    it('agent:tool_* 匹配 agent:tool_result', () => {
      expect(matchEventType('agent:tool_result', 'agent:tool_*')).toBe(true);
    });

    it('agent:tool_* 不匹配 agent:stream_chunk', () => {
      expect(matchEventType('agent:stream_chunk', 'agent:tool_*')).toBe(false);
    });

    it('loop:*_complete 匹配 loop:iteration_complete', () => {
      expect(matchEventType('loop:iteration_complete', 'loop:*_complete')).toBe(true);
    });
  });

  describe('边界情况', () => {
    it('多个通配符：*:* 匹配所有带冒号的事件', () => {
      expect(matchEventType('agent:stream', '*:*')).toBe(true);
    });

    it('通配符模式无冒号：agent* 匹配 agent:stream', () => {
      expect(matchEventType('agent:stream', 'agent*')).toBe(true);
    });
  });
});

// ── inferSubgroup 测试 ──────────────────────────────────────────────

describe('inferSubgroup', () => {
  describe('read 子分组', () => {
    it('read_ 前缀 → read', () => {
      expect(inferSubgroup('read_file')).toBe('read');
    });

    it('search_ 前缀 → read', () => {
      expect(inferSubgroup('search_db')).toBe('read');
    });

    it('list_ 前缀 → read', () => {
      expect(inferSubgroup('list_items')).toBe('read');
    });
  });

  describe('write 子分组', () => {
    it('write_ 前缀 → write', () => {
      expect(inferSubgroup('write_file')).toBe('write');
    });

    it('create_ 前缀 → write', () => {
      expect(inferSubgroup('create_record')).toBe('write');
    });

    it('update_ 前缀 → write', () => {
      expect(inferSubgroup('update_config')).toBe('write');
    });
  });

  describe('exec 子分组', () => {
    it('exec_ 前缀 → exec', () => {
      expect(inferSubgroup('exec_command')).toBe('exec');
    });

    it('run_ 前缀 → exec', () => {
      expect(inferSubgroup('run_script')).toBe('exec');
    });

    it('execute_ 前缀 → exec', () => {
      expect(inferSubgroup('execute_query')).toBe('exec');
    });
  });

  describe('system 子分组（默认）', () => {
    it('无前缀 → system', () => {
      expect(inferSubgroup('log_event')).toBe('system');
    });

    it('未知前缀 → system', () => {
      expect(inferSubgroup('notify_user')).toBe('system');
    });

    it('空字符串 → system', () => {
      expect(inferSubgroup('')).toBe('system');
    });

    it('大小写敏感：Read_file → system（非 read）', () => {
      expect(inferSubgroup('Read_file')).toBe('system');
    });
  });
});
