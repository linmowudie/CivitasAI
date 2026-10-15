/**
 * @module Infra/Config/userConfigWriter
 * @description
 * 用户配置层（`<DATA_ROOT>/Configs/local.json`）的**白名单写入 / 删除**。
 *
 * 为什么需要白名单：`local.json` 是覆盖层里优先级最高的一层（见 `configLoader`），
 * 首启引导与设置面板要能写它，但**不能**让 UI 任意改写启动锁定项（数据库路径、安全策略、
 * 循环硬上限）与治理红线（审批默认拒绝、CRITICAL 法定人数、审计法定留存）。
 *
 * 白名单（点路径前缀）分两类：
 * - **精确项**：`server.httpPort` / `server.host` / `server.allowRemoteAccess` /
 *   `server.corsOrigins` / `system.logLevel`（连接与日志，逐个显式放行；
 *   `server.apiToken` 属控制面凭据，见 `NEVER_WRITABLE`）
 * - **段级项**：`ui.` `routing.` `reasoningSandwich.` `workspace.` `onboarding.`
 *   `loopDefaults.` `stopRules.` `verifier.` `fingerprint.` `goalReanchor.` `context.`
 *   `economy.` `supervision.` `arbitration.` `audit.` `memory.` `eventBus.`
 *   `durable.` `session.` `retention.`（阈值/比例/开关，段内红线键由 `NEVER_WRITABLE` 挡住）
 * - **不在名单内**：`hardLimits.`（循环硬上限）、`security.`、`database.`、`server.apiToken`
 *   ——这些是"改了就能绕过门禁"的项，界面写不到。
 *
 * 写入策略：读现有 `local.json` → 深度合并白名单内的键 → **候选值整体过一遍启动校验器**
 * （`validateAllConfigs`：预算档位次序、上下文配比合计、角色覆盖键集等跨字段硬约束）→ 原子写。
 * **两种拒绝粒度要分开看**：跨字段硬约束不过则整批拒绝（不做"界面写成功、下次启动直接崩"的半提交）；
 * 而白名单外（`rejected`）、单键取值非法、形态与配对不过（`invalid`）都是**逐路径**判定——
 * 同批里合法的键照常 `applied`，被点名的键单独剔除，UI 必须提示、不得静默丢弃。
 *
 * 两条**配对**规则（单看一个键看不出来，故在写前拦）：
 * - 基线里是"对象段"的路径，不接受标量/数组整体覆写（否则一段配置被抹掉，且启动校验按路径
 *   逐键查类型、读到标量便整段跳过 → 表现为"写进去了但那一整块行为失效"）。
 * - `server.host`（非回环）与 `server.allowRemoteAccess=true` 会关掉令牌领取通道，而
 *   `server.apiToken` 界面永不可写——没有可用凭据时拒绝，否则一次保存 = 重启后界面全 401。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Result } from "../types.js";
import { ok, err } from "../types.js";
import { atomicWrite } from "../Fs/atomicWrite.js";
import { ensureDirSafe, getConfigDir } from "../Fs/pathResolver.js";
import { loadConfig } from "./configLoader.js";
import type { LoadedConfig } from "./configLoader.js";
import { validateAllConfigs } from "./configValidator.js";

/** 允许写入的点路径前缀（不带 `.` 结尾者为精确匹配） */
const ALLOWED_PREFIXES = [
  "server.httpPort",
  "server.host",
  "server.allowRemoteAccess",
  "server.corsOrigins",
  "system.logLevel",
  "ui.",
  "routing.",
  "reasoningSandwich.",
  "workspace.",
  "onboarding.",
  "loopDefaults.",
  "stopRules.",
  "verifier.",
  "fingerprint.",
  "goalReanchor.",
  "context.",
  "economy.",
  "supervision.",
  "arbitration.",
  "audit.",
  "memory.",
  "eventBus.",
  "durable.",
  "session.",
  "retention.",
] as const;

