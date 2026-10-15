/**
 * @module Interface/RestApi/configApi
 * @description
 * Config API——系统配置的**读真相 + 白名单写**（REV-265 的修复面）。
 *
 * 三个只读视图 + 一个写入通道：
 * - `GET  /api/configs`          内置配置目录的文件清单
 * - `GET  /api/configs/:name`    某个内置配置文件的原文
 * - `GET  /api/configs/user`     用户覆盖层（`<DATA_ROOT>/Configs/local.json`）当前内容
 * - `GET  /api/configs/effective` **生效态真相**：
 *     · `running`  —— 本进程正在使用的合并配置（`main.ts` 启动时 `loadConfig()` 的那一份，
 *                     其中 `routing.*` 取**活体路由表**，因为它是唯一被运行期改写的段）
 *     · `onDisk`   —— 现在重新加载会得到的合并配置（含刚写入的覆盖）
 *     · `restartPending` —— 二者不一致的键（= "已保存但需重启才生效"的真实来源）
 *     · `policy`   —— 后端可写白名单（UI 据此如实标注"这个键后端不接受"，而不是假装已生效）
 * - `PUT  /api/configs/user`     白名单写入 / 删除覆盖层，返回 applied/removed/rejected/invalid
 *                                与每个键的生效时机（`live` / `restart-required`）
 *
 * 为什么必须区分 running 与 onDisk：`loadConfig()` 只在启动时读一次文件，
 * 之后所有消费方都用内存快照。"写文件"≠"生效"，界面上任何"已生效/待生效"的措辞
 * 都只能来自这两个视图的比对，不能来自前端自己的记账。
 *
 * 安全：写入只走 `userConfigWriter` 白名单 + 启动校验器试跑（见该模块），
 * 启动锁定项（`hardLimits.` / `security.` / `database.`）与治理红线键一律 `rejected`。
 * 响应里的合并配置做过凭据脱敏（`api_key` / `token` / `secret` / `password` 路径）。
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

import { json, apiError, registerRoute } from "./router.js";
import { getBundledConfigDir } from "../../Infra/Fs/pathResolver.js";
import {
  loadConfig,
  getRunningConfig,
} from "../../Infra/Config/configLoader.js";
import { getRoutingConfig } from "../../Infra/Llm/Router/modelRouter.js";
import {
  writeUserConfig,
  removeUserConfig,
  readUserConfig,
  getUserConfigPath,
  getUserConfigPolicy,
} from "../../Infra/Config/userConfigWriter.js";
import { logger } from "../../Infra/Logging/logger.js";

/**
 * 配置目录（**惰性**解析）。
 *
 * 历史实现是 `join(process.cwd(), 'Configs')`：安装态 `cwd` 不是程序目录，
 * 该接口会读到不存在的位置。现在统一取内置配置目录（`<APP_ROOT>/Configs`）。
 */
function configsDir(): string {
  return getBundledConfigDir();
}

/**
 * GET /api/configs — 配置列表
 */
export function listConfigs(): { name: string; size: number }[] {
  try {
    const dir = configsDir();
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    return files.map((name) => {
      const stat = readFileSync(join(dir, name));
      return { name, size: stat.length };
    });
  } catch {
    return [];
  }
}

/**
 * GET /api/configs/:name — 配置详情
 */
export function getConfig(name: string): unknown | undefined {
  try {
    const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, "");
    const content = readFileSync(join(configsDir(), safeName), "utf-8");
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

// ── 生效态视图 ──────────────────────────────────────────────────────

/** 凭据脱敏：合并配置里任何形如密钥的叶子都不外泄（`api_key_ref` 是引用指针，不在此列） */
const SECRET_KEY_PATTERN =
  /^(api_?key|apikey|access_?key|token|secret|password|credential)s?$/i;

function redactSecrets(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item) => redactSecrets(item));
  if (node && typeof node === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      const isSecretLeaf =
        SECRET_KEY_PATTERN.test(key) &&
        (value === null ||
          ["string", "number", "boolean"].includes(typeof value));
      result[key] = isSecretLeaf ? REDACTED : redactSecrets(value);
    }
    return result;
  }
  return node;
}

const REDACTED = "**已脱敏**";

