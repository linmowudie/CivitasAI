/**
 * @module Services/Prompts/promptRegistry
 * @description
 * 角色提示词注册表——Prompts/roles/*.md 的运行期装载与查询（FE-052）。
 *
 * 修复背景：`Prompts/` 外置提示词库此前全链无运行期消费者——`main.ts` ⑩ 仅打日志、
 * 无任何加载器、Agent 实体不携带提示词、系统提示装配为硬编码通用段（全部角色共用）。
 * 角色提示词承载的行为约束（如 worker 的 EffectJournal/审批门约束）从未到达模型。
 *
 * 现由 `main.ts` ⑩ 步调用 `loadRolePrompts()` 装载到内存注册表；
 * `agentFactory` 创建 Agent 时按角色装载（落 `agents.system_prompt`），
 * `runIteration` 装配系统提示时按 `agentRole` 查询（角色段 + 静态段 + 工具目录）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getPromptsDir } from '../../Infra/Fs/pathResolver.js';
import { logger } from '../../Infra/Logging/logger.js';

/** 内存注册表：角色名（= 文件名去 `.md`）→ 提示词全文 */
const rolePrompts = new Map<string, string>();

/**
 * 装载 `Prompts/roles/*.md` 到内存注册表（幂等：重复装载覆盖旧值）。
 * 目录缺失或单文件读取失败 → 告警并跳过（不阻断启动，调用方按缺省降级）。
 * @param dir 提示词根目录（缺省取 `getPromptsDir()`，安装模式下为 %APPDATA% 侧）
 * @returns 成功装载的角色数
 */
export function loadRolePrompts(dir: string = getPromptsDir()): number {
  const rolesDir = join(dir, 'roles');
  if (!existsSync(rolesDir)) {
    logger.warn('角色提示词目录不存在，跳过装载', { source: 'promptRegistry', rolesDir });
    return 0;
  }

  let loaded = 0;
  for (const file of readdirSync(rolesDir)) {
    if (!file.endsWith('.md')) continue;
    const role = file.slice(0, -3);
    try {
      const content = readFileSync(join(rolesDir, file), 'utf-8').trim();
      if (!content) continue;
      rolePrompts.set(role, content);
      loaded++;
    } catch (e) {
      logger.warn('角色提示词装载失败（跳过）', {
        source: 'promptRegistry',
        role,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logger.info('角色提示词装载完成', { source: 'promptRegistry', count: loaded });
  return loaded;
}

/** 查询角色提示词（未装载/未知角色 → `undefined`，调用方自行降级） */
export function getRolePrompt(role: string): string | undefined {
  return rolePrompts.get(role);
}

/** 已装载的角色名列表（诊断用） */
export function getLoadedRoles(): string[] {
  return [...rolePrompts.keys()];
}

/** 测试/诊断用：清空注册表 */
export function resetRolePrompts(): void {
  rolePrompts.clear();
}

// ── 系统提示资产 / 任务模板 / 版本清单（FE-069：Prompts/ 其余资产的运行期消费）────
//
// 修复背景：`Prompts/system/mainLoop.md`、`tasks/defaultTask.md`、`versions/manifest.json`
// 此前零消费——现启动装载（`loadSystemAssets`）：mainLoop 段并入系统提示、任务模板提供
// `getTaskTemplate()` 供编排层使用、manifest 做文件存在性校验（缺失告警）。

let systemMainLoop: string | null = null;
let taskTemplate: string | null = null;

export interface PromptsManifestCheck {
  version: string;
  missingFiles: string[];
  fileCount: number;
}

/**
 * 装载系统资产（mainLoop.md / defaultTask.md / manifest.json 校验）。
 * 单文件缺失 → 对应资产为 null（退化），不阻断启动。
 */
export function loadSystemAssets(dir: string = getPromptsDir()): PromptsManifestCheck {
  const systemPath = join(dir, 'system', 'mainLoop.md');
  const taskPath = join(dir, 'tasks', 'defaultTask.md');
  const manifestPath = join(dir, 'versions', 'manifest.json');

  try {
    systemMainLoop = existsSync(systemPath) ? stripPromptMeta(readFileSync(systemPath, 'utf-8')) : null;
  } catch {
    systemMainLoop = null;
  }
  try {
    taskTemplate = existsSync(taskPath) ? readFileSync(taskPath, 'utf-8').trim() : null;
  } catch {
    taskTemplate = null;
  }

  // manifest 校验：登记的文件必须存在
  let version = 'unknown';
  let missingFiles: string[] = [];
  let fileCount = 0;
  try {
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        version?: string;
        files?: Record<string, string>;
      };
      version = manifest.version ?? 'unknown';
      const files = manifest.files ?? {};
      fileCount = Object.keys(files).length;
      missingFiles = Object.keys(files).filter((rel) => !existsSync(join(dir, rel)));
    } else {
      logger.warn('提示词版本清单缺失', { source: 'promptRegistry', manifestPath });
    }
  } catch (e) {
    logger.warn('提示词版本清单解析失败', {
      source: 'promptRegistry',
      error: e instanceof Error ? e.message : String(e),
    });
  }

  if (missingFiles.length > 0) {
    logger.warn('提示词资产清单校验：登记文件缺失', {
      source: 'promptRegistry',
      version,
      missingFiles,
    });
  }

  logger.info('系统提示资产装载完成', {
    source: 'promptRegistry',
    manifestVersion: version,
    manifestFiles: fileCount,
    mainLoopChars: systemMainLoop?.length ?? 0,
    taskTemplateChars: taskTemplate?.length ?? 0,
    missingFiles: missingFiles.length,
  });

  return { version, missingFiles, fileCount };
}

/** 系统提示资产（mainLoop.md；未装载返回 null）——runIteration 装配静态段扩展用 */
export function getSystemMainLoop(): string | null {
  return systemMainLoop;
}

/** 任务模板（defaultTask.md；未装载返回 null）——供编排层任务书生成使用 */
export function getTaskTemplate(): string | null {
  return taskTemplate;
}

/** 测试/诊断用：清空系统资产 */
export function resetSystemAssets(): void {
  systemMainLoop = null;
  taskTemplate = null;
}

/** 剥离提示词资产的文档元数据（引用块说明 / 一级标题），保留可注入的正文 */
function stripPromptMeta(markdown: string): string {
  // 统一换行（CRLF → LF）：`.` 与 `[^\n]` 在 CRLF 下行为差异会致剥离失败
  const normalized = markdown.replace(/\r\n/g, '\n');
  return normalized
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/^#\s+[^\n]*\n+/, '')
    .trim();
}
