/**
 * T1 收口验证：断言 runIteration.ts 不再直接调用 executeTool，
 * 且所有工具调用统一经 dispatchToolCall。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('T1: 工具调用统一收口到派发器', () => {
  const runIterationPath = resolve(__dirname, '../../Src/Core/Loop/runIteration.ts');
  const source = readFileSync(runIterationPath, 'utf-8');

  it('源码中不再直接出现 await executeTool(', () => {
    // 匹配 `await executeTool(` 但排除注释行
    const lines = source.split('\n');
    const violations = lines.filter((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
      return /await\s+executeTool\s*\(/.test(line);
    });
    expect(violations).toEqual([]);
  });

  it('源码中出现 dispatchToolCall( 且其调用带 iteration 字段', () => {
    expect(source).toContain('dispatchToolCall(');
    // 确认调用时传入了 iteration
    expect(source).toMatch(/dispatchToolCall\s*\(\s*\{[^}]*iteration\s*:/s);
  });

  it('import 语句包含 dispatchToolCall 而非 executeTool', () => {
    expect(source).toContain("from '../../Tools/Registry/toolDispatcher.js'");
    // 不应从 toolRegistry 导入 executeTool
    const importLines = source.split('\n').filter(l => l.includes('executeTool'));
    const badImports = importLines.filter(l => /import.*executeTool.*from.*toolRegistry/.test(l));
    expect(badImports).toEqual([]);
  });
});