/**
 * 红线项：即使在白名单段内也**永不**由界面写入。
 * 与设置面板的 `locked` 标注同源（`Client/src/config/configSchema.ts`），
 * 但服务端这里是权威——前端漏标或被人直接打接口都挡得住。
 */
const NEVER_WRITABLE = [
  "server.apiToken", // 控制面凭据：只能来自配置文件/环境变量
  "supervision.approvalDefaultOnTimeout", // 审批超时=默认拒绝（fail-closed）
  "supervision.criticalApprovalRoles", // CRITICAL 双人法定人数
  "durable.recovery.autoResumeMaxUnknownEffects", // 存在 UNKNOWN 副作用 → 禁自动恢复
  "durable.recovery.requireHumanOnArtifactDrift", // 产物漂移必须转人工
  "durable.effect.writeSynchronous", // 降为 NORMAL/OFF 会丢 journal
  "durable.idempotency.store", // Phase 0–2 强制 sqlite
  "arbitration.snapshotStore", // Phase 0–2 强制 sqlite
  "eventBus.store", // Phase 0–2 强制 in-memory
  "reasoningSandwich.verifyingTier", // 不得降为 economic
  "retention.longTermMemoryPermanent", // 审计要求
  "retention.tokenTransactionsPermanent", // 法定留存
] as const;

export interface UserConfigWriteResult {
  /** 实际写入的文件 */
  path: string;
  /** 已写入的点路径 */
  applied: string[];
  /** 白名单外被拒绝的点路径 */
  rejected: string[];
  /** 校验不通过（类型/取值非法）的点路径与原因 */
  invalid: Array<{ path: string; reason: string }>;
}

/** 界面可写策略（供 `GET /api/configs/effective` 回传，UI 据此如实标注"后端不接受这个键"） */
export interface UserConfigPolicy {
  allowedPrefixes: readonly string[];
  neverWritable: readonly string[];
}

export function getUserConfigPolicy(): UserConfigPolicy {
  return { allowedPrefixes: ALLOWED_PREFIXES, neverWritable: NEVER_WRITABLE };
}

export function getUserConfigPath(): string {
  return join(getConfigDir(), "local.json");
}

/** 点路径是否命中白名单（红线项优先拒绝） */
export function isAllowedConfigPath(path: string): boolean {
  if ((NEVER_WRITABLE as readonly string[]).includes(path)) return false;
  return ALLOWED_PREFIXES.some((prefix) =>
    prefix.endsWith(".")
      ? path.startsWith(prefix) || path === prefix.slice(0, -1)
      : path === prefix,
  );
}

/** 具体取值校验（越具体越安全；未列出的路径只做类型合理性检查） */
function validateValue(path: string, value: unknown): string | null {
  if (path === "server.httpPort") {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 65535
    ) {
      return "必须是 1..65535 的整数";
    }
  }
  if (path === "system.logLevel") {
    if (!["debug", "info", "warn", "error", "fatal"].includes(String(value))) {
      return "必须是 debug/info/warn/error/fatal";
    }
  }
  if (path === "server.host") {
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      /\s/.test(value) ||
      value.includes("/")
    ) {
      return "必须是主机名或 IP 字面量（不能含空白或 /）";
    }
  }
  if (path === "server.allowRemoteAccess") {
    if (typeof value !== "boolean")
      return "必须是 boolean（非回环绑定的显式授权）";
  }
  if (path === "server.corsOrigins") {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
      return "必须是字符串数组";
  }
  if (
    path.startsWith("routing.arbitrationModels") ||
    path.startsWith("routing.fallbackOrder")
  ) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
      return "必须是字符串数组";
  }
  if (path.startsWith("routing.") && path.endsWith("Model")) {
    if (typeof value !== "string") return "必须是字符串（模型全限定名）";
  }
  if (value === undefined) return "值不能是 undefined";
  return null;
}