/**
 * 合并配置 → 叶子路径表（数组整体视为一个叶子）。
 * 用于 running/onDisk 比对，得出"哪些键已保存但尚未被进程读到"。
 */
function flattenLeaves(tree: unknown, prefix = ""): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    if (prefix) flat[prefix] = tree;
    return flat;
  }
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(flat, flattenLeaves(value, path));
    } else {
      flat[path] = value;
    }
  }
  return flat;
}

/** 两个扁平表的差异（键在任一侧存在且值不等） */
function diffFlat(
  running: Record<string, unknown>,
  onDisk: Record<string, unknown>,
): Array<{ path: string; running: unknown; onDisk: unknown }> {
  const keys = new Set([...Object.keys(running), ...Object.keys(onDisk)]);
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const diffs: Array<{ path: string; running: unknown; onDisk: unknown }> = [];
  for (const path of keys) {
    if (same(running[path], onDisk[path])) continue;
    diffs.push({
      path,
      running: running[path] ?? null,
      onDisk: onDisk[path] ?? null,
    });
  }
  return diffs;
}

export interface EffectiveConfigView {
  env: string | null;
  /** 本进程是否已加载配置（未加载时无法判断"是否需重启"，只能如实说明） */
  runningLoaded: boolean;
  userConfigPath: string;
  policy: {
    allowedPrefixes: readonly string[];
    neverWritable: readonly string[];
  };
  running: unknown;
  onDisk: unknown;
  onDiskError: string | null;
  restartPending: Array<{ path: string; running: unknown; onDisk: unknown }>;
}

/**
 * 运行态覆盖：`routing.*` 是唯一会被进程实时改写的段
 * （`ipc-update-routing` 与首次引导都会 `setRoutingConfig`），启动快照里的值可能已经落后。
 * 不覆盖的话，界面会把"已经生效"的模型选择标成待重启。
 */
function overlayLiveRouting(tree: unknown): unknown {
  const live = getRoutingConfig();
  if (!live) return tree;
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return tree;
  const root = tree as Record<string, unknown>;
  const current = root["routing"];
  if (!current || typeof current !== "object" || Array.isArray(current))
    return tree;
  const merged: Record<string, unknown> = {
    ...(current as Record<string, unknown>),
  };
  for (const [field, value] of Object.entries(live)) merged[field] = value;
  return { ...root, routing: merged };
}

/**
 * 生效态视图（`GET /api/configs/effective` 与 `PUT` 回执共用）。
 */
export function effectiveConfigView(): EffectiveConfigView {
  const running = getRunningConfig();
  const onDiskResult = loadConfig();

  const runningTree = running
    ? overlayLiveRouting(redactSecrets(running.merged))
    : null;
  const onDiskTree = onDiskResult.ok
    ? redactSecrets(onDiskResult.value.merged)
    : null;
  // 没有运行态基线时，"待重启"无从判断——拿空表和 onDisk 全量比会把每个键都报成待重启。
  const restartPending =
    running && onDiskResult.ok
      ? diffFlat(flattenLeaves(runningTree), flattenLeaves(onDiskTree))
      : [];

  return {
    env: running?.env ?? (onDiskResult.ok ? onDiskResult.value.env : null),
    runningLoaded: !!running,
    userConfigPath: getUserConfigPath(),
    policy: getUserConfigPolicy(),
    running: runningTree,
    onDisk: onDiskTree,
    onDiskError: onDiskResult.ok ? null : onDiskResult.error,
    restartPending,
  };
}

// ── 白名单写入 ──────────────────────────────────────────────────────

