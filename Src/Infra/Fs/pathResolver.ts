/**
 * 路径解析器 —— 支持便携模式与安装模式
 * 
 * 便携模式（Portable）：数据存储在程序目录下的 Data/ 和 Logs/
 * 安装模式（Installed）：数据存储在用户数据目录（%APPDATA%/CivitasAI）
 * 
 * 环境变量优先级：
 * - CIVITAS_DATA_DIR：数据根目录
 * - CIVITAS_LOG_DIR：日志目录
 * - CIVITAS_CONFIG_DIR：配置目录
 * - CIVITAS_PROMPTS_DIR：提示词目录
 * - CIVITAS_SKILLS_DIR：技能目录
 */

import { join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

// ── 模式检测 ────────────────────────────────────────────────────────

/** 检测是否为便携模式 */
export function isPortableMode(): boolean {
  // 环境变量显式指定
  if (process.env.CIVITAS_PORTABLE === '1' || process.env.CIVITAS_PORTABLE === 'true') {
    return true;
  }
  // Electron 打包后自动启用便携模式
  if (process.env.CIVITAS_DATA_DIR) {
    return true;
  }
  // 命令行参数
  if (process.argv.includes('--portable')) {
    return true;
  }
  return false;
}

// ── 路径获取 ────────────────────────────────────────────────────────

/** 获取应用数据根目录 */
export function getDataDir(): string {
  // 环境变量优先
  if (process.env.CIVITAS_DATA_DIR) {
    return resolve(process.env.CIVITAS_DATA_DIR);
  }
  
  if (isPortableMode()) {
    // 便携模式：程序目录/Data
    return resolve('Data');
  }
  
  // 安装模式：用户数据目录
  const appData = process.env.APPDATA || process.env.HOME + '/.config';
  return resolve(join(appData, 'CivitasAI', 'Data'));
}

/** 获取日志目录 */
export function getLogDir(): string {
  if (process.env.CIVITAS_LOG_DIR) {
    return resolve(process.env.CIVITAS_LOG_DIR);
  }
  
  if (isPortableMode()) {
    return resolve('Logs');
  }
  
  const appData = process.env.APPDATA || process.env.HOME + '/.config';
  return resolve(join(appData, 'CivitasAI', 'Logs'));
}

/** 获取配置目录 */
export function getConfigDir(): string {
  if (process.env.CIVITAS_CONFIG_DIR) {
    return resolve(process.env.CIVITAS_CONFIG_DIR);
  }
  
  // 配置通常随程序分发，默认使用程序目录下的 Configs
  return resolve('Configs');
}

/** 获取提示词目录 */
export function getPromptsDir(): string {
  if (process.env.CIVITAS_PROMPTS_DIR) {
    return resolve(process.env.CIVITAS_PROMPTS_DIR);
  }
  return resolve('Prompts');
}

/** 获取技能目录 */
export function getSkillsDir(): string {
  if (process.env.CIVITAS_SKILLS_DIR) {
    return resolve(process.env.CIVITAS_SKILLS_DIR);
  }
  return resolve('Skills');
}

/** 获取数据库目录 */
export function getDatabaseDir(): string {
  return join(getDataDir(), 'db');
}

/** 获取工作区目录 */
export function getWorkspaceDir(): string {
  return join(getDataDir(), 'Workspace');
}

// ── 目录初始化 ──────────────────────────────────────────────────────

/** 确保目录存在 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 初始化所有必要的目录 */
export function initDirectories(): void {
  ensureDir(getDataDir());
  ensureDir(getLogDir());
  ensureDir(getDatabaseDir());
  ensureDir(getWorkspaceDir());
}

// ── 导出便捷对象 ────────────────────────────────────────────────────

export const paths = {
  get data() { return getDataDir(); },
  get logs() { return getLogDir(); },
  get config() { return getConfigDir(); },
  get prompts() { return getPromptsDir(); },
  get skills() { return getSkillsDir(); },
  get database() { return getDatabaseDir(); },
  get workspace() { return getWorkspaceDir(); },
  isPortable: isPortableMode(),
};