/** 是否为普通对象（配置段） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 通用取值形态校验（段级放行后新增的键都走这里）。
 * 用户配置层只承载"阈值/开关/枚举/字符串数组"，对象结构由配置文件维护——
 * 否则一个界面控件就能把 `stopRules.budget` 从对象替换成标量，把启动校验整段绕过。
 *
 * `baselineValue` 是**基线配置里同一路径**的既有值。只看待写入值会漏掉一半问题：
 * 标量本身形态合法，但写在"对象段"上等于整段替换（段内其余子键从此消失），
 * 而启动校验器按路径逐键查类型，读到标量便整段跳过——表现为"写进去了、界面显示已生效，
 * 那一整块行为却悄悄失效"（REV-331）。
 */
function validateShape(value: unknown, baselineValue: unknown): string | null {
  const shape = checkValueShape(value);
  if (shape) return shape;
  // 到这里 value 必为标量或标量数组（对象在上面已被拒绝），所以基线是对象段就一定被整体覆写。
  if (isPlainObject(baselineValue)) {
    return (
      `该项是一个配置段（含 ${Object.keys(baselineValue).length} 个子键），只能逐子键写入；` +
      "把标量/数组写在这里会整段替换并丢失段内其余配置"
    );
  }
  return null;
}

function checkValueShape(value: unknown): string | null {
  if (value === undefined) return "值不能是 undefined";
  if (value === null)
    return "值不能是 null（要恢复配置文件里的值请使用「重置」）";
  if (typeof value === "number")
    return Number.isFinite(value) ? null : "必须是有限数值";
  if (typeof value === "string" || typeof value === "boolean") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === null || typeof item === "object")
        return "数组元素必须是标量（字符串/数字/布尔）";
      if (typeof item === "number" && !Number.isFinite(item))
        return "数组内的数值必须是有限数值";
    }
    return null;
  }
  return "该配置层只接受标量或标量数组（对象结构请改配置文件）";
}

/** 按点路径读取（用于删除前的存在性判断与生效态比对） */
export function readPathValue(
  tree: Record<string, unknown>,
  path: string,
): unknown {
  let cursor: unknown = tree;
  for (const key of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor))
      return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** 把扁平的 `{ 'a.b': v }` 写进对象树 */
function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let cursor = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const next = cursor[key];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]!] = value;
}

