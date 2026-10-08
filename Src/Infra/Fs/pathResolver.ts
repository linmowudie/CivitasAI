/**
 * 路径解析器 —— 安装态 / 便携态 / 开发态 三态目录契约。
 *
 * ## 两个"根"环境变量（对外契约，安装包与用户都可依赖）
 *
 * | 变量 | 含义 | 缺省 |
 * |------|------|------|
 * | `CIVITAS_APP_ROOT` | **程序/资源根**（只读）：`Configs/`（内置种子）、`Prompts/`、`Skills/`、`assets/`、`dist/` | 自动向上查找含 `Configs/default.json` 或 `package.json` 的目录；找不到则 `cwd` |
 * | `CIVITAS_DATA_ROOT` | **全局数据根**（可写）：数据库、日志、密钥、用户配置、备份元数据 | 开发/便携 = `<APP_ROOT>/Data`；安装态由 Electron 注入 `%APPDATA%\\CivitasAI` |
 * | `CIVITAS_WORKSPACE_ROOT` | **工作空间根**（可写，体积大户）：会话工作目录、沙箱、文件备份 | 开发 = `DATA_ROOT`；便携 = `<APP_ROOT>/Workspace`；安装 = `<APP_ROOT>/Workspace`，只读时回落 `<DATA_ROOT>/Workspace` |
 *
 * 目录分工（2026-10-06 产品决策）：
 * - **全局数据**（库/日志/密钥/配置）落 `%APPDATA%\\CivitasAI`，卸载不丢、无需管理员；
 * - **工作空间数据**（上下文产物、会话工作目录）落**安装目录**，便于用户就近查看/清理；
 * - **文件备份**落工作空间内的 `.civitas/`（`getBackupDir()` / `getSessionBackupDir()`）。
 *
 * ## 兼容的旧变量
 * `CIVITAS_DATA_DIR` / `CIVITAS_LOG_DIR` / `CIVITAS_CONFIG_DIR` / `CIVITAS_PROMPTS_DIR` /
 * `CIVITAS_SKILLS_DIR` / `CIVITAS_PORTABLE` 仍然生效（旧部署脚本、Docker 文档依赖它们）。
 *
 * ## 设计约束
 * - `ensureDirSafe()` **绝不抛错**：安装态若遇到只读目录，宁可降级 + 告警，也不要在启动期炸掉进程
 *   （历史缺陷：`initDirectories()` 在 `C:\Program Files` 下抛 EPERM → 应用直接退出）。
 * - 解析结果按进程缓存（环境变量在运行期不变）；测试用 `resetPathCache()` 清理。
 */

import { join, resolve, isAbsolute, dirname } from 'node:path';
import { existsSync, mkdirSync, accessSync, constants, writeFileSync, unlinkSync } from 'node:fs';

// ── 类型 ────────────────────────────────────────────────────────────

/** 运行形态 */
export type InstallMode = 'development' | 'portable' | 'installed';

/** 目录诊断信息（日志 / 首次运行引导 / 排障面板共用） */
export interface PathDiagnostics {
  mode: InstallMode;
  appRoot: string;
  dataRoot: string;
  workspaceRoot: string;
  configDir: string;
  bundledConfigDir: string;
  logDir: string;
  databaseDir: string;
  secretsDir: string;
  backupDir: string;
  /** 应用运行状态目录（首次运行引导标记、一次性迁移标记等） */
  stateDir: string;
  promptsDir: string;
  skillsDir: string;
  /** 各可写目录的实际可写性（false 表示已降级或不可用） */
  writable: Record<string, boolean>;
  /** 解析过程中的告警（例如工作目录不可写而回落） */
  warnings: string[];
}

// ── 缓存 ────────────────────────────────────────────────────────────

let cached: Omit<PathDiagnostics, 'writable'> | null = null;