export interface UserConfigWriteView {
  path: string;
  applied: string[];
  removed: string[];
  rejected: string[];
  invalid: Array<{ path: string; reason: string }>;
  /** 每个被写入/删除的键的生效时机：进程已读到（live）/ 需重启才读到（restart-required） */
  statuses: Array<{
    path: string;
    status: "live" | "restart-required" | "unknown";
  }>;
  restartPendingCount: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 应用一次用户配置变更（写 + 删），并如实回传每个键的生效时机。
 * `PATCH` 语义：`patch` 与 `unset` 可同时给；两者都为空视为调用方错误。
 */
export function applyUserConfigChange(
  body: Record<string, unknown>,
): UserConfigWriteView | { error: string } {
  const rawPatch = body["patch"];
  const rawUnset = body["unset"];

  if (rawPatch !== undefined && !isPlainObject(rawPatch)) {
    return { error: "patch 必须是点路径 → 取值的对象" };
  }
  if (
    rawUnset !== undefined &&
    (!Array.isArray(rawUnset) || rawUnset.some((v) => typeof v !== "string"))
  ) {
    return { error: "unset 必须是点路径字符串数组" };
  }
  const patch = (rawPatch ?? {}) as Record<string, unknown>;
  const unset = (rawUnset ?? []) as string[];
  if (Object.keys(patch).length === 0 && unset.length === 0) {
    return { error: "patch 与 unset 不能同时为空" };
  }

  const writeResult =
    Object.keys(patch).length > 0
      ? writeUserConfig(patch)
      : {
          ok: true as const,
          value: {
            path: getUserConfigPath(),
            applied: [],
            rejected: [],
            invalid: [],
          },
        };
  if (!writeResult.ok) {
    logger.warn("用户配置写入被拒绝", {
      source: "configApi",
      keys: Object.keys(patch),
      error: writeResult.error,
    });
    return { error: writeResult.error };
  }

  const removeResult =
    unset.length > 0
      ? removeUserConfig(unset)
      : {
          ok: true as const,
          value: {
            path: getUserConfigPath(),
            removed: [],
            rejected: [],
            absent: [],
          },
        };
  if (!removeResult.ok) {
    logger.warn("用户配置删除被拒绝", {
      source: "configApi",
      keys: unset,
      error: removeResult.error,
    });
    return { error: removeResult.error };
  }

  const view = effectiveConfigView();
  const touched = [...writeResult.value.applied, ...removeResult.value.removed];
  const statuses = touched.map((path) => {
    const pending = view.restartPending.some((d) => d.path === path);
    return {
      path,
      status:
        view.running === null
          ? ("unknown" as const)
          : pending
            ? ("restart-required" as const)
            : ("live" as const),
    };
  });

  logger.info("用户配置已更新", {
    source: "configApi",
    file: writeResult.value.path,
    applied: writeResult.value.applied,
    removed: removeResult.value.removed,
    rejected: [...writeResult.value.rejected, ...removeResult.value.rejected],
    invalid: writeResult.value.invalid,
    restartRequired: statuses.filter((s) => s.status === "restart-required")
      .length,
  });
  if (
    writeResult.value.rejected.length > 0 ||
    writeResult.value.invalid.length > 0
  ) {
    logger.warn("部分配置项未被接受", {
      source: "configApi",
      rejected: writeResult.value.rejected,
      invalid: writeResult.value.invalid,
      hint: "白名单外的键不会写入用户配置层；请在界面上如实告知用户",
    });
  }

  return {
    path: writeResult.value.path,
    applied: writeResult.value.applied,
    removed: removeResult.value.removed,
    rejected: [...writeResult.value.rejected, ...removeResult.value.rejected],
    invalid: writeResult.value.invalid,
    statuses,
    restartPendingCount: view.restartPending.length,
  };
}

// ── 路由注册 ────────────────────────────────────────────────────────

export function registerConfigRoutes(): void {
  registerRoute("GET", "/api/configs", async () => {
    return json(listConfigs());
  });

  // 具体路径必须**先于** `/api/configs/:name` 注册：路由表按注册顺序取首个匹配。
  registerRoute("GET", "/api/configs/effective", async () => {
    return json(effectiveConfigView());
  });

  registerRoute("GET", "/api/configs/user", async () => {
    return json({ path: getUserConfigPath(), config: readUserConfig() });
  });

  registerRoute("PUT", "/api/configs/user", async (req) => {
    const result = applyUserConfigChange(req.body ?? {});
    if ("error" in result) return apiError(result.error, 400);
    return json(result);
  });

  registerRoute("GET", "/api/configs/:name", async (req) => {
    const name = req.params.name;
    if (!name) return apiError("name is required", 400);
    const config = getConfig(name);
    if (!config) return apiError("Config not found", 404);
    return json(config);
  });
}
