/**
 * genEventTypes.ts — Docs/16 F0.8
 *
 * 构建期脚本：读取后端 `Src/Services/EventBus/eventTypes.ts` 的 EventType 枚举，
 * 生成 `Client/src/shared/eventTypes.ts`，前端零自造字符串。
 *
 * 用法：npx tsx Scripts/genEventTypes.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'Src/Services/EventBus/eventTypes.ts');
const DEST = resolve(ROOT, 'Client/src/shared/eventTypes.ts');

// ── 解析 EventType 枚举 ────────────────────────────────────────────

function parseEventTypeEnum(source: string): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = [];

  // 匹配 `KEY = 'value'` 行
  const enumRegex = /enum\s+EventType\s*\{([\s\S]*?)\}/;
  const enumMatch = source.match(enumRegex);
  if (!enumMatch) throw new Error('未找到 EventType 枚举');

  const body = enumMatch[1];
  const lineRegex = /^\s*(\w+)\s*=\s*'([^']+)'/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(body)) !== null) {
    entries.push({ key: m[1], value: m[2] });
  }

  return entries;
}

// ── 生成客户端文件 ────────────────────────────────────────────────

function generateClientFile(entries: { key: string; value: string }[]): string {
  const lines = [
    '/**',
    ' * ⚠️  本文件由 Scripts/genEventTypes.ts 自动生成，禁止手动修改。',
    ' * 后端 SSOT：Src/Services/EventBus/eventTypes.ts',
    ' * 构建命令：npx tsx Scripts/genEventTypes.ts',
    ' */',
    '',
    'export const EventType = {',
  ];

  for (const { key, value } of entries) {
    lines.push(`  ${key}: '${value}' as const,`);
  }

  lines.push('} as const;');
  lines.push('');
  lines.push('export type EventTypeValue = typeof EventType[keyof typeof EventType];');
  lines.push('');

  return lines.join('\n');
}

// ── 主流程 ─────────────────────────────────────────────────────────

function main(): void {
  const source = readFileSync(SRC, 'utf-8');
  const entries = parseEventTypeEnum(source);

  console.log(`[genEventTypes] 解析到 ${entries.length} 个事件类型`);

  const content = generateClientFile(entries);

  // 确保目标目录存在
  mkdirSync(dirname(DEST), { recursive: true });
  writeFileSync(DEST, content, 'utf-8');

  console.log(`[genEventTypes] 已生成 ${DEST}`);
}

main();