/** 清理缓存（测试 / 运行期改环境变量后重算） */
export function resetPathCache(): void {
  cached = null;
  writableCache.clear();
}

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== '' ? v : undefined;
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

// ── 模式检测 ────────────────────────────────────────────────────────

/**
 * 判定运行形态。
 *
 * 注意：**打包 ≠ 便携**。历史实现里 `app.isPackaged` 直接当作便携，导致安装到
 * `C:\Program Files` 后数据写进安装目录（只读）→ 启动失败。现在只认显式信号：
 * `CIVITAS_PORTABLE=1`、`--portable` 参数、或可执行文件同级的 `.portable` 标记文件。
 */
export function getInstallMode(): InstallMode {
  if (truthy(env('CIVITAS_PORTABLE')) || process.argv.includes('--portable') || hasPortableMarker()) {
    return 'portable';
  }
  if (truthy(env('CIVITAS_INSTALLED'))) return 'installed';
  return 'development';
}

/**
 * 是否运行在 Electron 打包产物内。
 *
 * 用于区分"开发态直跑"与"安装/便携态"——打包态进程的 `cwd` 由启动方式（快捷方式
 * "起始位置"、命令行、计划任务）决定，**不可作为路径推断依据**。
 */
function isPackagedRuntime(): boolean {
  try {
    const proc = process as unknown as { resourcesPath?: string; defaultApp?: boolean };
    return Boolean(proc.resourcesPath) && proc.defaultApp !== true;
  } catch {
    return false;
  }
}

/** 可执行文件同级存在 `.portable` 文件（便携版分发时随包放置） */
function hasPortableMarker(): boolean {
  try {
    if (existsSync(join(dirname(process.execPath), '.portable'))) return true;
    // cwd 兜底**只用于开发态直跑**（`node dist/main/Src/main.js`）。
    // 打包态若也看 cwd：快捷方式的"起始位置"里恰好有一个 `.portable` 就会把安装版误判成便携版，
    // 数据根/工作空间整体错位（2026-10-06 打包态审计修复）。
    if (isPackagedRuntime()) return false;
    return existsSync(join(process.cwd(), '.portable'));
  } catch {
    return false;
  }
}

/** @deprecated 用 `getInstallMode() === 'portable'`；保留以兼容旧调用 */
export function isPortableMode(): boolean {
  return getInstallMode() === 'portable';
}

// ── 根目录解析 ──────────────────────────────────────────────────────

/**
 * 程序/资源根（只读）。
 *
 * 解析顺序：`CIVITAS_APP_ROOT` → 从本模块位置向上查找含 `Configs/default.json` 或
 * `package.json` 的目录 → `cwd`。
 *
 * 为什么要"向上查找"：后端可能被 esbuild 打成一个文件（`dist/main/Src/main.js`），
 * 也可能以 `tsx Src/main.ts` 直跑，源码深度不同；按内容特征查找比按固定层数上溯可靠。
 */
export function getAppRoot(): string {
  return resolveRoot().appRoot;
}