/** 深度合并（override 覆盖 base） */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key];
    if (
      prev !== null &&
      value !== null &&
      typeof prev === "object" &&
      typeof value === "object" &&
      !Array.isArray(prev) &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(
        prev as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 写用户配置层。
 *
 * @param patch 点路径 → 值（如 `{ 'routing.defaultModel': 'p/m', 'system.logLevel': 'warn' }`）
 */
export function writeUserConfig(
  patch: Record<string, unknown>,
): Result<UserConfigWriteResult> {
  const path = getUserConfigPath();
  const applied: string[] = [];
  const rejected: string[] = [];
  const invalid: Array<{ path: string; reason: string }> = [];

  // 基线（default → {env} → 功能文件 → local）只读一次：形态配对、跨键配对、写前试跑校验
  // 必须看同一份基线，否则校验的是另一个世界。
  const base = loadConfig();
  const baseTree = base.ok ? base.value.merged : null;

  // 1. 过滤 + 单键校验（白名单 → 具体取值 → 形态，并与基线同路径配对）
  const pending: Array<{ key: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!isAllowedConfigPath(key)) {
      rejected.push(key);
      continue;
    }
    const reason =
      validateValue(key, value) ??
      validateShape(
        value,
        baseTree === null ? undefined : readPathValue(baseTree, key),
      );
    if (reason) {
      invalid.push({ path: key, reason });
      continue;
    }
    pending.push({ key, value });
  }

  // 2. 跨键配对：每个值单看都合法，合起来却可能把控制面锁死（REV-330）。
  //    整批合成候选树后逐键判定，被点名的键从本批剔除并如实回传 invalid。
  const accepted: Record<string, unknown> = {};
  const blocked = new Map<string, string>();
  if (baseTree !== null && pending.length > 0) {
    const preview: Record<string, unknown> = {};
    for (const { key, value } of pending) setPath(preview, key, value);
    const candidate = deepMerge(baseTree, preview);
    for (const { key } of pending) {
      const reason = remoteAccessPairingReason(candidate, key);
      if (reason) blocked.set(key, reason);
    }
  }
  for (const { key, value } of pending) {
    const reason = blocked.get(key);
    if (reason) {
      invalid.push({ path: key, reason });
      continue;
    }
    setPath(accepted, key, value);
    applied.push(key);
  }

  if (applied.length === 0) {
    return ok({ path, applied, rejected, invalid });
  }

  // 3. 候选整体校验：合并后的配置必须能通过**启动时同一套**校验器。
  //    跨字段硬约束（预算档位次序、上下文配比合计、角色覆盖键集…）单看一个键看不出来，
  //    只在启动时炸——那等于"界面保存成功，下次启动失败"。写前拦下来。
  const guard = validateCandidate(base, accepted);
  if (guard) return err(guard, "ERROR");

  // 4. 读取现有 local.json（不存在则从空对象开始）
  const dirResult = ensureDirSafe(getConfigDir());
  if (!dirResult.ok) {
    return err(
      `配置目录不可写：${getConfigDir()}（${dirResult.error ?? "未知原因"}）`,
      "ERROR",
    );
  }

  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch (e) {
      return err(
        `现有 local.json 解析失败（请先修好它再写入）：${e instanceof Error ? e.message : String(e)}`,
        "FATAL",
      );
    }
  }

  // 5. 合并 + 原子写
  const merged = deepMerge(current, accepted);
  const writeResult = atomicWrite(path, JSON.stringify(merged, null, 2));
  if (!writeResult.ok) {
    return err(`用户配置写入失败：${writeResult.error}`, "ERROR");
  }

  return ok({ path, applied, rejected, invalid });
}

/**
 * 删除用户覆盖层里的点路径（"重置为默认"的后端半边）。
 *
 * 只删本地覆盖不够：`local.json` 里留着旧值，后端重启后仍读到旧值，
 * 界面却显示默认值 → 两侧不一致。删除后空掉的父对象一并剪掉，保持文件可读。
 */
export interface UserConfigRemoveResult {
  path: string;
  /** 实际从文件中删除的点路径 */
  removed: string[];
  /** 白名单外被拒绝的点路径 */
  rejected: string[];
  /** 文件里本来就没有（无需删除，仍算"与后端一致"） */
  absent: string[];
}

export function removeUserConfig(
  paths: string[],
): Result<UserConfigRemoveResult> {
  const path = getUserConfigPath();
  const removed: string[] = [];
  const rejected: string[] = [];
  const absent: string[] = [];

  const allowed = paths.filter((p) => {
    if (isAllowedConfigPath(p)) return true;
    rejected.push(p);
    return false;
  });

  if (allowed.length === 0) {
    return ok({ path, removed, rejected, absent });
  }
  if (!existsSync(path)) {
    return ok({ path, removed, rejected, absent: allowed });
  }

  let current: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return err("local.json 不是对象，无法按路径删除（请先修好它）", "FATAL");
    }
    current = parsed as Record<string, unknown>;
  } catch (e) {
    return err(
      `local.json 解析失败（请先修好它再删除）：${e instanceof Error ? e.message : String(e)}`,
      "FATAL",
    );
  }

  for (const dotted of allowed) {
    if (readPathValue(current, dotted) === undefined) {
      absent.push(dotted);
      continue;
    }
    deletePath(current, dotted);
    removed.push(dotted);
  }

  if (removed.length === 0) {
    return ok({ path, removed, rejected, absent });
  }

  const writeResult = atomicWrite(path, JSON.stringify(current, null, 2));
  if (!writeResult.ok) {
    return err(`用户配置删除后回写失败：${writeResult.error}`, "ERROR");
  }
  return ok({ path, removed, rejected, absent });
}

