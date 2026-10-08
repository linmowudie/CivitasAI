/**
 * 政策测试：**后端不得静默吞掉错误**（2026-10-08 用户明确原则）。
 *
 * 原则：
 *  - **可被用户解决的错误一律不得吞掉**（缺 API Key / 路径与权限 / 配置写错 / 磁盘满 /
 *    凭据删除失败 / 资产文件读不出来 …）——必须留可定位的日志；接口层还要能回传到界面；
 *  - 允许 fail-soft（失败不阻断主链路），但那必须是**显式决定**：代码里写明理由，
 *    而不是一个空 catch。
 *
 * 实现：用 TypeScript AST 精确找"空 catch 块"与"空 .catch(() => {})"，避免正则把
 * 文档注释里的 `catch {}` 也当成代码（初版正则正是这样误判的）。
 *
 * 已知边界：本测试保证"每个静默吞错都有理由"，**不**保证理由成立；
 * "可被用户解决 ⇒ 必须 log/surface" 由审查与下面的回归锚点共同兜底。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SRC = join(import.meta.dirname, '../../Src');

/** 允许的理由标记：审阅者要能一眼看懂为什么可以吞 */
const JUSTIFICATION = /(fail-safe|fail-soft|fail safe|ignore|best[- ]effort|忽略|跳过|降级|清理|已关闭|不影响|不阻断|非关键|静默|统一报错|继续尝试|尝试下一种|非 JSON)/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

interface Violation { file: string; line: number; kind: string; text: string }
const violations: Violation[] = [];
let silentTotal = 0;

for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const rel = relative(join(SRC, '..'), file).replace(/\\/g, '/');

  const record = (node: ts.Node, kind: string, body: ts.Node): void => {
    silentTotal++;
    const bodyText = body.getText(sf);
    if (JUSTIFICATION.test(bodyText)) return; // 已写明理由
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({ file: rel, line: line + 1, kind, text: src.split(/\r?\n/)[line]?.trim() ?? '' });
  };

  const visit = (node: ts.Node): void => {
    // 1) try/catch：catch 块没有任何语句
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      record(node, 'catch', node.block);
    }
    // 2) .catch(() => {}) 或 .catch(e => {})：回调体为空块
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'catch'
      && node.arguments.length > 0) {
      const cb = node.arguments[0]!;
      if (ts.isArrowFunction(cb) && ts.isBlock(cb.body) && cb.body.statements.length === 0) {
        record(node, 'promise-catch', cb.body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

describe('政策：后端不得静默吞错误', () => {
  it('每个空 catch / .catch(() => {}) 都必须写明理由', () => {
    const detail = violations.map((v) => `  ${v.file}:${v.line}  [${v.kind}]  ${v.text}`).join('\n');
    expect(violations, `未说明理由的静默吞错（${violations.length} 处）：\n${detail}`).toEqual([]);
  });

  it('扫描确实命中代码（防止解析失效导致假通过）', () => {
    expect(silentTotal).toBeGreaterThan(10);
  });

  it('回归锚点：缺 API Key 必须具备"预检 + 回传 + 弹窗跳设置"整条链路', () => {
    const ipc = readFileSync(join(SRC, 'Interface/IpcBridge/ipcBridge.ts'), 'utf8');
    expect(ipc).toContain('MISSING_API_KEY_MARKER');
    expect(ipc).toMatch(/apiKeyStatus\(\)/);
    expect(ipc).toMatch(/未配置 API Key/);

    const dialog = readFileSync(join(SRC, '../Client/src/components/Settings/ApiKeyDialog.tsx'), 'utf8');
    expect(dialog).toContain('前往设置密钥');
    expect(dialog).toMatch(/type: 'feature', id: 'settings'/);

    // 事件总线里必须真的接上（否则弹窗永远不会出现）
    const bus = readFileSync(join(SRC, '../Client/src/hooks/useEventBus.ts'), 'utf8');
    expect(bus).toMatch(/isMissingApiKeyError/);
    expect(bus).toMatch(/showApiKeyNotice/);
  });
});