function findAppRoot(): string {
  const explicit = env('CIVITAS_APP_ROOT');
  if (explicit) return resolve(explicit);

  // 从模块目录（打包/直跑均可用 import.meta.dirname）向上找
  let dir = '';
  try {
    dir = import.meta.dirname ?? '';
  } catch {
    dir = '';
  }
  const start = dir || process.cwd();
  let current = resolve(start);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(current, 'Configs', 'default.json')) || existsSync(join(current, 'package.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(process.cwd());
}

function resolveRoot(): Omit<PathDiagnostics, 'writable'> {
  if (cached) return cached;

  const warnings: string[] = [];
  const mode = getInstallMode();
  const appRoot = findAppRoot();

  // 全局数据根
  const dataOverride = env('CIVITAS_DATA_ROOT') ?? env('CIVITAS_DATA_DIR');
  const dataRoot = dataOverride
    ? resolve(dataOverride)
    : join(appRoot, 'Data');

  // 工作空间根：用户要求"工作空间数据存安装目录"
  let workspaceRoot: string;
  const wsOverride = env('CIVITAS_WORKSPACE_ROOT');
  if (wsOverride) {
    workspaceRoot = resolve(wsOverride);
  } else if (mode === 'development') {
    // 开发态保持既有布局：<仓库>/Data/...（不额外制造顶层 Workspace/ 目录）
    workspaceRoot = dataRoot;
  } else {
    const installSide = join(appRoot, 'Workspace');
    // 用程序根本身的可写性判断（不产生副作用：不在此处 mkdir）
    if (isWritableDir(appRoot, false)) {
      workspaceRoot = installSide;
    } else {
      workspaceRoot = join(dataRoot, 'Workspace');
      warnings.push(
        `工作空间目录不可写（${installSide}）→ 已回落到 ${workspaceRoot}；`
        + '若希望工作空间留在安装目录，请安装到用户可写位置（如 D:\\CivitasAI 或默认的 %LOCALAPPDATA%\\Programs）。',
      );
    }
  }

  const bundledConfigDir = env('CIVITAS_CONFIG_DIR_BUILTIN') ?? join(appRoot, 'Configs');
  // 用户可写配置层：开发态即仓库 Configs（行为不变），安装/便携态落数据根
  const configDir = env('CIVITAS_CONFIG_DIR')
    ?? (mode === 'development' ? bundledConfigDir : join(dataRoot, 'Configs'));

  const logDir = env('CIVITAS_LOG_DIR') ?? join(dataRoot, 'Logs');
  const databaseDir = join(dataRoot, 'db');
  const secretsDir = join(dataRoot, '.secrets');
  const backupDir = env('CIVITAS_BACKUP_DIR') ?? join(workspaceRoot, '.civitas');
  const stateDir = env('CIVITAS_STATE_DIR') ?? join(dataRoot, '.state');
  const promptsDir = env('CIVITAS_PROMPTS_DIR') ?? join(appRoot, 'Prompts');
  const skillsDir = env('CIVITAS_SKILLS_DIR') ?? join(appRoot, 'Skills');

  cached = {
    mode,
    appRoot,
    dataRoot,
    workspaceRoot,
    configDir,
    bundledConfigDir,
    logDir,
    databaseDir,
    secretsDir,
    backupDir,
    stateDir,
    promptsDir,
    skillsDir,
    warnings,
  };
  return cached;
}

// ── 派生目录 ────────────────────────────────────────────────────────

/** 全局数据根（数据库/日志/密钥/用户配置的父目录） */
export function getDataRoot(): string {
  return resolveRoot().dataRoot;
}

/** 全局数据根（旧名，等价 `getDataRoot()`） */
export function getDataDir(): string {
  return getDataRoot();
}

/** 工作空间根（会话工作目录、沙箱、备份） */
export function getWorkspaceRoot(): string {
  return resolveRoot().workspaceRoot;
}

/** 日志目录 */
export function getLogDir(): string {
  return resolveRoot().logDir;
}

/** 数据库目录 */
export function getDatabaseDir(): string {
  return resolveRoot().databaseDir;
}

/** 密钥目录（`providers.json.enc` 等；safeStorage 加密后落盘） */
export function getSecretsDir(): string {
  return resolveRoot().secretsDir;
}

/** 文件备份根（工作空间内的 `.civitas/`） */
export function getBackupDir(): string {
  return resolveRoot().backupDir;
}

/** 应用运行状态目录（首次运行引导标记等）：`<DATA_ROOT>/.state` */
export function getStateDir(): string {
  return resolveRoot().stateDir;
}

/** 单个会话工作目录（`<workspaceRoot>/workspaces/<sessionId>`，与 workspaceGuard 同构） */
export function getSessionWorkspaceDir(sessionId: string): string {
  return join(getWorkspaceRoot(), 'workspaces', sessionId);
}

/** 单个会话的备份目录（`.civitas/`，用于文件改写的可回滚副本与 diff 基线） */
export function getSessionBackupDir(sessionId: string): string {
  return join(getSessionWorkspaceDir(sessionId), '.civitas');
}

/** 用户可写配置目录（安装/便携态 = `<dataRoot>/Configs`；开发态 = 仓库 `Configs/`） */
export function getConfigDir(): string {
  return resolveRoot().configDir;
}

/**
 * 内置只读配置目录（`<appRoot>/Configs`，随安装包分发）。
 *
 * 与 `getConfigDir()` 的关系：内置目录提供基线，用户目录提供覆盖；
 * `configLoader` 按"内置 → 用户"顺序合并，用户只需写 `local.json` 即可覆盖任何键。
 */
export function getBundledConfigDir(): string {
  return resolveRoot().bundledConfigDir;
}

/** 提示词目录（只读资产，随包分发或由 env 覆盖） */
export function getPromptsDir(): string {
  return resolveRoot().promptsDir;
}

/** 技能目录（只读资产） */
export function getSkillsDir(): string {
  return resolveRoot().skillsDir;
}

/**
 * `.env` 文件候选路径（按优先级）：
 * 1. `<DATA_ROOT>/.env`（安装态用户可写位置）
 * 2. `<APP_ROOT>/.env`（开发态仓库根，兼容既有用法）
 */
export function getEnvFilePaths(): string[] {
  const root = resolveRoot();
  const paths = [join(root.dataRoot, '.env'), join(root.appRoot, '.env')];
  return [...new Set(paths)];
}

// ── 可写性探测与安全建目录 ──────────────────────────────────────────

const writableCache = new Map<string, boolean>();

/**
 * 目录是否可写。
 *
 * @param probeCreate 目录不存在时是否尝试创建后再判断（默认真：Mkdir 成功即视为可写）
 */
export function isWritableDir(dir: string, probeCreate = true): boolean {
  const key = `${dir}::${probeCreate ? 1 : 0}`;
  const hit = writableCache.get(key);
  if (hit !== undefined) return hit;
  const result = probeWritable(dir, probeCreate);
  writableCache.set(key, result);
  return result;
}

function probeWritable(dir: string, probeCreate: boolean): boolean {
  try {
    if (!existsSync(dir)) {
      if (!probeCreate) return false;
      mkdirSync(dir, { recursive: true });
    }
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 建目录结果（不抛错） */
export interface EnsureDirResult {
  dir: string;
  ok: boolean;
  error?: string;
}

/**
 * 创建目录，**绝不抛错**。
 *
 * 安装态可能落在只读位置（例如管理员把程序装进 `C:\Program Files`），
 * 此时必须降级 + 告警，而不是让 `main.ts` 的启动序列炸掉。
 */
export function ensureDirSafe(dir: string): EnsureDirResult {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return { dir, ok: true };
  } catch (e) {
    return { dir, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 旧名兼容：存在则什么都不做，失败不抛错（返回是否成功） */
export function ensureDir(dir: string): boolean {
  return ensureDirSafe(dir).ok;
}

/**
 * 可写性"写探针"：真正写一个临时文件再删。
 *
 * 比 `accessSync(W_OK)` 更可信——Windows 的 ACL、只读属性、以及
 * Program Files 的虚拟化重定向都可能骗过权限位检查。
 */
export function probeWrite(dir: string): EnsureDirResult {
  const ensured = ensureDirSafe(dir);
  if (!ensured.ok) return ensured;
  const probe = join(dir, `.civitas-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, 'ok', { encoding: 'utf8' });
    unlinkSync(probe);
    return { dir, ok: true };
  } catch (e) {
    return { dir, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── 目录初始化 ──────────────────────────────────────────────────────

/** 初始化所有必要目录（幂等、不抛错）；返回不可写项供启动日志/引导页展示 */
export function ensureStandardDirs(): { failed: EnsureDirResult[] } {
  const failed: EnsureDirResult[] = [];
  const targets = [getDataRoot(), getLogDir(), getDatabaseDir(), getSecretsDir(), getStateDir(), getWorkspaceRoot()];
  for (const dir of targets) {
    const r = ensureDirSafe(dir);
    if (!r.ok) failed.push(r);
  }
  return { failed };
}

/** 兼容旧入口：`main.ts` 早期版本调用它并期望不抛错 */
export function initDirectories(): void {
  ensureStandardDirs();
}

// ── 配置中的相对路径解析 ────────────────────────────────────────────

/**
 * 把配置里的路径解析为绝对路径，**以全局数据根为基准**。
 *
 * 演进说明：历史实现是 `resolve(配置值)`（= 相对 `cwd`），安装态下 `cwd` 不是程序目录，
 * 数据库会落到随机位置。现在：绝对路径原样使用；`Data/...` 前缀视为数据根内路径；
 * 其余相对路径按数据根拼接。
 */
export function resolveDataPath(configured: string | undefined, fallbackRelative: string): string {
  const value = (configured ?? '').trim() || fallbackRelative;
  if (isAbsolute(value)) return resolve(value);
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  // 兼容配置里的 "Data/db/x.db" 写法（历史上相对项目根）
  const withoutData = normalized === 'Data'
    ? ''
    : normalized.startsWith('Data/')
      ? normalized.slice('Data/'.length)
      : normalized;
  if (withoutData === '') return getDataRoot();
  return resolve(getDataRoot(), withoutData);
}

/** 把配置里的目录解析为绝对路径（只读资产用程序根，其余用数据根） */
export function resolveAppPath(configured: string | undefined, fallbackRelative: string): string {
  const value = (configured ?? '').trim() || fallbackRelative;
  return isAbsolute(value) ? resolve(value) : resolve(getAppRoot(), value);
}

/** 路径是否落在某个根内（含 `..` 归一化；不做 realpath） */
export function isWithin(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  if (r === t) return true;
  const sep = r.includes('\\') ? '\\' : '/';
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

// ── 诊断快照 ────────────────────────────────────────────────────────

/** 目录契约快照：写日志、首次运行引导页、排障面板共用同一份事实 */
export function describePaths(): PathDiagnostics {
  const root = resolveRoot();
  const writable: Record<string, boolean> = {
    dataRoot: probeWrite(root.dataRoot).ok,
    workspaceRoot: probeWrite(root.workspaceRoot).ok,
    logDir: probeWrite(root.logDir).ok,
    databaseDir: probeWrite(root.databaseDir).ok,
    secretsDir: probeWrite(root.secretsDir).ok,
    configDir: probeWrite(root.configDir).ok,
    backupDir: probeWrite(root.backupDir).ok,
    stateDir: probeWrite(root.stateDir).ok,
  };
  return { ...root, writable };
}

/** 人类可读的一行摘要（启动日志用） */
export function describePathsBrief(): string {
  const d = resolveRoot();
  return `mode=${d.mode} app=${d.appRoot} data=${d.dataRoot} workspace=${d.workspaceRoot}`;
}

/** 兼容旧对象式访问 */
export const paths = {
  get app() { return getAppRoot(); },
  get data() { return getDataDir(); },
  get workspace() { return getWorkspaceRoot(); },
  get logs() { return getLogDir(); },
  get config() { return getConfigDir(); },
  get bundledConfig() { return getBundledConfigDir(); },
  get prompts() { return getPromptsDir(); },
  get skills() { return getSkillsDir(); },
  get database() { return getDatabaseDir(); },
  get secrets() { return getSecretsDir(); },
  get backup() { return getBackupDir(); },
  get mode() { return getInstallMode(); },
  get isPortable() { return getInstallMode() === 'portable'; },
};