// ===== 内部辅助函数 =====

/**
 * 用启动校验器试跑"写入之后"的配置。
 * 返回错误说明；`null` 表示候选配置可安全落盘。
 */
function validateCandidate(
  base: Result<LoadedConfig>,
  accepted: Record<string, unknown>,
): string | null {
  if (!base.ok) {
    return `现有配置无法解析，拒绝写入以免覆盖后更糟：${base.error}`;
  }
  const candidate = deepMerge(base.value.merged, accepted);
  const result = validateAllConfigs({
    default: candidate,
    loopConfig: candidate,
  });
  return result.ok
    ? null
    : `新值未通过配置校验（写入后会在启动时失败）：${result.error}`;
}

/**
 * 非回环绑定的写法（与 `Interface/WebServer/bindPolicy.ts` 的 `LOOPBACK_HOSTS` 同口径；
 * Infra 不能反向依赖 Interface，改动任一侧都要同步另一侧）。
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** `server.apiToken` 的可用下限，与 `configValidator` 对长度的要求同源 */
const MIN_USABLE_TOKEN_LENGTH = 16;

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
}

/**
 * 远程访问配对规则（REV-330）。
 *
 * `server.allowRemoteAccess` 与 `server.host` 都在写白名单里，`server.apiToken` 却属凭据、
 * 界面永不可写；而一旦按非回环地址对外开放，令牌领取通道即关闭
 * （`apiToken.ts` 的 `bootstrapEnabled = !remoteEnabled`）。三者相遇时用户没有任何界面内出路：
 * 保存 → 重启 → `/api/*` 全 401，只能手工编辑配置文件回滚。所以写这两个键时必须成对判定，
 * 且同一批里"host 改非回环 + allowRemoteAccess 改 true"要合起来看。
 */
function remoteAccessPairingReason(
  candidate: Record<string, unknown>,
  key: string,
): string | null {
  if (key !== "server.host" && key !== "server.allowRemoteAccess") return null;
  const server = candidate["server"];
  if (!isPlainObject(server) || server["allowRemoteAccess"] !== true)
    return null;
  const host = typeof server["host"] === "string" ? server["host"].trim() : "";
  if (host === "" || isLoopbackHost(host)) return null;
  const token =
    typeof server["apiToken"] === "string" ? server["apiToken"].trim() : "";
  if (token.length >= MIN_USABLE_TOKEN_LENGTH) return null;
  return (
    `开启远程访问（server.host=${host} + server.allowRemoteAccess=true）会关闭令牌领取通道，` +
    `而当前配置里没有可用凭据（server.apiToken 至少 ${MIN_USABLE_TOKEN_LENGTH} 字符，且只能写在配置文件里）。` +
    "现在保存会在下次重启后把所有 /api/* 变成 401 且无法从界面恢复——请先设置 server.apiToken"
  );
}

/** 删除点路径，并剪掉随之变空的父对象 */
function deletePath(target: Record<string, unknown>, dotted: string): void {
  const keys = dotted.split(".");
  const parents: Array<Record<string, unknown>> = [target];
  let cursor = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = cursor[keys[i]!];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    cursor = next as Record<string, unknown>;
    parents.push(cursor);
  }
  delete cursor[keys[keys.length - 1]!];
  for (let i = parents.length - 1; i >= 1; i--) {
    if (Object.keys(parents[i]!).length > 0) break;
    delete parents[i - 1]![keys[i - 1]!];
  }
}

/** 读取现有用户配置层（不存在返回空对象） */
export function readUserConfig(): Record<string, unknown> {
  const path = getUserConfigPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
