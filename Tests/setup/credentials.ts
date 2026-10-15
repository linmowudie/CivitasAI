/**
 * @module Tests/setup/credentials
 * @description
 * 真实凭据注入（九系统检验方案 §5「真实凭据注入机制」）。
 *
 * 现状问题：仓库**没有 dotenv、没有 setupFiles** —— 于是
 *   `HUAWEI_MAAS_API_KEY` 只能靠人工 `export`，L3（真实模型端到端）与
 *   AG-BEN-REAL 在 CI 里从不成立，而缺凭据的用例又"静默通过"（§2.2 铁律 1）。
 *
 * 本模块在测试进程启动时：
 *  1. 从仓库根的 `.env.local` / `.env` 读取键值（**不引入 dotenv 依赖**，只用 30 行解析）；
 *  2. **已存在的环境变量优先**（CI / 开发者显式 export 的不会被文件覆盖）；
 *  3. 打印一行凭据可用性 —— 让"这次跑有没有真实凭据"在整个套件一开始就可见，
 *     而不是等到几十个用例之后从 NOT-RUN 告警里才看出来；
 *  4. 文件缺失**不失败**（无凭据是合法状态，只是相关用例必须记 NOT-RUN）。
 *
 * `.env.local` / `.env` 已在 `.gitignore` 内（凭据不得入库）。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

/** 受管理的凭据键（新增真实凭据时在此登记，便于统一报告可用性） */
export const MANAGED_CREDENTIALS = ["HUAWEI_MAAS_API_KEY"] as const;

/** 极简 .env 解析：`KEY=VALUE`，支持 `#` 注释、可选引号；不做变量展开 */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function loadEnvFiles(): string[] {
  const loaded: string[] = [];
  // 顺序：先 .env（基线），再 .env.local（本地覆盖）——但**都不覆盖已有环境变量**
  for (const name of [".env", ".env.local"]) {
    const p = resolve(ROOT, name);
    if (!existsSync(p)) continue;
    const pairs = parseEnvFile(readFileSync(p, "utf8"));
    for (const [k, v] of Object.entries(pairs)) {
      if (process.env[k] === undefined || process.env[k] === "")
        process.env[k] = v;
    }
    loaded.push(name);
  }
  return loaded;
}

const loaded = loadEnvFiles();
const available = MANAGED_CREDENTIALS.filter(
  (k) => (process.env[k] ?? "").trim().length > 0,
);
const missing = MANAGED_CREDENTIALS.filter((k) => !available.includes(k));

console.log(
  `[credentials] 注入文件: ${loaded.length ? loaded.join(", ") : "（无 .env/.env.local）"}` +
    ` | 可用: ${available.length ? available.join(", ") : "（无）"}` +
    ` | 缺失: ${missing.length ? missing.join(", ") : "（无）"}`,
);
if (missing.length > 0) {
  console.log(
    `[credentials] 缺 ${missing.join(", ")} → 依赖真实调用的用例将登记为 **NOT-RUN**（§2.2 铁律 1，不计为通过）。` +
      ` 需要时在仓库根建 .env.local 写入 ${missing[0]}=<key>（已在 .gitignore 内）。`,
  );
}
