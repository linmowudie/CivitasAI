/**
 * 文件内容搜索工具（SAFE）
 *
 * 在指定目录中按正则/文本搜索文件内容。
 */

import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { contentOutputSchema } from '../_shared.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkPath } from '../../../Infra/Security/pathGuard.js';

export const grepTool: ToolDefinition = {
  spec: {
    name: 'file.grep',
    version: '0.1.0',
    description: '在指定目录中搜索文件内容，返回匹配行。支持正则表达式。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索模式（正则表达式）' },
        path: { type: 'string', description: '搜索根目录' },
        filePattern: { type: 'string', description: '文件名过滤 glob，如 *.ts' },
        maxResults: { type: 'number', description: '最大结果数，默认 50' },
      },
      required: ['pattern', 'path'],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ matches: Array<{file, line, content}> }'),
    dangerLevel: 'SAFE',
    idempotency: 'YES',
    idempotencyKeyFields: ['pattern', 'path'],
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'none',
    requiredRoles: ['prime_director', 'arbitrator', 'auditor', 'partner', 'worker', 'assembly_node', 'reviewer'],
    sandboxMode: 'none',
    timeoutMs: 15_000,
  },

  async execute(input, context) {
    const pattern = input['pattern'] as string;
    const searchPath = input['path'] as string;
    const filePattern = input['filePattern'] as string | undefined;
    const maxResults = (input['maxResults'] as number) ?? 50;

    if (!pattern || !searchPath) {
      return toolError(context.operationId, 'INVALID_INPUT', '缺少 pattern 或 path 参数', false);
    }

    const check = checkPath(searchPath, 'list');
    if (!check.allowed) {
      return toolError(context.operationId, 'PATH_DENIED', check.reason, false);
    }

    try {
      const regex = new RegExp(pattern, 'gm');
      const matches: Array<{ file: string; line: number; content: string }> = [];

      searchFiles(check.resolvedPath, regex, filePattern, matches, maxResults, check.resolvedPath);

      return toolSuccess(context.operationId, { matches, total: matches.length });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return toolError(context.operationId, 'GREP_FAILED', message, true);
    }
  },
};

function searchFiles(
  dirPath: string,
  regex: RegExp,
  filePattern: string | undefined,
  matches: Array<{ file: string; line: number; content: string }>,
  maxResults: number,
  rootPath: string,
): void {
  if (matches.length >= maxResults) return;

  let items: string[];
  try {
    items = readdirSync(dirPath);
  } catch {
    return;
  }

  for (const item of items) {
    if (item.startsWith('.') || item === 'node_modules') continue;
    if (matches.length >= maxResults) return;

    const fullPath = join(dirPath, item);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        searchFiles(fullPath, regex, filePattern, matches, maxResults, rootPath);
      } else if (stat.isFile()) {
        // 文件名过滤
        if (filePattern && !matchGlob(item, filePattern)) continue;

        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxResults) break;
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            matches.push({
              file: relative(rootPath, fullPath),
              line: i + 1,
              content: lines[i].trim().slice(0, 200),
            });
          }
        }
      }
    } catch {
      // 跳过无法读取的文件
    }
  }
}

/** 简单 glob 匹配（支持 * 和 ?） */
function matchGlob(filename: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(filename);
}
